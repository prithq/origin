/**
 * The autonomous build pipeline.
 *
 * Stages, and why each is isolated the way it is:
 *
 *   build  - OpenCode writes files inside a disposable project directory. It
 *            needs the network and a model key, so it runs with a temporary
 *            OpenCode home. The key is passed as an environment variable and
 *            the temporary config contains no credential. The workspace is
 *            mounted writable; the host home, the repository and `data/` are
 *            not mounted at all.
 *
 *   qa     - Executes the generated project's own tests. This is the stage that
 *            runs untrusted code, so it gets NO network, NO credentials and no
 *            access to anything outside the project directory.
 *
 * Separating the two matters: the builder legitimately needs to call a model,
 * while the code it produced must never be able to reach the network or the
 * host. Conflating them would either break the builder or weaken the sandbox.
 *
 * If QA fails, the builder is asked to fix the specific failures, up to
 * MAX_QA_RETRIES. Failures are reported to the QA Agent's SWITCH room as real
 * events.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildStatus, Opportunity, QaCheck, QaReport } from "@origin/contracts";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { recordActivity } from "../lib/activity.js";
import type { SwitchHub } from "../switch/hub.js";
import { listWorkspaceFiles, runInSandbox } from "./sandbox.js";

export interface BuildPipelineInput {
  opportunity: Opportunity;
  hub: SwitchHub;
  /** Called when the builder finishes and QA begins. */
  onTesting: () => Promise<void>;
  /** Called before each fix attempt, with the failures QA found. */
  onRetry: (attempt: number, failures: string[]) => Promise<void>;
}

interface BuildSpec {
  title: string;
  problem: string;
  solution: string;
  users: string[];
  mustFeatures: string[];
}

/**
 * A deliberately narrow, boring contract for generated projects.
 *
 * The builder is told exactly how the project will be tested, so a passing
 * build is a real signal rather than luck. ESM `.mjs` with `node:test` needs no
 * installation step, which keeps the sandbox offline during QA.
 */
const BUILD_CONTRACT = `
Build requirements, which are not negotiable:
- Create a working Node.js application using ES modules and .mjs file extensions.
- Do NOT use TypeScript, React, bundlers, or any framework that needs compilation.
- Do NOT run npm install. The QA sandbox has no network, so dependencies cannot be fetched.
- You may only use Node.js built-in modules (node:fs, node:http, node:test, etc).
- Include a package.json with {"type":"module"} and a "test" script.
- Include at least one test file named *.test.mjs using node:test and node:assert.
- The tests must pass with a plain "node --test" invocation.
- Provide a README.md explaining how to run the app.
- Every file must be created inside the current working directory.
`.trim();

function buildSpec(brief: NonNullable<Opportunity["brief"]>): BuildSpec {
  return {
    title: brief.title,
    problem: brief.problemStatement,
    solution: brief.proposedSolution,
    users: brief.targetUsers,
    mustFeatures: brief.mvpFeatures.filter((f) => f.priority === "must").map((f) => f.title),
  };
}

function builderPrompt(spec: BuildSpec, attempt: number, failures: string[]): string {
  const parts = [
    `Build a minimal but genuinely working MVP for: ${spec.title}`,
    "",
    `Problem it solves: ${spec.problem}`,
    `Proposed solution: ${spec.solution}`,
    `Target users: ${spec.users.join(", ")}`,
    "",
    "Required features for this build:",
    ...spec.mustFeatures.map((f) => `- ${f}`),
    "",
    BUILD_CONTRACT,
  ];

  if (attempt > 0 && failures.length > 0) {
    parts.push(
      "",
      `This is fix attempt ${attempt}. The previous build failed QA with these failures:`,
      ...failures.map((f) => `- ${f.slice(0, 400)}`),
      "",
      "Fix these specific problems. Keep everything that already worked.",
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

function workspacePath(opportunityId: string): string {
  return join(config.workspaceDir, opportunityId);
}

function prepareWorkspace(opportunityId: string): string {
  const dir = workspacePath(opportunityId);
  if (existsSync(dir)) {
    // A rebuild starts from a clean directory. Carrying over a previous
    // attempt's files would make "fixed" indistinguishable from "still there".
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Runs OpenCode inside a sandbox with a throwaway OpenCode home.
 *
 * The provider key is passed through the environment. The temporary config is
 * generated with a `{env:...}` placeholder, so no credential is ever written to
 * disk inside the sandbox.
 */
async function runBuilder(
  workDir: string,
  prompt: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const ocBin = config.OPENCODE_BIN;
  const ocBinDir = ocBin.includes("/") ? ocBin.replace(/\/[^/]+$/, "") : null;

  const sandboxRoot = join(workDir, ".origin");
  const ocConfigDir = join(sandboxRoot, "config");
  const ocDataDir = join(sandboxRoot, "data");
  const ocCacheDir = join(sandboxRoot, "cache");
  mkdirSync(join(ocConfigDir, "opencode"), { recursive: true });
  mkdirSync(ocDataDir, { recursive: true });
  mkdirSync(ocCacheDir, { recursive: true });

  writeFileSync(
    join(ocConfigDir, "opencode", "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: config.OPENCODE_MODEL,
        provider: {
          deeprelay: {
            name: "deeprelay",
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: config.DEEPRELAY_BASE_URL,
              apiKey: "{env:DEEPRELAY_API_KEY}",
            },
            models: {
              [config.DEEPRELAY_MODEL]: { name: config.DEEPRELAY_MODEL },
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const nodeDir = process.execPath.replace(/\/bin\/node$/, "");
  const binds: string[] = [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", "/etc/hosts", "/etc/hosts",
    "--ro-bind", "/etc/ssl", "/etc/ssl",
    "--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
  ];
  if (existsSync("/etc/pki")) binds.push("--ro-bind", "/etc/pki", "/etc/pki");
  if (nodeDir && !nodeDir.startsWith("/usr") && existsSync(nodeDir)) {
    binds.push("--ro-bind", nodeDir, nodeDir);
  }
  if (ocBinDir && existsSync(ocBinDir)) binds.push("--ro-bind", ocBinDir, ocBinDir);

  const args = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    ...binds,
    "--bind", ocConfigDir, ocConfigDir,
    "--bind", ocDataDir, ocDataDir,
    "--bind", ocCacheDir, ocCacheDir,
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", workDir, workDir,
    "--chdir", workDir,
    "--setenv", "HOME", workDir,
    "--setenv", "XDG_CONFIG_HOME", ocConfigDir,
    "--setenv", "XDG_DATA_HOME", ocDataDir,
    "--setenv", "XDG_CACHE_HOME", ocCacheDir,
    "--setenv", "DEEPRELAY_API_KEY", config.DEEPRELAY_API_KEY ?? "",
    // The builder needs the model API; it does not get network access to
    // anything else because it has no credential and no host filesystem.
    "--share-net",
    ocBin,
    "run",
    "--standalone",
    "--auto",
    "--model",
    config.OPENCODE_MODEL,
    prompt,
  ];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("bwrap", args, {
      env: {
        PATH: `${ocBinDir ?? "/usr/bin"}:${nodeDir}/bin:/usr/bin:/bin`,
        HOME: workDir,
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: stdout, error: `Could not start the builder: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          output: stdout,
          error: `Builder timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
        return;
      }
      resolve({
        ok: code === 0,
        output: `${stdout}\n${stderr}`.slice(-6_000),
        ...(code === 0 ? {} : { error: `Builder exited with code ${code}` }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// QA
// ---------------------------------------------------------------------------

function hasTestScript(workDir: string): boolean {
  const pkgPath = join(workDir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.test);
  } catch {
    return false;
  }
}

/**
 * Runs the generated project's tests with no network and no credentials.
 */
async function runQa(workDir: string): Promise<QaReport> {
  const checks: QaCheck[] = [];
  const files = await listWorkspaceFiles(workDir);

  checks.push({
    name: "Project files present",
    status: files.length > 0 ? "passed" : "failed",
    detail: `${files.length} file(s) written`,
  });

  const hasPackage = files.some((f) => f.path === "package.json");
  checks.push({
    name: "package.json present",
    status: hasPackage ? "passed" : "failed",
    detail: hasPackage ? "found" : "missing package.json",
  });

  const hasTests = hasTestScript(workDir);
  checks.push({
    name: "Test script defined",
    status: hasTests ? "passed" : "failed",
    detail: hasTests ? "package.json defines a test script" : "no test script in package.json",
  });

  const hasReadme = files.some((f) => /^readme\.md$/i.test(f.path));
  checks.push({
    name: "README present",
    status: hasReadme ? "passed" : "failed",
    detail: hasReadme ? "found" : "missing README.md",
  });

  if (hasPackage) {
    const result = await runInSandbox({
      workDir,
      command: "node",
      args: ["--test"],
      timeoutMs: config.QA_TIMEOUT_MS,
    });

    const combined = `${result.stdout}\n${result.stderr}`.trim();
    checks.push({
      name: "Test suite",
      status: result.ok ? "passed" : "failed",
      detail: result.sandboxError
        ? result.sandboxError
        : result.timedOut
          ? `timed out after ${Math.round(config.QA_TIMEOUT_MS / 1000)}s`
          : combined.slice(-1_500) || "no output",
    });
  }

  const failures = checks
    .filter((c) => c.status === "failed")
    .map((c) => `${c.name}: ${c.detail}`);

  const passed = failures.length === 0;
  return {
    passed,
    checks,
    failures,
    summary: passed
      ? "All checks passed."
      : `${failures.length} check(s) failed: ${checks
          .filter((c) => c.status === "failed")
          .map((c) => c.name)
          .join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function buildApprovedOpportunity(
  input: BuildPipelineInput,
): Promise<BuildStatus> {
  const { opportunity } = input;
  if (!opportunity.brief) {
    throw new Error("Cannot build an opportunity without an approved brief");
  }

  const brief = opportunity.brief;
  const spec = buildSpec(brief);
  const workDir = prepareWorkspace(opportunity.id);

  const post = async (body: string): Promise<void> => {
    if (!input.hub.isReady) return;
    try {
      await input.hub.postAs("builder", body);
    } catch (err) {
      logger.warn(`Could not post build update to SWITCH: ${(err as Error).message}`);
    }
  };

  await post(
    [
      `Starting the autonomous build for: ${spec.title}`,
      "",
      `Must-have features: ${spec.mustFeatures.join("; ")}`,
      "The generated project runs in an isolated workspace. QA will test it before it is reported ready.",
    ].join("\n"),
  );

  await recordActivity({
    phase: "build",
    summary: `Builder started: ${spec.title}`,
    agentKey: "builder",
    room: "build-studio",
    viaSwitch: input.hub.isReady,
    opportunityId: opportunity.id,
  });

  let attempts = 0;
  let failures: string[] = [];
  let lastQa: QaReport | undefined;
  let lastError: string | undefined;

  while (attempts <= config.MAX_QA_RETRIES) {
    attempts += 1;

    if (attempts > 1) {
      await input.onRetry(attempts - 1, failures);
    }

    const build = await runBuilder(
      workDir,
      builderPrompt(spec, attempts - 1, failures),
      config.BUILD_TIMEOUT_MS,
    );

    if (!build.ok) {
      lastError = build.error ?? "Builder failed";
      logger.warn(`Build attempt ${attempts} failed: ${lastError}`);
      await recordActivity({
        phase: "build",
        summary: `Build attempt ${attempts} failed`,
        agentKey: "builder",
        room: "build-studio",
        level: "error",
        detail: lastError,
        viaSwitch: false,
        opportunityId: opportunity.id,
      });
      // A builder failure is not necessarily a code failure; retrying the same
      // prompt is reasonable once, but repeating it more is not productive.
      if (attempts > config.MAX_QA_RETRIES) {
        return {
          state: "failed",
          workspaceId: opportunity.id,
          files: [],
          attempts,
          error: lastError,
        };
      }
      failures = [lastError];
      continue;
    }

    await input.onTesting();
    const qa = await runQa(workDir);
    lastQa = qa;

    const files = await listWorkspaceFiles(workDir);

    if (qa.passed) {
      await post(
        [
          `Build complete and QA passed for: ${spec.title}`,
          "",
          `${files.length} files written, tests passing.`,
          `${attempts} build attempt(s).`,
        ].join("\n"),
      );
      await recordActivity({
        phase: "qa",
        summary: `QA passed after ${attempts} attempt(s)`,
        agentKey: "qa-agent",
        room: "build-studio",
        level: "success",
        viaSwitch: input.hub.isReady,
        opportunityId: opportunity.id,
      });

      return {
        state: "completed",
        workspaceId: opportunity.id,
        files,
        qa,
        attempts,
        previewPath: `/api/opportunities/${opportunity.id}/preview`,
      };
    }

    failures = qa.failures;
    lastError = qa.summary;

    await post(
      [
        `QA failed on attempt ${attempts} for: ${spec.title}`,
        "",
        "Failures:",
        ...qa.failures.map((f) => `- ${f}`),
        "",
        attempts > config.MAX_QA_RETRIES
          ? "Retry limit reached."
          : "Requesting a fix from the builder.",
      ].join("\n"),
    );
    await recordActivity({
      phase: "qa",
      summary: `QA failed on attempt ${attempts}`,
      agentKey: "qa-agent",
      room: "build-studio",
      level: "warning",
      detail: qa.summary,
      viaSwitch: input.hub.isReady,
      opportunityId: opportunity.id,
    });
  }

  const files = await listWorkspaceFiles(workDir);
  return {
    state: "failed",
    workspaceId: opportunity.id,
    files,
    ...(lastQa ? { qa: lastQa } : {}),
    attempts,
    error:
      lastError ??
      `Build did not pass QA within ${config.MAX_QA_RETRIES} retries`,
  };
}

/** Reads a file from a generated workspace, refusing any path escape. */
export function readWorkspaceFile(opportunityId: string, relativePath: string): string | null {
  const root = workspacePath(opportunityId);
  const resolved = join(root, relativePath);
  if (!resolved.startsWith(root)) return null;
  if (!existsSync(resolved)) return null;
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

export function workspaceExists(opportunityId: string): boolean {
  return existsSync(workspacePath(opportunityId));
}

export { workspacePath };
