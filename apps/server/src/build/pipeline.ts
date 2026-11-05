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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildStatus, Opportunity, QaCheck, QaReport } from "@origin/contracts";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { recordActivity } from "../lib/activity.js";
import type { SwitchHub } from "../switch/hub.js";
import { listWorkspaceFiles, runInSandbox } from "./sandbox.js";
import {
  builderPrompt,
  entryPoint,
  packageJson,
  readme,
  templateVars,
} from "./template.js";

export interface BuildPipelineInput {
  opportunity: Opportunity;
  hub: SwitchHub;
  /** Called when the builder finishes and QA begins. */
  onTesting: () => Promise<void>;
  /** Called before each fix attempt, with the failures QA found. */
  onRetry: (attempt: number, failures: string[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

function workspacePath(opportunityId: string): string {
  return join(config.workspaceDir, opportunityId);
}

/** A short stable identifier for a workspace path, used for runtime state. */
function opportunitySlug(workDir: string): string {
  return workDir.replace(/[^a-zA-Z0-9_-]/g, "_");
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
 * Resolves the OpenCode executable to an absolute path.
 *
 * bwrap executes the command directly, so a bare name like "opencode" is not
 * resolved against PATH inside the sandbox. Resolving here means a
 * misconfiguration fails loudly at the start of a build rather than surfacing
 * as an opaque non-zero exit from the sandbox.
 */
function resolveOpencodeBinary(configured: string): string {
  if (configured.includes("/")) return configured;

  const fromPath = (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => join(dir, configured))
    .find((candidate) => existsSync(candidate));

  if (fromPath) return fromPath;

  throw new Error(
    `Could not find the OpenCode executable "${configured}" on PATH. ` +
      "Set OPENCODE_BIN to an absolute path.",
  );
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
  const ocBin = resolveOpencodeBinary(config.OPENCODE_BIN);
  // The generated module and its test are the contract. Once both exist and are
  // non-trivial, the build has produced everything QA needs, so there is no
  // reason to keep waiting for the agent to finish talking.
  const requiredFiles = [join(workDir, "src", "core.mjs"), join(workDir, "core.test.mjs")];

  const isComplete = (): boolean =>
    requiredFiles.every((path) => {
      try {
        return readFileSync(path, "utf8").trim().length > 40;
      } catch {
        return false;
      }
    });

  const ocBinDir: string = ocBin.replace(/\/[^/]+$/, "");

  // OpenCode's own home lives beside the project, never inside it. Keeping it
  // inside the workspace makes OpenCode explore its own config and session
  // database as if they were project files, which derails the build.
  const sandboxRoot = join(config.workspaceDir, ".origin-runtime", opportunitySlug(workDir));
  const ocConfigDir = join(sandboxRoot, "config");
  const ocDataDir = join(sandboxRoot, "data");
  const ocCacheDir = join(sandboxRoot, "cache");
  mkdirSync(join(ocConfigDir, "opencode"), { recursive: true });
  mkdirSync(ocDataDir, { recursive: true });
  mkdirSync(ocCacheDir, { recursive: true });

  // OpenCode addresses models in two different forms and both must be right:
  //   - the config's `model` and its `models` key use "<provider>/<model>"
  //   - the --model CLI flag prefixes the provider again, so it reads
  //     "deeprelay/deeprelay/<model>"
  // A mismatch in either place produces only "Model unavailable".
  const cfgModel = `deeprelay/${config.DEEPRELAY_MODEL}`;
  const cliModel = config.OPENCODE_MODEL;
  writeFileSync(
    join(ocConfigDir, "opencode", "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: cfgModel,
        provider: {
          deeprelay: {
            name: "deeprelay",
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: config.DEEPRELAY_BASE_URL,
              apiKey: "{env:DEEPRELAY_API_KEY}",
            },
            models: {
              [cfgModel]: {
                name: cfgModel,
                limit: { context: 1_048_576, output: 393_216 },
              },
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
    // The builder needs the model API and nothing else. It is given network
    // access only for that; it has no credential for any other service and no
    // access to the host filesystem.
    "--share-net",
    ocBin,
    "run",
    "--standalone",
    "--auto",
    "--model",
    cliModel,
    prompt,
  ];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let completedEarly = false;
    let settled = false;

    const child = spawn("bwrap", args, {
      env: {
        PATH: `${ocBinDir ?? "/usr/bin"}:${nodeDir}/bin:/usr/bin:/bin`,
        HOME: workDir,
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const settle = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watcher);

      if (completedEarly) {
        // The files QA needs are on disk. A non-zero exit here usually means
        // the agent was still mid-turn when it was stopped, which is not a
        // build failure.
        resolve({ ok: true, output: `${stdout}\n${stderr}`.slice(-6_000) });
        return;
      }

      if (timedOut) {
        resolve({
          ok: false,
          output: `${stdout}\n${stderr}`.slice(-6_000),
          error: `Builder timed out after ${Math.round(timeoutMs / 1000)}s without producing src/core.mjs and core.test.mjs`,
        });
        return;
      }

      resolve({
        ok: code === 0,
        output: `${stdout}\n${stderr}`.slice(-6_000),
        ...(code === 0
          ? {}
          : { error: error ?? `Builder exited with code ${code}` }),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      settle(null);
    }, timeoutMs);

    /**
     * Stop as soon as the required files are complete.
     *
     * A short grace period lets the agent finish writing a file before the
     * process is stopped, so a partially-written file is not mistaken for a
     * finished one.
     */
    let completeSince: number | null = null;
    const watcher = setInterval(() => {
      if (settled || timedOut) return;
      if (!isComplete()) {
        completeSince = null;
        return;
      }
      const now = Date.now();
      if (completeSince === null) {
        completeSince = now;
        return;
      }
      if (now - completeSince >= 1_500) {
        completedEarly = true;
        child.kill("SIGKILL");
        settle(0);
      }
    }, 500);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      settle(null, `Could not start the builder: ${err.message}`);
    });

    child.on("close", (code) => {
      settle(code);
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

  const workspaceDirForBuild = prepareWorkspace(opportunity.id);

  // Write the fixed scaffolding before the agent runs. The agent only supplies
  // the module and its tests, which is what makes the build fast and the QA
  // harness dependable.
  const vars = templateVars(opportunity);
  mkdirSync(join(workspaceDirForBuild, "src"), { recursive: true });
  writeFileSync(join(workspaceDirForBuild, "package.json"), packageJson(vars));
  writeFileSync(join(workspaceDirForBuild, "src", "index.mjs"), entryPoint(vars));
  writeFileSync(join(workspaceDirForBuild, "README.md"), readme(vars));

  const workDir = workspaceDirForBuild;

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
      `Starting the autonomous build for: ${vars.title}`,
      "",
      `Must-have features: ${vars.mustFeatures.join("; ") || "core behaviour from the brief"}`,
      "The generated project runs in an isolated workspace. QA will test it before it is reported ready.",
    ].join("\n"),
  );

  await recordActivity({
    phase: "build",
    summary: `Builder started: ${vars.title}`,
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
      builderPrompt(vars, attempts - 1, failures),
      config.BUILD_TIMEOUT_MS,
    );

    if (!build.ok) {
      lastError = build.error ?? "Builder failed";
      logger.warn(`Build attempt ${attempts} failed: ${lastError}`);
      // Builder output is the only diagnostic for why it stopped; log it so a
      // failure can be diagnosed instead of guessed at.
      if (build.output.trim()) {
        logger.warn(`Builder output (tail):\n${build.output.slice(-2_500)}`);
      }
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
          `Build complete and QA passed for: ${vars.title}`,
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
        `QA failed on attempt ${attempts} for: ${vars.title}`,
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
