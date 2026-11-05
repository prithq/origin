/**
 * LLM provider abstraction.
 *
 * One implementation: DeepRelay's OpenAI-compatible endpoint. The interface
 * exists so a test can substitute a provider, not so a production run can
 * silently swap in generated text.
 *
 * There is deliberately no built-in mock mode. An earlier version had one with
 * no fixtures registered, which meant selecting it produced a guaranteed
 * failure while appearing to be a supported configuration. A mode that looks
 * supported but cannot work is worse than no mode: it invites a demo that
 * quietly shows nothing real.
 *
 * A live failure propagates. Silently degrading to fake output would make
 * fabricated research indistinguishable from retrieved evidence, which is the
 * one thing this product must never do.
 */

import type { z } from "zod";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** JSON Schema-ish hint; DeepRelay supports json_object mode. */
  json?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  /** Stable identifier used by the mock provider to pick a fixture. */
  taskKey?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  model: string;
  durationMs: number;
}

export interface LlmProvider {
  readonly mode: "live" | "mock";
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

// ---------------------------------------------------------------------------
// Live provider
// ---------------------------------------------------------------------------

class DeepRelayProvider implements LlmProvider {
  readonly mode = "live" as const;
  readonly model = config.DEEPRELAY_MODEL;

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const key = config.DEEPRELAY_API_KEY;
    if (!key) throw new LlmError("DEEPRELAY_API_KEY is not configured");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.LLM_TIMEOUT_MS);

    try {
      const res = await fetch(`${config.DEEPRELAY_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens ?? config.LLM_MAX_OUTPUT_TOKENS,
          temperature: request.temperature ?? 0.2,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });

      const raw = await res.text();
      if (!res.ok) {
        throw new LlmError(`DeepRelay returned ${res.status}`, res.status, raw.slice(0, 500));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new LlmError("DeepRelay returned a non-JSON response", res.status, raw.slice(0, 500));
      }

      const body = parsed as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? "";

      // A truncated response is a failed response: the JSON is incomplete and
      // validating it would produce a misleading "schema error".
      if (choice?.finish_reason === "length") {
        throw new LlmError(
          "Model output was truncated at the token limit; increase LLM_MAX_OUTPUT_TOKENS",
        );
      }
      if (!text.trim()) {
        throw new LlmError("Model returned an empty response");
      }

      return {
        text,
        model: this.model,
        durationMs: Date.now() - started,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new LlmError(`DeepRelay request timed out after ${config.LLM_TIMEOUT_MS}ms`);
      }
      throw new LlmError(`DeepRelay request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

let provider: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  provider ??= new DeepRelayProvider();
  return provider;
}

/** Test seam: lets a test install a provider without touching env vars. */
export function setProvider(next: LlmProvider | null): void {
  provider = next;
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/**
 * Extracts a JSON object from a model response.
 *
 * Models occasionally wrap JSON in a fenced block or add a sentence of prose
 * before it. Recovering the object is reasonable; inventing missing fields is
 * not, which is why this returns the parsed value or throws.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to fence extraction */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }

  throw new LlmError("Could not extract a JSON object from the model response");
}

export interface StructuredResult<T> {
  value: T;
  usage: LlmUsage;
  durationMs: number;
  /** True when the first response failed validation and a repair succeeded. */
  repaired: boolean;
}

/**
 * Runs a structured completion and validates it with Zod.
 *
 * One repair attempt is allowed, because models occasionally omit a required
 * key. The repair is a fresh request that includes the validator's complaint;
 * if it fails again the error surfaces. Values are never defaulted silently.
 */
export async function completeStructured<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  request: LlmRequest,
  options: { repair?: boolean } = {},
): Promise<StructuredResult<T>> {
  const llm = getProvider();
  const first = await llm.complete(request);

  const attempt = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      const json = extractJson(text);
      const parsed = schema.safeParse(json);
      if (parsed.success) return { ok: true, value: parsed.data };
      return {
        ok: false,
        error: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  const firstAttempt = attempt(first.text);
  if (firstAttempt.ok) {
    return {
      value: firstAttempt.value,
      usage: first.usage,
      durationMs: first.durationMs,
      repaired: false,
    };
  }

  if (options.repair === false) {
    throw new LlmError(`Structured output failed validation: ${firstAttempt.error}`);
  }

  logger.warn(`Structured output invalid, attempting one repair: ${firstAttempt.error}`);
  const repairRequest: LlmRequest = {
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: first.text.slice(0, 4_000) },
      {
        role: "user",
        content:
          `Your previous response did not validate against the required schema. ` +
          `Problems: ${firstAttempt.error}. ` +
          `Return ONLY a corrected JSON object matching the schema. No prose, no markdown fences.`,
      },
    ],
    ...(request.taskKey ? { taskKey: request.taskKey } : {}),
  };

  const repaired = await llm.complete(repairRequest);
  const secondAttempt = attempt(repaired.text);
  if (!secondAttempt.ok) {
    throw new LlmError(`Structured output failed validation twice: ${secondAttempt.error}`);
  }

  return {
    value: secondAttempt.value,
    usage: {
      promptTokens: first.usage.promptTokens + repaired.usage.promptTokens,
      completionTokens: first.usage.completionTokens + repaired.usage.completionTokens,
    },
    durationMs: first.durationMs + repaired.durationMs,
    repaired: true,
  };
}
