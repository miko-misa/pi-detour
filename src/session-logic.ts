import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Args } from "@earendil-works/pi-coding-agent";

const RESTRICTED_DETOUR_TOOLS = new Set(["edit", "write"]);
const DETOUR_MANAGEMENT_VERBS = new Set([
  "switch",
  "send",
  "merge",
  "close",
  "status",
]);

export function isRestrictedDetourTool(name: string): boolean {
  return RESTRICTED_DETOUR_TOOLS.has(name);
}

export function toggleTarget(
  activeId: string,
  mainId: string,
  detourId: string,
): string {
  return activeId === mainId ? detourId : mainId;
}

export function canDeliverMerge(
  shuttingDown: boolean,
  detourStillActive: boolean,
): boolean {
  return !shuttingDown && detourStillActive;
}

export type DetourCommandDecision =
  | { action: "create"; task: string }
  | { action: "switch" }
  | { action: "send"; message: string }
  | { action: "merge"; instructions: string }
  | { action: "close" }
  | { action: "status" }
  | { action: "usage" }
  | { action: "error"; message: string };

export function parseDetourCommand(
  input: string,
  hasActiveDetour: boolean,
): DetourCommandDecision {
  const text = input.trim();
  if (!text)
    return hasActiveDetour ? { action: "switch" } : { action: "usage" };

  const separator = text.search(/\s/);
  const verb = (separator < 0 ? text : text.slice(0, separator)).toLowerCase();
  const rest = separator < 0 ? "" : text.slice(separator).trim();

  if (!hasActiveDetour) {
    if (verb === "open") {
      return rest
        ? { action: "create", task: rest }
        : { action: "error", message: "Usage: /detour open <task>" };
    }
    if (verb === "status" && !rest) return { action: "status" };
    if (DETOUR_MANAGEMENT_VERBS.has(verb)) {
      return {
        action: "error",
        message: rest
          ? `No active detour; use /detour open <task> for a task starting with "${verb}"`
          : "No active detour",
      };
    }
    return { action: "create", task: text };
  }

  if (verb === "switch" && !rest) return { action: "switch" };
  if (verb === "send") {
    return rest
      ? { action: "send", message: rest }
      : { action: "error", message: "Usage: /detour send <message>" };
  }
  if (verb === "merge") return { action: "merge", instructions: rest };
  if (verb === "close" && !rest) return { action: "close" };
  if (verb === "status" && !rest) return { action: "status" };
  if (verb === "open") {
    return { action: "error", message: "A detour is already active" };
  }
  return {
    action: "error",
    message:
      "Usage: /detour [switch|send <message>|merge [instructions]|close|status]",
  };
}

export function forkLeafForActivity(
  entries: readonly {
    id: string;
    parentId: string | null;
    type: string;
    message?: { role?: unknown };
  }[],
  currentLeaf: string | undefined,
  isIdle: boolean,
): string | undefined {
  if (isIdle) return currentLeaf;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry?.type === "custom_message" ||
      (entry?.type === "message" && entry.message?.role === "user")
    ) {
      return entry.parentId ?? entry.id;
    }
  }
  return currentLeaf;
}

function canonicalSessionFile(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function sameSessionFile(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return Boolean(
    left && right && canonicalSessionFile(left) === canonicalSessionFile(right),
  );
}

export function shouldDisposeDetourOnMainShutdown(
  reason: "quit" | "reload" | "new" | "resume" | "fork",
): boolean {
  return reason === "quit" || reason === "reload";
}

function textOfMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Select only the assistant output belonging to the requested user turn. */
export function assistantTextForUserTurn(
  messages: readonly unknown[],
  boundary: number,
  requestMarker: string,
): string {
  let userIndex = -1;
  for (let index = Math.max(0, boundary); index < messages.length; index++) {
    const message = messages[index] as { role?: unknown } | undefined;
    if (
      message?.role === "user" &&
      textOfMessage(message).includes(requestMarker)
    ) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return "";
  let result = "";
  for (let index = userIndex + 1; index < messages.length; index++) {
    const message = messages[index] as { role?: unknown } | undefined;
    if (message?.role === "user") break;
    if (message?.role === "assistant") {
      const text = textOfMessage(message).trim();
      if (text) result = text;
    }
  }
  return result.replaceAll(requestMarker, "").trim();
}

function resolveSource(value: string, cwd: string): string {
  if (value.startsWith("file://")) return fileURLToPath(value);
  if (/^(?:npm:|git:|github:|https?:|ssh:)/.test(value)) return value;
  return resolve(cwd, value.replace(/^~(?=$|[\\/])/, homedir()));
}

function sources(values: readonly string[] | undefined, cwd: string): string[] {
  return [...new Set((values ?? []).map((value) => resolveSource(value, cwd)))];
}

export interface ChildCliResources {
  extensionFlagValues: Map<string, boolean | string>;
  models?: string[];
  apiKey?: string;
  tuiMode?: "regular" | "fullscreen";
  useTheme?: string;
  resourceLoaderOptions: {
    additionalExtensionPaths: string[];
    additionalSkillPaths: string[];
    additionalPromptTemplatePaths: string[];
    additionalThemePaths: string[];
    noExtensions?: boolean;
    noSkills?: boolean;
    noPromptTemplates?: boolean;
    noThemes?: boolean;
    noContextFiles?: boolean;
    systemPrompt?: string;
    appendSystemPrompt?: string[];
  };
}

export function childCliResources(
  parsed: Args,
  ownExtensionPath: string,
  cwd: string,
): ChildCliResources {
  const extensionPaths = sources(parsed.extensions, cwd).filter(
    (source) => !/^npm:pi-detour(?:@|$)/.test(source),
  );
  const own = resolve(ownExtensionPath);
  if (!extensionPaths.includes(own)) extensionPaths.push(own);
  return {
    extensionFlagValues: new Map(parsed.unknownFlags),
    ...(parsed.models ? { models: [...parsed.models] } : {}),
    ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
    ...(parsed.tuiMode === undefined ? {} : { tuiMode: parsed.tuiMode }),
    ...(parsed.useTheme === undefined ? {} : { useTheme: parsed.useTheme }),
    resourceLoaderOptions: {
      additionalExtensionPaths: extensionPaths,
      additionalSkillPaths: sources(parsed.skills, cwd),
      additionalPromptTemplatePaths: sources(parsed.promptTemplates, cwd),
      additionalThemePaths: sources(parsed.themes, cwd),
      ...(parsed.noExtensions === undefined
        ? {}
        : { noExtensions: parsed.noExtensions }),
      ...(parsed.noSkills === undefined ? {} : { noSkills: parsed.noSkills }),
      ...(parsed.noPromptTemplates === undefined
        ? {}
        : { noPromptTemplates: parsed.noPromptTemplates }),
      ...(parsed.noThemes === undefined ? {} : { noThemes: parsed.noThemes }),
      ...(parsed.noContextFiles === undefined
        ? {}
        : { noContextFiles: parsed.noContextFiles }),
      ...(parsed.systemPrompt === undefined
        ? {}
        : { systemPrompt: parsed.systemPrompt }),
      ...(parsed.appendSystemPrompt === undefined
        ? {}
        : { appendSystemPrompt: [...parsed.appendSystemPrompt] }),
    },
  };
}

export class SessionOwnership {
  private readonly owners = new WeakMap<object, string>();
  claim(manager: object, ownerId: string): void {
    this.owners.set(manager, ownerId);
  }
  owner(manager: object): string | undefined {
    return this.owners.get(manager);
  }
}
