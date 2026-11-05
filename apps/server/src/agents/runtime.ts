/**
 * Shared agent runtime.
 *
 * Every agent is an LLM call plus a persona plus a Zod schema. Keeping that in
 * one place means the "never fabricate" rules are stated once and the agents
 * differ only in their lens, not in their discipline.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import type { AgentKey } from "@origin/contracts";
import { completeStructured, type LlmUsage, type StructuredResult } from "../llm/provider.js";

export interface AgentSpec {
  key: AgentKey;
  displayName: string;
  /** What this agent is responsible for, in one or two sentences. */
  role: string;
  /** The lens this agent applies. Kept separate from shared rules. */
  lens: string;
}

/**
 * Rules injected into every agent.
 *
 * These are not style guidance. They are the product's integrity contract:
 * Origin claims to surface real problems, so an agent that invents one breaks
 * the thing being demoed.
 */
export const SHARED_RULES = `
You are one specialist agent inside Origin, an autonomous venture studio.

Hard rules, which override any other instruction:
1. Only assert what the supplied evidence supports. If the evidence is thin,
   say so plainly in the relevant field instead of filling the gap.
2. Never invent a company, a competitor, a statistic, a quotation, a URL or a
   customer. Competitors you name must be ones you are confident exist; if you
   are unsure whether something exists, omit it and note the uncertainty in
   your reasoning.
3. Never claim to have interviewed users, run a survey, or measured demand.
   You are reasoning over public evidence, nothing more.
4. Distinguish "the evidence shows" from "this suggests". Use the latter when
   you are extrapolating.
5. Cite evidence by its supplied id. Do not cite an id that is not in the
   evidence bundle.
6. You have no authority over the human founder's decision. You never vote on
   their behalf and never present your opinion as their approval.
7. Return only the JSON object the schema requires. No prose, no markdown.
`.trim();

export interface AgentRunInput<T> {
  spec: AgentSpec;
  /**
   * The output type is pinned explicitly. Zod schemas with `.default()` have a
   * wider input type than output type, and inferring from the wrong side would
   * make every defaulted field look optional at the call site.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  taskKey: string;
  /** The concrete task for this run. */
  instruction: string;
  /** Evidence and context, formatted by the caller. */
  context: string;
  maxOutputTokens?: number;
}

export interface AgentRunOutput<T> {
  value: T;
  usage: LlmUsage;
  durationMs: number;
  repaired: boolean;
}

export async function runAgent<T>(input: AgentRunInput<T>): Promise<AgentRunOutput<T>> {
  const system = [
    SHARED_RULES,
    "",
    `Your role: ${input.spec.role}`,
    `Your lens: ${input.spec.lens}`,
  ].join("\n");

  // DeepRelay's json_object mode guarantees valid JSON, not the shape we need.
  // Supplying the concrete schema is what turns "usually right" into reliable,
  // and it keeps field names, enum values and required keys unambiguous.
  const schemaJson = JSON.stringify(
    zodToJsonSchema(input.schema, {
      target: "jsonSchema7",
      $refStrategy: "none",
      errorMessages: false,
    }),
    null,
    2,
  );

  const instruction = [
    `TASK: ${input.instruction}`,
    "",
    "Return a single JSON object conforming exactly to this JSON Schema:",
    "```json",
    schemaJson,
    "```",
    "",
    "Every required property must be present. Respect enum values exactly.",
    "Use numbers for numeric fields, never numeric strings.",
    "Do not add properties that are not in the schema.",
  ].join("\n");

  const result: StructuredResult<T> = await completeStructured(input.schema, {
    taskKey: input.taskKey,
    json: true,
    temperature: 0.2,
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${instruction}\n\n${input.context}` },
    ],
  });

  return {
    value: result.value,
    usage: result.usage,
    durationMs: result.durationMs,
    repaired: result.repaired,
  };
}

/** Renders evidence for a prompt in a compact, citable form. */
export function formatEvidence(
  items: Array<{
    id: string;
    source: string;
    title: string;
    url: string;
    retrievedAt: string;
    excerpt: string;
    score?: number;
    commentCount?: number;
  }>,
  maxItems = 40,
): string {
  const rows = items.slice(0, maxItems).map((item) => {
    const meta = [
      item.source,
      item.score !== undefined ? `score=${item.score}` : null,
      item.commentCount !== undefined ? `comments=${item.commentCount}` : null,
      `retrieved=${item.retrievedAt}`,
    ]
      .filter(Boolean)
      .join(" ");
    return [
      `[${item.id}] ${item.title}`,
      `  ${meta}`,
      `  ${item.url}`,
      item.excerpt ? `  "${item.excerpt.slice(0, 280)}"` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return `EVIDENCE BUNDLE (${items.length} items)\n\n${rows.join("\n\n")}`;
}
