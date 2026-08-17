import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { MAIN_SESSION_ID, NativeSessionHost } from "../src/live-sessions.ts";
import {
  assistantTextForUserTurn,
  canDeliverMerge,
  childCliResources,
  forkLeafForActivity,
  isRestrictedDetourTool,
  parseDetourCommand,
  sameSessionFile,
  SessionOwnership,
  shouldDisposeDetourOnMainShutdown,
  toggleTarget,
} from "../src/session-logic.ts";

describe("detour tool policy", () => {
  it("leaves the main record without an inline Bash fence", () => {
    const host = new NativeSessionHost();
    expect(host.get(MAIN_SESSION_ID)?.kind).toBe("main");
    expect(host.get(MAIN_SESSION_ID)?.bashFence).toBeUndefined();
  });

  it("blocks only the built-in direct-write tools", () => {
    expect(["edit", "write"].every(isRestrictedDetourTool)).toBe(true);
    expect(
      ["bash", "read", "grep", "find", "ls", "custom_readonly"].some(
        isRestrictedDetourTool,
      ),
    ).toBe(false);
  });
});

describe("detour command parsing", () => {
  it("creates from shorthand or explicit open when no detour exists", () => {
    expect(parseDetourCommand("investigate auth", false)).toEqual({
      action: "create",
      task: "investigate auth",
    });
    expect(parseDetourCommand("open investigate auth", false)).toEqual({
      action: "create",
      task: "investigate auth",
    });
    expect(parseDetourCommand("", false)).toEqual({ action: "usage" });
    expect(parseDetourCommand("merge", false)).toEqual({
      action: "error",
      message: "No active detour",
    });
    expect(parseDetourCommand("merge the config", false)).toEqual({
      action: "error",
      message:
        'No active detour; use /detour open <task> for a task starting with "merge"',
    });
  });

  it("dispatches management verbs only when a detour exists", () => {
    expect(parseDetourCommand("", true)).toEqual({ action: "switch" });
    expect(parseDetourCommand("switch", true)).toEqual({ action: "switch" });
    expect(parseDetourCommand("send check this", true)).toEqual({
      action: "send",
      message: "check this",
    });
    expect(parseDetourCommand("send\tcheck this", true)).toEqual({
      action: "send",
      message: "check this",
    });
    expect(parseDetourCommand("merge concise", true)).toEqual({
      action: "merge",
      instructions: "concise",
    });
    expect(parseDetourCommand("close", true)).toEqual({ action: "close" });
    expect(parseDetourCommand("status", true)).toEqual({ action: "status" });
    expect(parseDetourCommand("another task", true).action).toBe("error");
  });
});

describe("lifecycle routing", () => {
  it("toggles focus and lets shutdown win over merge", () => {
    expect(toggleTarget("main", "main", "child")).toBe("child");
    expect(toggleTarget("child", "main", "child")).toBe("main");
    expect(canDeliverMerge(false, true)).toBe(true);
    expect(canDeliverMerge(true, true)).toBe(false);
    expect(canDeliverMerge(false, false)).toBe(false);
    expect(shouldDisposeDetourOnMainShutdown("quit")).toBe(true);
    expect(shouldDisposeDetourOnMainShutdown("reload")).toBe(true);
    expect(shouldDisposeDetourOnMainShutdown("resume")).toBe(false);
    expect(
      sameSessionFile("/tmp/a/../session.jsonl", "/tmp/session.jsonl"),
    ).toBe(true);
  });

  it("forks before an active turn so unresolved tool calls are excluded", () => {
    const branch = [
      {
        type: "message",
        id: "previous",
        parentId: null,
        message: { role: "assistant" },
      },
      {
        type: "message",
        id: "user",
        parentId: "previous",
        message: { role: "user" },
      },
      {
        type: "message",
        id: "tool-call",
        parentId: "user",
        message: { role: "assistant" },
      },
    ];
    expect(forkLeafForActivity(branch, "tool-call", false)).toBe("previous");
    expect(forkLeafForActivity(branch, "tool-call", true)).toBe("tool-call");
    expect(
      forkLeafForActivity(
        [
          {
            type: "message",
            id: "user",
            parentId: null,
            message: { role: "user" },
          },
          {
            type: "message",
            id: "complete",
            parentId: "user",
            message: { role: "assistant" },
          },
          { type: "custom_message", id: "handoff", parentId: "complete" },
          {
            type: "message",
            id: "in-flight",
            parentId: "handoff",
            message: { role: "assistant" },
          },
        ],
        "in-flight",
        false,
      ),
    ).toBe("complete");
    expect(
      forkLeafForActivity(
        [
          {
            type: "message",
            id: "first-user",
            parentId: null,
            message: { role: "user" },
          },
        ],
        "first-user",
        false,
      ),
    ).toBe("first-user");
  });

  it("recognizes symlink aliases of an existing live session file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-detour-session-"));
    try {
      const actual = join(directory, "actual.jsonl");
      const alias = join(directory, "alias.jsonl");
      writeFileSync(actual, "");
      symlinkSync(actual, alias);
      expect(sameSessionFile(actual, alias)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks runtime ownership by SessionManager identity, independent of focus", () => {
    const ownership = new SessionOwnership();
    const mainManager = {};
    const childManager = {};
    ownership.claim(mainManager, "main");
    ownership.claim(childManager, "child");
    expect(ownership.owner(childManager)).toBe("child");
    expect(ownership.owner(mainManager)).toBe("main");
  });
});

describe("handoff selection", () => {
  const prompt = "compose handoff";

  it("selects only assistant output after the requested merge user turn", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "older answer" }] },
      { role: "user", content: [{ type: "text", text: prompt }] },
      { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: `${prompt}\nrequested handoff` }],
      },
    ];
    expect(assistantTextForUserTurn(messages, 1, prompt)).toBe(
      "requested handoff",
    );
  });

  it("finds the marked turn when an input extension prefixes transformed text", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `transformed prefix\n${prompt}\ntransformed suffix`,
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "transformed handoff" }],
      },
    ];
    expect(assistantTextForUserTurn(messages, 0, prompt)).toBe(
      "transformed handoff",
    );
  });

  it("skips preexisting queued turns after the boundary", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "already queued" }] },
      { role: "assistant", content: [{ type: "text", text: "queued answer" }] },
      {
        role: "user",
        content: [{ type: "text", text: `handoff request ${prompt}` }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "marked handoff" }],
      },
    ];
    expect(assistantTextForUserTurn(messages, 0, prompt)).toBe(
      "marked handoff",
    );
  });

  it("never falls back to an older assistant response", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "older answer" }] },
      { role: "user", content: [{ type: "text", text: "different prompt" }] },
    ];
    expect(assistantTextForUserTurn(messages, 1, prompt)).toBe("");
  });

  it("does not consume output after a subsequent user turn", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: prompt }] },
      { role: "user", content: [{ type: "text", text: "later" }] },
      { role: "assistant", content: [{ type: "text", text: "wrong turn" }] },
    ];
    expect(assistantTextForUserTurn(messages, 0, prompt)).toBe("");
  });
});

describe("CLI resource inheritance", () => {
  it("preserves package sources and all Pi CLI resource options", () => {
    const cwd = "/project";
    const own = "/package/src/index.ts";
    const fileSkill = join(cwd, "external-skill");
    const parsed = parseArgs([
      "-e",
      "./local.ts",
      "-e",
      "npm:pi-extra",
      "-e",
      "github:owner/pi-extra",
      "--skill",
      "./skill",
      "--skill",
      pathToFileURL(fileSkill).href,
      "--skill",
      "~/home-skill",
      "--prompt-template",
      "git:github.com/a/prompts",
      "--theme",
      "https://example.com/theme",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      "system.md",
      "--append-system-prompt",
      "append.md",
      "--models",
      "openai-codex/*",
      "--api-key",
      "child-secret",
      "--tui-mode",
      "fullscreen",
      "--use-theme",
      "nord",
      "--plugin-flag=value",
    ]);
    const inherited = childCliResources(parsed, own, cwd);

    expect(inherited.resourceLoaderOptions.additionalExtensionPaths).toEqual([
      join(cwd, "local.ts"),
      "npm:pi-extra",
      "github:owner/pi-extra",
      own,
    ]);
    expect(inherited.resourceLoaderOptions.additionalSkillPaths).toEqual([
      join(cwd, "skill"),
      fileSkill,
      join(homedir(), "home-skill"),
    ]);
    expect(
      inherited.resourceLoaderOptions.additionalPromptTemplatePaths,
    ).toEqual(["git:github.com/a/prompts"]);
    expect(inherited.resourceLoaderOptions.additionalThemePaths).toEqual([
      "https://example.com/theme",
    ]);
    expect(inherited.resourceLoaderOptions).toMatchObject({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "system.md",
      appendSystemPrompt: ["append.md"],
    });
    expect(inherited.models).toEqual(["openai-codex/*"]);
    expect(inherited.apiKey).toBe("child-secret");
    expect(inherited.tuiMode).toBe("fullscreen");
    expect(inherited.useTheme).toBe("nord");
    expect(inherited.extensionFlagValues.get("plugin-flag")).toBe("value");
  });

  it("deduplicates and always includes pi-detour itself", () => {
    const own = "/package/src/index.ts";
    const inherited = childCliResources(
      parseArgs(["-e", own, "-e", own, "-e", "npm:pi-detour@0.2.0"]),
      own,
      "/project",
    );
    expect(inherited.resourceLoaderOptions.additionalExtensionPaths).toEqual([
      own,
    ]);
  });
});
