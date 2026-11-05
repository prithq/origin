/**
 * Sandboxed execution for generated code.
 *
 * Requirement: never execute arbitrary generated code on the host machine.
 *
 * Generated code is produced by an LLM and is therefore untrusted. Every
 * execution goes through bubblewrap, which:
 *   - unshares every namespace (pid, net, ipc, uts, user, cgroup)
 *   - bind-mounts the system read-only, so a build cannot modify the host
 *   - exposes only the project directory, writable, and a private /tmp
 *   - has no network, so generated code cannot exfiltrate or fetch
 *   - dies with its parent and is killed on timeout
 *
 * If bubblewrap is unavailable the runner refuses to execute. Falling back to
 * `sh -c` would defeat the entire requirement, so absence is a hard error.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { logger } from "../lib/logger.js";

export interface SandboxRunOptions {
  /** Absolute path to the project directory that becomes the working dir. */
  workDir: string;
  command: string;
  args: string[];
  timeoutMs: number;
  /** Extra environment variables for the command. Never secrets. */
  env?: Record<string, string>;
}

export interface SandboxResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the sandbox itself could not run the command. */
  sandboxError?: string;
}

const MAX_CAPTURE_BYTES = 200_000;

let bwrapChecked = false;
let bwrapAvailable = false;

export function isSandboxAvailable(): boolean {
  if (bwrapChecked) return bwrapAvailable;
  bwrapChecked = true;
  bwrapAvailable = existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap") || commandExists("bwrap");
  return bwrapAvailable;
}

function commandExists(cmd: string): boolean {
  const path = process.env.PATH ?? "";
  return path.split(":").some((dir) => dir && existsSync(`${dir}/${cmd}`));
}

function truncate(text: string): string {
  if (text.length <= MAX_CAPTURE_BYTES) return text;
  return `${text.slice(0, MAX_CAPTURE_BYTES)}\n...[truncated ${text.length - MAX_CAPTURE_BYTES} bytes]`;
}

/**
 * Builds the bubblewrap argument list.
 *
 * System paths are read-only. Only /usr and the usual library directories are
 * exposed; /home is not mounted at all, so a build cannot read the developer's
 * files, the repository's .env, or the SWITCH agent keys in data/.
 */
function buildBwrapArgs(workDir: string, command: string, args: string[]): string[] {
  const roBinds: Array<[string, string]> = [
    ["/usr", "/usr"],
    ["/bin", "/bin"],
    ["/sbin", "/sbin"],
    ["/lib", "/lib"],
    ["/lib64", "/lib64"],
  ];

  const bwrap: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
  ];

  for (const [source, target] of roBinds) {
    if (existsSync(source)) bwrap.push("--ro-bind", source, target);
  }

  // Node's own installation may live outside /usr (e.g. a version manager), so
  // bind its directory read-only rather than copying the interpreter in.
  const nodeDir = process.execPath.replace(/\/bin\/node$/, "");
  if (nodeDir && !nodeDir.startsWith("/usr") && existsSync(nodeDir)) {
    bwrap.push("--ro-bind", nodeDir, nodeDir);
  }
  // npm/pnpm global bins often live under the home directory.
  const binDir = process.env.PATH?.split(":").find((p) => p.includes(".opencode/bin"));
  if (binDir && existsSync(binDir)) bwrap.push("--ro-bind", binDir, binDir);

  bwrap.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", workDir, workDir,
    "--chdir", workDir,
    "--unsetenv", "SWITCH_REGISTRATION_TOKEN",
    "--unsetenv", "DEEPRELAY_API_KEY",
    "--unsetenv", "HUMAN_OPERATOR_TOKEN",
    "--unsetenv", "GITHUB_TOKEN",
    command,
    ...args,
  );

  return bwrap;
}

export async function runInSandbox(options: SandboxRunOptions): Promise<SandboxResult> {
  if (!isSandboxAvailable()) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      sandboxError:
        "bubblewrap (bwrap) is not installed. Refusing to execute generated code on the host. " +
        "Install bubblewrap or skip the build step.",
    };
  }

  const started = Date.now();
  const args = buildBwrapArgs(options.workDir, options.command, options.args);

  return new Promise<SandboxResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn("bwrap", args, {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: options.workDir,
        NODE_ENV: "test",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const result: SandboxResult = {
        ok: !timedOut && !error && code === 0,
        exitCode: code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs,
        timedOut,
        ...(error ? { sandboxError: error } : {}),
      };
      if (timedOut) {
        logger.warn(`Sandbox command timed out after ${options.timeoutMs}ms`);
      }
      resolve(result);
    };

    child.on("error", (err) => finish(null, `Failed to start bwrap: ${err.message}`));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Lists the files a build produced, relative to the workspace, so the UI can
 * show what the Builder actually wrote without reading anything outside it.
 */
export async function listWorkspaceFiles(
  workDir: string,
  maxFiles = 200,
): Promise<Array<{ path: string; bytes: number }>> {
  const result = await runInSandbox({
    workDir,
    command: "find",
    args: [
      ".",
      "-type",
      "f",
      "-not",
      "-path",
      "./node_modules/*",
      "-not",
      "-path",
      "./.git/*",
      "-printf",
      "%s\t%p\n",
    ],
    timeoutMs: 15_000,
  });

  if (!result.ok) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [size, ...rest] = line.split("\t");
      const path = rest.join("\t").replace(/^\.\//, "");
      return { path, bytes: Number.parseInt(size ?? "0", 10) || 0 };
    })
    .filter((entry) => entry.path.length > 0 && !entry.path.startsWith(".."))
    .slice(0, maxFiles)
    .sort((a, b) => a.path.localeCompare(b.path));
}
