import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertBashFenceRegistrationOrder,
  assertFenceWorkspace,
  bashFenceInlineExtension,
  bashFenceOwnershipGuardInlineExtension,
  createFencedBashOperations,
  linuxFenceArgs,
  macosSandboxProfile,
  prepareBashFence,
  shellQuote,
  type PreparedBashFence,
} from "../src/bash-fence.ts";

describe("Bash fence construction", () => {
  const extension = (path: string, toolNames: string[]) => ({
    path,
    tools: new Map(toolNames.map((name) => [name, { definition: { name } }])),
  });

  it("accepts the fence as the first extension registering Bash", () => {
    expect(() =>
      assertBashFenceRegistrationOrder([
        extension("/project/read-only-tool.ts", ["read_only"]),
        extension("<inline:pi-detour-bash-fence>", ["bash"]),
        extension("<inline:later>", ["bash"]),
      ]),
    ).not.toThrow();
  });

  it("rejects a file extension that registers Bash first", () => {
    expect(() =>
      assertBashFenceRegistrationOrder([
        extension("/project/bash-override.ts", ["bash"]),
        extension("<inline:pi-detour-bash-fence>", ["bash"]),
      ]),
    ).toThrow("found /project/bash-override.ts");
  });

  it("rejects a missing Bash fence registration", () => {
    expect(() =>
      assertBashFenceRegistrationOrder([
        extension("<inline:pi-detour-bash-fence>", ["read"]),
      ]),
    ).toThrow("no Bash registration was found");
  });

  it("quotes arbitrary POSIX shell arguments", () => {
    const value = "spaces ' quotes\n$HOME; echo nope";
    const result = spawnSync(
      "/bin/sh",
      ["-c", `printf %s ${shellQuote(value)}`],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });

  it("protects the workspace and every macOS ancestor", () => {
    const workspace = "/Users/example/work space/project's";
    const profile = macosSandboxProfile(workspace);
    expect(profile).toContain("(version 1)\n(allow default)");
    expect(profile).toContain(
      `(deny file-write* (subpath ${JSON.stringify(workspace)}))`,
    );
    for (const path of [
      workspace,
      dirname(workspace),
      "/Users/example",
      "/Users",
      "/",
    ]) {
      expect(profile).toContain(`(literal ${JSON.stringify(path)})`);
    }
  });

  it("binds root before the read-only workspace and mounts proc last", () => {
    const args = linuxFenceArgs("/workspace", "/custom/bash", [
      "-c",
      "echo ok",
    ]);
    expect(args).toEqual([
      "--die-with-parent",
      "--bind",
      "/",
      "/",
      "--ro-bind",
      "/workspace",
      "/workspace",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--chdir",
      "/workspace",
      "--",
      "/custom/bash",
      "-c",
      "echo ok",
    ]);
    expect(args).not.toContain("--unshare-net");
  });

  it("fails closed on unsupported platforms", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-detour-unsupported-"));
    try {
      expect(() => prepareBashFence(directory, "win32")).toThrow(
        "Bash workspace fence is unsupported on win32",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a bwrap launcher from a user-writable path", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-detour-bwrap-"));
    const previousPath = process.env.PATH;
    try {
      const candidate = join(directory, "bwrap");
      writeFileSync(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.PATH = directory;
      expect(() => prepareBashFence(directory, "linux")).toThrow(
        "user-writable executable or ancestor",
      );
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the prepared canonical runtime cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-detour-cwd-"));
    const workspace = join(root, "workspace");
    const alias = join(root, "alias");
    mkdirSync(workspace);
    symlinkSync(workspace, alias);
    const fence: PreparedBashFence = {
      backend: "bubblewrap",
      workspace: realpathSync.native(workspace),
      executable: "/usr/bin/bwrap",
    };
    try {
      expect(() => assertFenceWorkspace(fence, alias)).not.toThrow();
      expect(() => assertFenceWorkspace(fence, root)).toThrow(
        "Detour runtime cwd changed from prepared workspace",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers one first-inline Bash override without intercepting user_bash", () => {
    const fence: PreparedBashFence = {
      backend: "sandbox-exec",
      workspace: "/workspace",
      executable: "/usr/bin/sandbox-exec",
      profile: "(version 1)\n(allow default)",
    };
    const extension = bashFenceInlineExtension(fence);
    expect(typeof extension).not.toBe("function");
    if (typeof extension === "function")
      throw new Error("expected named inline extension");
    expect(extension.hidden).toBe(true);

    const registered: unknown[] = [];
    const events: string[] = [];
    extension.factory({
      registerTool(tool: unknown) {
        registered.push(tool);
      },
      on(event: string) {
        events.push(event);
      },
    } as any);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ name: "bash", label: "bash" });
    expect(registered[0]).toMatchObject({
      renderCall: expect.any(Function),
      renderResult: expect.any(Function),
    });
    expect(events).toEqual([]);
  });

  it("checks Bash ownership on every agent call after dynamic registration", () => {
    const extension = bashFenceOwnershipGuardInlineExtension();
    expect(typeof extension).not.toBe("function");
    if (typeof extension === "function")
      throw new Error("expected named inline extension");
    expect(extension.hidden).toBe(true);

    let owner = "<inline:pi-detour-bash-fence>";
    let getAllToolsCalls = 0;
    let handler: ((event: { toolName: string }) => unknown) | undefined;
    const registered: unknown[] = [];
    const events: string[] = [];
    extension.factory({
      registerTool(tool: unknown) {
        registered.push(tool);
      },
      getAllTools() {
        getAllToolsCalls += 1;
        return [{ name: "bash", sourceInfo: { path: owner } }];
      },
      on(event: string, candidate: typeof handler) {
        events.push(event);
        handler = candidate;
      },
    } as any);

    expect(registered).toEqual([]);
    expect(events).toEqual(["tool_call"]);
    expect(handler?.({ toolName: "bash" })).toBeUndefined();

    const earlierExtension = {
      registerTool() {
        owner = "/project/earlier-extension.ts";
      },
    };
    earlierExtension.registerTool();
    expect(handler?.({ toolName: "bash" })).toEqual({
      block: true,
      reason: expect.stringContaining(
        "/project/earlier-extension.ts, not <inline:pi-detour-bash-fence>",
      ),
    });
    expect(handler?.({ toolName: "read" })).toBeUndefined();
    expect(getAllToolsCalls).toBe(2);
  });
});

describe("Bash fence process handling", () => {
  it.skipIf(process.platform === "win32")(
    "finishes after post-exit stdio goes idle without dropping active output",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "pi-detour-stdio-"));
      const launcher = join(workspace, "sandbox-exec");
      writeFileSync(launcher, '#!/bin/sh\nshift 2\nexec "$@"\n', {
        mode: 0o755,
      });
      const operations = createFencedBashOperations(
        {
          backend: "sandbox-exec",
          workspace: realpathSync.native(workspace),
          executable: launcher,
          profile: "test-profile",
        },
        "/bin/bash",
      );
      const chunks: Buffer[] = [];
      const started = Date.now();

      try {
        const result = await operations.exec(
          "nohup /bin/bash -c 'printf first; sleep 0.06; printf second; sleep 2' &",
          workspace,
          {
            onData: (chunk) => chunks.push(chunk),
          },
        );
        expect(result.exitCode).toBe(0);
        expect(Buffer.concat(chunks).toString("utf8")).toBe("firstsecond");
        expect(Date.now() - started).toBeLessThan(1_500);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});

describe("Bash fence platform integration", () => {
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "spawns the native fence directly and enforces writes, prefix, startup, timeout, and abort",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pi-detour-fence-"));
      const container = join(root, "container");
      const workspace = join(container, "workspace");
      const descendant = join(workspace, "descendant");
      const outside = join(root, "outside");
      mkdirSync(descendant, { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(workspace, "modify"), "old");
      writeFileSync(join(workspace, "delete"), "keep");
      writeFileSync(join(workspace, "rename"), "keep");
      writeFileSync(join(descendant, "modify"), "old");
      writeFileSync(join(outside, "read"), "outside-read");
      symlinkSync(workspace, join(outside, "into-workspace"));
      symlinkSync(outside, join(workspace, "to-outside"));

      try {
        const fence = prepareBashFence(workspace);
        const operations = createFencedBashOperations(fence);
        const baseEnv = {
          ...process.env,
          DETOUR_TEST_OUTSIDE: outside,
          DETOUR_TEST_CONTAINER: container,
          DETOUR_TEST_HOST_PID: String(process.pid),
          DETOUR_TEST_WORKSPACE: workspace,
        };
        const run = async (
          command: string,
          options: {
            env?: NodeJS.ProcessEnv;
            signal?: AbortSignal;
            timeout?: number;
          } = {},
        ) => {
          const chunks: Buffer[] = [];
          try {
            const result = await operations.exec(command, workspace, {
              onData: (chunk) => chunks.push(chunk),
              env: options.env ?? baseEnv,
              signal: options.signal,
              timeout: options.timeout,
            });
            return {
              exitCode: result.exitCode,
              output: Buffer.concat(chunks).toString("utf8"),
            };
          } catch (error) {
            return {
              exitCode: null,
              output: Buffer.concat(chunks).toString("utf8"),
              error,
            };
          }
        };

        const read = await run('cat "$DETOUR_TEST_OUTSIDE/read"');
        expect(read.exitCode).toBe(0);
        expect(read.output).toBe("outside-read");

        expect(
          (await run('printf outside-write > "$DETOUR_TEST_OUTSIDE/write"'))
            .exitCode,
        ).toBe(0);
        expect(readFileSync(join(outside, "write"), "utf8")).toBe(
          "outside-write",
        );

        expect((await run("touch created")).exitCode).not.toBe(0);
        expect((await run("printf changed > modify")).exitCode).not.toBe(0);
        expect((await run("rm delete")).exitCode).not.toBe(0);
        expect((await run("mv rename renamed")).exitCode).not.toBe(0);
        expect(
          (await run("printf changed > descendant/modify")).exitCode,
        ).not.toBe(0);
        expect(
          (
            await run(
              'printf changed > "$DETOUR_TEST_OUTSIDE/into-workspace/modify"',
            )
          ).exitCode,
        ).not.toBe(0);

        expect(existsSync(join(workspace, "created"))).toBe(false);
        expect(readFileSync(join(workspace, "modify"), "utf8")).toBe("old");
        expect(existsSync(join(workspace, "delete"))).toBe(true);
        expect(existsSync(join(workspace, "rename"))).toBe(true);
        expect(readFileSync(join(descendant, "modify"), "utf8")).toBe("old");

        expect(
          (await run("printf allowed > to-outside/via-symlink")).exitCode,
        ).toBe(0);
        expect(readFileSync(join(outside, "via-symlink"), "utf8")).toBe(
          "allowed",
        );

        const prefixTarget = join(workspace, "prefix-write");
        const extension = bashFenceInlineExtension(fence, {
          commandPrefix: `printf prefix > ${shellQuote(prefixTarget)}`,
        });
        if (typeof extension === "function")
          throw new Error("expected named inline extension");
        let bashTool: any;
        extension.factory({
          registerTool(tool: unknown) {
            bashTool = tool;
          },
        } as any);
        await bashTool.execute("prefix-test", { command: "true" });
        expect(existsSync(prefixTarget)).toBe(false);

        const bashEnvTarget = join(workspace, "bash-env-write");
        const bashEnv = join(outside, "bash-env");
        writeFileSync(
          bashEnv,
          `printf startup > ${shellQuote(bashEnvTarget)}\ntrue\n`,
        );
        expect(
          (await run("true", { env: { ...baseEnv, BASH_ENV: bashEnv } }))
            .exitCode,
        ).toBe(0);
        expect(existsSync(bashEnvTarget)).toBe(false);

        await expect(
          operations.exec("true", workspace, {
            onData: () => undefined,
            timeout: 0,
          }),
        ).rejects.toThrow("Invalid timeout");
        expect((await run("sleep 5", { timeout: 0.05 })).error).toMatchObject({
          message: "timeout:0.05",
        });
        const abort = new AbortController();
        const aborted = run("sleep 5 & wait", { signal: abort.signal });
        setTimeout(() => abort.abort(), 50);
        expect((await aborted).error).toMatchObject({ message: "aborted" });

        if (process.platform === "darwin") {
          expect(
            (
              await run(
                'mv "$DETOUR_TEST_CONTAINER" "$DETOUR_TEST_CONTAINER-moved"',
              )
            ).exitCode,
          ).not.toBe(0);
          expect(existsSync(container)).toBe(true);
        }

        if (process.platform === "linux") {
          expect(
            (await run('test ! -e "/proc/$DETOUR_TEST_HOST_PID/root"'))
              .exitCode,
          ).toBe(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
