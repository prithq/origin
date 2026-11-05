import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
// Walk up to the repository root so the server works from src/ or dist/.
const repoRoot = resolve(here, "../../..");

for (const candidate of [resolve(repoRoot, ".env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),

  LLM_MODE: z.enum(["live", "mock"]).default("live"),
  DEEPRELAY_BASE_URL: z.string().url().default("https://api.deeprelay.ai/v1"),
  DEEPRELAY_API_KEY: z.string().optional(),
  DEEPRELAY_MODEL: z.string().default("deepseek-v4.1-flash"),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(12_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  SWITCH_MODE: z.enum(["live", "offline"]).default("live"),
  SWITCH_BRIDGE_URL: z.string().url().default("http://127.0.0.1:43059"),
  SWITCH_REGISTRATION_TOKEN: z.string().optional(),
  SWITCH_REUSE_AGENTS: booleanish.default("true"),
  SWITCH_MATTERMOST_BRIDGE_ID: z.string().optional(),

  HUMAN_OPERATOR_TOKEN: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  DISCOVERY_HN_MAX_STORIES: z.coerce.number().int().positive().default(60),
  DISCOVERY_GITHUB_MAX_ISSUES: z.coerce.number().int().positive().default(40),

  OPENCODE_BIN: z.string().default("opencode"),
  OPENCODE_MODEL: z.string().default("deeprelay/deeprelay/deepseek-v4.1-flash"),
  BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  QA_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MAX_QA_RETRIES: z.coerce.number().int().nonnegative().default(2),

  DATA_DIR: z.string().default("./data"),
  WORKSPACE_DIR: z.string().default("./workspace"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Report which keys failed, never their values.
  const keys = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
  throw new Error(`Invalid environment configuration for: ${[...new Set(keys)].join(", ")}`);
}

export const config = {
  ...parsed.data,
  repoRoot,
  dataDir: resolve(repoRoot, parsed.data.DATA_DIR),
  workspaceDir: resolve(repoRoot, parsed.data.WORKSPACE_DIR),
};

export type Config = typeof config;

export const isLiveLlm = config.LLM_MODE === "live";
export const isLiveSwitch = config.SWITCH_MODE === "live";

/**
 * Fails fast on configuration that a live run cannot proceed without, so the
 * app reports a real misconfiguration instead of silently degrading.
 */
export function assertLiveRequirements(): string[] {
  const problems: string[] = [];
  if (isLiveLlm && !config.DEEPRELAY_API_KEY) {
    problems.push("DEEPRELAY_API_KEY is required when LLM_MODE=live");
  }
  if (isLiveSwitch && !config.SWITCH_REGISTRATION_TOKEN) {
    problems.push("SWITCH_REGISTRATION_TOKEN is required when SWITCH_MODE=live");
  }
  return problems;
}
