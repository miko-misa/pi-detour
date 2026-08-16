import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getNativeSessionHost,
  MAIN_SESSION_ID,
  type LiveSessionRecord,
} from "./live-sessions.ts";
import {
  assistantTextForUserTurn,
  blockedDetourBashResult,
  canDeliverMerge,
  forkLeafForActivity,
  isRestrictedDetourTool,
  parseDetourCommand,
  shouldDisposeDetourOnMainShutdown,
  toggleTarget,
} from "./session-logic.ts";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
  try {
    ctx.ui.notify(errorText(error), "error");
  } catch {
    /* session was disposed */
  }
}

function showRole(
  ctx: ExtensionContext,
  role: "MAIN" | "DETOUR",
  detail?: string,
): void {
  const label = `[${role}]${detail ? ` · ${detail}` : ""}`;
  ctx.ui.setStatus("pi-detour", label);
  ctx.ui.setWidget("pi-detour-mode", [label], { placement: "belowEditor" });
}

async function sendToDetour(
  record: LiveSessionRecord,
  text: string,
): Promise<void> {
  const message = text.trim();
  if (!message) throw new Error("Message is required");
  if (record.merging) throw new Error("Detour is merging");
  if (!record.runtime) throw new Error("Detour runtime is not ready");
  await record.runtime.session.sendUserMessage(message, {
    deliverAs: "followUp",
  });
}

export default function detourExtension(pi: ExtensionAPI): void {
  const host = getNativeSessionHost();
  let contextualCommandsRegistered = false;

  async function start(
    task: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("pi-detour requires interactive TUI mode", "error");
      return;
    }
    if (host.activeId !== MAIN_SESSION_ID) {
      ctx.ui.notify("Return to main before creating a detour", "error");
      return;
    }
    try {
      const forkLeaf = forkLeafForActivity(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getLeafId() ?? undefined,
        ctx.isIdle(),
      );
      const detour = await host.createDetour(ctx, task, forkLeaf);
      showRole(ctx, "MAIN", `detour: ${detour.name}`);
      await host.activateFrom(ctx, detour.id);
    } catch (error) {
      notifyError(ctx, error);
    }
  }

  async function send(
    message: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    try {
      const detour = host.detour();
      if (!detour) throw new Error("No active detour");
      await sendToDetour(detour, message);
    } catch (error) {
      notifyError(ctx, error);
    }
  }

  async function merge(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const detour = host.detour();
    if (!detour) {
      ctx.ui.notify("No active detour", "error");
      return;
    }
    if (detour.merging) {
      ctx.ui.notify("Detour merge is already in progress", "warning");
      return;
    }
    detour.merging = true;
    try {
      const instructions = args.trim();
      const requestMarker = `<!-- pi-detour-merge:${randomUUID()} -->`;
      const prompt = [
        requestMarker,
        "Compose the final handoff to the main session.",
        "Return only the handoff: task, findings, decisions, relevant files, validation, risks, and recommended next action.",
        instructions ? `Additional instructions: ${instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (!detour.runtime) throw new Error("Detour runtime is not ready");
      const boundary = detour.runtime.session.messages.length;
      await detour.runtime.session.sendUserMessage(prompt, {
        deliverAs: "followUp",
      });
      await detour.runtime.session.waitForIdle();
      if (!canDeliverMerge(host.shuttingDown, host.detour() === detour)) {
        detour.merging = false;
        return;
      }
      const handoff = assistantTextForUserTurn(
        detour.runtime.session.messages,
        boundary,
        requestMarker,
      );
      if (!handoff) throw new Error("Detour produced no handoff");

      const main = host.get(MAIN_SESSION_ID);
      if (!main?.api) throw new Error("Main session is unavailable");
      if (host.activeId === detour.id) await host.activate(MAIN_SESSION_ID);
      if (host.shuttingDown) {
        detour.merging = false;
        return;
      }
      main.api.sendMessage(
        {
          customType: "detour-merge",
          content: handoff,
          display: true,
          details: { detour: detour.name },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      await host.stopDetour();
    } catch (error) {
      detour.merging = false;
      notifyError(ctx, error);
    }
  }

  async function returnMain(ctx: ExtensionCommandContext): Promise<void> {
    if (host.activeId === MAIN_SESSION_ID) {
      ctx.ui.notify("Already in main", "info");
      return;
    }
    try {
      await host.activate(MAIN_SESSION_ID);
    } catch (error) {
      notifyError(ctx, error);
    }
  }

  async function close(ctx: ExtensionCommandContext): Promise<void> {
    const detour = host.detour();
    if (!detour) {
      ctx.ui.notify("No active detour", "info");
      return;
    }
    if (detour.merging) {
      ctx.ui.notify("Detour merge is in progress", "warning");
      return;
    }
    await host.stopDetour();
  }

  function status(ctx: ExtensionCommandContext): void {
    const detour = host.detour();
    if (!detour) {
      ctx.ui.notify("No active detour", "info");
      return;
    }
    const focused = host.activeId === detour.id ? "; focused" : "";
    ctx.ui.notify(
      `${detour.name}: ${detour.activity}; ${detour.state}${focused}`,
      "info",
    );
  }

  async function switchSession(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("pi-detour requires interactive TUI mode", "error");
      return;
    }
    const detour = host.detour();
    if (!detour) {
      ctx.ui.notify("No active detour", "info");
      return;
    }
    if (!detour.adapter) {
      ctx.ui.notify("Detour is still starting", "info");
      return;
    }
    try {
      await host.activateFrom(
        ctx,
        toggleTarget(host.activeId, MAIN_SESSION_ID, detour.id),
      );
    } catch (error) {
      notifyError(ctx, error);
    }
  }

  const command = (
    name: string,
    description: string,
    handler: (
      args: string,
      ctx: ExtensionCommandContext,
    ) => Promise<void> | void,
  ) =>
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => handler(args, ctx),
    });

  async function runDetourCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const decision = parseDetourCommand(args, Boolean(host.detour()));
    switch (decision.action) {
      case "create":
        await start(decision.task, ctx);
        return;
      case "switch":
        await switchSession(ctx);
        return;
      case "send":
        await send(decision.message, ctx);
        return;
      case "merge":
        await merge(decision.instructions, ctx);
        return;
      case "close":
        await close(ctx);
        return;
      case "status":
        status(ctx);
        return;
      case "usage":
        ctx.ui.notify(
          "No active detour. Usage: /detour <task> | /detour open <task>",
          "info",
        );
        return;
      case "error":
        ctx.ui.notify(decision.message, "error");
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  }

  function registerContextualDetourCommands(): void {
    if (contextualCommandsRegistered) return;
    contextualCommandsRegistered = true;
    command("merge", "Merge this detour into main", merge);
    command("close", "Close this detour without merging", (_args, ctx) =>
      close(ctx),
    );
    command(
      "main",
      "Return to main without closing this detour",
      (_args, ctx) => returnMain(ctx),
    );
  }

  command(
    "detour",
    "Open, switch, manage, or inspect a live detour",
    runDetourCommand,
  );

  pi.on("session_start", (_event, ctx) => {
    const record = host.bind(pi, ctx);
    if (record.kind === "main") {
      host.reviveMain();
      const detour = host.detour();
      showRole(ctx, "MAIN", detour ? `detour: ${detour.name}` : undefined);
    }
    if (record.kind === "detour") {
      const name = `detour: ${record.name}`;
      showRole(ctx, "DETOUR", record.name);
      if (pi.getSessionName() !== name) pi.setSessionName(name);
      registerContextualDetourCommands();
    }
  });
  pi.on("agent_start", (_event, ctx) => host.activityFor(pi, ctx, "working"));
  pi.on("agent_settled", (_event, ctx) => host.activityFor(pi, ctx, "idle"));

  pi.on("session_before_switch", (event, ctx) => {
    const record = host.bind(pi, ctx);
    if (host.blocksLiveSessionSwitch(record, event.targetSessionFile)) {
      ctx.ui.notify(
        "Cannot resume the other live pi-detour session",
        "warning",
      );
      return { cancel: true };
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const record = host.bind(pi, ctx);
    if (record.kind === "detour" && isRestrictedDetourTool(event.toolName)) {
      return {
        block: true,
        reason: `pi-detour blocks ${event.toolName} in detour sessions; merge recommendations back to main`,
      };
    }
  });

  pi.on("user_bash", (_event, ctx) => {
    const record = host.bind(pi, ctx);
    if (record.kind === "detour") {
      return { result: blockedDetourBashResult() };
    }
  });

  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    const record = host.bind(pi, ctx);
    if (record.kind !== "main") return;
    if (shouldDisposeDetourOnMainShutdown(event.reason)) await host.shutdown();
    else host.detachMain();
  });
}
