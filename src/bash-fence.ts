import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  createBashTool,
  createBashToolDefinition,
  getShellConfig,
  type BashOperations,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_TIMEOUT_MS = 2_147_483_647;
const EXIT_STDIO_GRACE_MS = 500;
const BASH_FENCE_EXTENSION_PATH = "<inline:pi-detour-bash-fence>";

export interface PreparedBashFence {
  backend: "sandbox-exec" | "bubblewrap";
  workspace: string;
  executable: string;
  profile?: string;
}

export interface BashFenceToolOptions {
  commandPrefix?: string;
  shellPath?: string;
}

function workspaceAncestors(workspace: string): string[] {
  const paths = [workspace];
  let path = workspace;
  while (true) {
    const parent = dirname(path);
    if (parent === path) break;
    paths.push(parent);
    path = parent;
  }
  return paths;
}

export function macosSandboxProfile(workspace: string): string {
  const literals = workspaceAncestors(workspace)
    .map((path) => `(literal ${JSON.stringify(path)})`)
    .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${JSON.stringify(workspace)}))`,
    `(deny file-write-unlink file-write-create ${literals})`,
  ].join("\n");
}

export function linuxFenceArgs(
  workspace: string,
  shell: string,
  shellArgs: readonly string[],
): string[] {
  return [
    "--die-with-parent",
    "--bind",
    "/",
    "/",
    "--ro-bind",
    workspace,
    workspace,
    "--unshare-pid",
    "--proc",
    "/proc",
    "--chdir",
    workspace,
    "--",
    shell,
    ...shellArgs,
  ];
}

function isUserWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function hasWritablePathComponent(executable: string): boolean {
  let path = executable;
  while (true) {
    if (isUserWritable(path)) return true;
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
}

function resolveBwrap(): string {
  let unsafeCandidate: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "bwrap");
    try {
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync.native(candidate);
      if (hasWritablePathComponent(canonical)) {
        unsafeCandidate ??= canonical;
        continue;
      }
      return canonical;
    } catch {
      /* keep searching */
    }
  }
  if (unsafeCandidate) {
    throw new Error(
      `Cannot create detour: refusing bubblewrap launcher with a user-writable executable or ancestor: ${unsafeCandidate}`,
    );
  }
  throw new Error(
    "Cannot create detour: bubblewrap (bwrap) is required on Linux; install it and ensure it is executable on PATH",
  );
}

function launcherEnvironment(env: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  restore: string;
} {
  const sanitized = { ...env };
  const restore: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("LD_") && !key.startsWith("DYLD_")) continue;
    delete sanitized[key];
    if (value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      restore.push(`export ${key}=${shellQuote(value)}`);
  }
  return { env: sanitized, restore: restore.join("\n") };
}

function checkPreflight(
  backend: string,
  executable: string,
  args: string[],
  workspace: string,
  help: string,
): void {
  const result = spawnSync(executable, args, {
    cwd: workspace,
    encoding: "utf8",
    env: launcherEnvironment(process.env).env,
    timeout: 10_000,
  });
  if (!result.error && result.status === 0) return;
  const detail =
    result.error?.message ??
    result.stderr?.trim() ??
    (result.signal
      ? `terminated by ${result.signal}`
      : `exited with status ${String(result.status)}`);
  throw new Error(
    `Cannot create detour: ${backend} Bash fence preflight failed: ${detail}. ${help}`,
  );
}

export function prepareBashFence(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): PreparedBashFence {
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = realpathSync.native(workspace);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot create detour: workspace cannot be resolved: ${detail}`,
    );
  }

  if (platform === "darwin") {
    try {
      accessSync(SANDBOX_EXEC, constants.X_OK);
    } catch {
      throw new Error(
        `Cannot create detour: macOS Bash fence requires executable ${SANDBOX_EXEC}`,
      );
    }
    const profile = macosSandboxProfile(canonicalWorkspace);
    checkPreflight(
      "macOS sandbox-exec",
      SANDBOX_EXEC,
      ["-p", profile, "/bin/sh", "-c", "true"],
      canonicalWorkspace,
      `Ensure ${SANDBOX_EXEC} is available and usable`,
    );
    return {
      backend: "sandbox-exec",
      workspace: canonicalWorkspace,
      executable: SANDBOX_EXEC,
      profile,
    };
  }

  if (platform === "linux") {
    const bwrap = resolveBwrap();
    checkPreflight(
      "bubblewrap",
      bwrap,
      linuxFenceArgs(canonicalWorkspace, "/bin/sh", ["-c", "true"]),
      canonicalWorkspace,
      "Ensure unprivileged user namespaces are enabled and bubblewrap may create mounts",
    );
    return {
      backend: "bubblewrap",
      workspace: canonicalWorkspace,
      executable: bwrap,
    };
  }

  throw new Error(
    `Cannot create detour: Bash workspace fence is unsupported on ${platform}`,
  );
}

export function assertFenceWorkspace(
  fence: PreparedBashFence,
  cwd: string,
): void {
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync.native(cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Detour runtime cwd cannot be resolved: ${detail}`);
  }
  if (canonicalCwd !== fence.workspace) {
    throw new Error(
      `Detour runtime cwd changed from prepared workspace ${fence.workspace} to ${canonicalCwd}`,
    );
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function timeoutMilliseconds(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("Invalid timeout: must be a finite number of seconds");
  const milliseconds = timeout * 1000;
  if (milliseconds > MAX_TIMEOUT_MS)
    throw new Error(
      `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`,
    );
  return milliseconds;
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* process already exited */
    }
  }
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalize = () => {
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalize();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalize();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalize();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => finalize(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function createFencedBashOperations(
  fence: PreparedBashFence,
  shellPath?: string,
): BashOperations {
  const shell = getShellConfig(shellPath);
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      assertFenceWorkspace(fence, cwd);
      const timeoutMs = timeoutMilliseconds(timeout);
      if (signal?.aborted) throw new Error("aborted");

      const launcherEnv = launcherEnvironment(env ?? process.env);
      const innerCommand = launcherEnv.restore
        ? `${launcherEnv.restore}\n${command}`
        : command;
      const commandFromStdin = shell.commandTransport === "stdin";
      const shellArgs = commandFromStdin
        ? shell.args
        : [...shell.args, innerCommand];
      const args =
        fence.backend === "sandbox-exec"
          ? ["-p", fence.profile ?? "", shell.shell, ...shellArgs]
          : linuxFenceArgs(fence.workspace, shell.shell, shellArgs);

      return new Promise((resolve, reject) => {
        const child = spawn(fence.executable, args, {
          cwd: fence.workspace,
          detached: true,
          env: launcherEnv.env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        if (commandFromStdin) {
          child.stdin?.on("error", () => undefined);
          child.stdin?.end(innerCommand);
        }

        let timedOut = false;
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          child.stdout?.removeListener("data", onData);
          child.stderr?.removeListener("data", onData);
        };
        const finish = (error?: Error, exitCode?: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve({ exitCode: exitCode ?? null });
        };
        const onAbort = () => killProcessGroup(child);

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        void waitForChildProcess(child).then(
          (code) => {
            if (signal?.aborted) finish(new Error("aborted"));
            else if (timedOut) finish(new Error(`timeout:${timeout}`));
            else finish(undefined, code);
          },
          (error: Error) => finish(error),
        );

        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
          }, timeoutMs);
        }
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  };
}

export function assertBashFenceRegistrationOrder(
  extensions: readonly {
    path: string;
    tools: { values(): Iterable<{ definition: { name: string } }> };
  }[],
): void {
  const first = extensions.find((extension) =>
    [...extension.tools.values()].some(
      (tool) => tool.definition.name === "bash",
    ),
  );
  if (first?.path === BASH_FENCE_EXTENSION_PATH) return;

  const found = first
    ? `found ${first.path}`
    : "no Bash registration was found";
  throw new Error(
    `Cannot create detour: expected ${BASH_FENCE_EXTENSION_PATH} to be the first extension registering bash, but ${found}. Disable the conflicting file extension or restore the detour Bash fence.`,
  );
}

export function bashFenceOwnershipGuardInlineExtension(): InlineExtension {
  return {
    name: "pi-detour-bash-fence-ownership-guard",
    hidden: true,
    factory(pi: ExtensionAPI) {
      pi.on("tool_call", (event) => {
        if (event.toolName !== "bash") return;
        const owner = pi.getAllTools().find((tool) => tool.name === "bash")
          ?.sourceInfo.path;
        if (owner === BASH_FENCE_EXTENSION_PATH) return;
        return {
          block: true,
          reason: `pi-detour blocked bash because its current owner is ${owner ?? "missing"}, not ${BASH_FENCE_EXTENSION_PATH}. Disable the extension replacing bash or restart the detour.`,
        };
      });
    },
  };
}

export function bashFenceInlineExtension(
  fence: PreparedBashFence,
  options: BashFenceToolOptions = {},
): InlineExtension {
  return {
    name: "pi-detour-bash-fence",
    hidden: true,
    factory(pi: ExtensionAPI) {
      const toolOptions = {
        commandPrefix: options.commandPrefix,
        shellPath: options.shellPath,
        operations: createFencedBashOperations(fence, options.shellPath),
      };
      const definition = createBashToolDefinition(fence.workspace, toolOptions);
      const bash = createBashTool(fence.workspace, toolOptions);
      pi.registerTool({ ...definition, ...bash });
    },
  };
}
