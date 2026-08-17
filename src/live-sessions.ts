import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  getPackageDir,
  hasTrustRequiringProjectResources,
  InteractiveMode,
  parseArgs,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  assertBashFenceRegistrationOrder,
  assertFenceWorkspace,
  bashFenceInlineExtension,
  bashFenceOwnershipGuardInlineExtension,
  prepareBashFence,
  type PreparedBashFence,
} from "./bash-fence.ts";
import {
  childCliResources,
  sameSessionFile,
  SessionOwnership,
} from "./session-logic.ts";

export const MAIN_SESSION_ID = "__pi_detour_main__";
const HOST_KEY = Symbol.for("pi-detour.native-session-host");
const OWN_EXTENSION_PATH = fileURLToPath(
  new URL("./index.ts", import.meta.url),
);
const CLI_RESOURCES = childCliResources(
  parseArgs(process.argv.slice(2)),
  OWN_EXTENSION_PATH,
  process.cwd(),
);
let builtInExtensionsPromise: Promise<InlineExtension[]> | undefined;

function loadBuiltInExtensions(): Promise<InlineExtension[]> {
  builtInExtensionsPromise ??= import(
    pathToFileURL(join(getPackageDir(), "dist/extensions/index.js")).href
  ).then(
    (module: { builtInExtensions?: InlineExtension[] }) =>
      module.builtInExtensions ?? [],
  );
  return builtInExtensionsPromise;
}

type Activity = "idle" | "working";
type RecordState = "starting" | "active" | "suspended" | "stopped" | "error";
type RuntimeInheritance = {
  sourceCwd?: string;
  projectTrusted?: boolean;
  sessionOptions?: {
    tools?: string[];
    model?: unknown;
    thinkingLevel?: string;
  };
};

export interface LiveSessionRecord {
  id: string;
  kind: "main" | "detour";
  name: string;
  cwd: string;
  state: RecordState;
  activity: Activity;
  sessionId?: string;
  sessionFile?: string;
  createdAt: number;
  runtime?: any;
  mode?: any;
  adapter?: InteractiveModeAdapter;
  api?: ExtensionAPI;
  context?: ExtensionContext;
  inheritance?: RuntimeInheritance;
  started?: boolean;
  expectedStop?: boolean;
  merging?: boolean;
  error?: string;
  runPromise?: Promise<void>;
  bashFence?: PreparedBashFence;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferThinkingLevel(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: string; thinkingLevel?: string };
    if (entry.type === "thinking_level_change" && entry.thinkingLevel)
      return entry.thinkingLevel;
  }
  return undefined;
}

function collectInheritance(ctx: ExtensionCommandContext): RuntimeInheritance {
  const prompt = ctx.getSystemPromptOptions();
  const tools = Array.isArray(prompt.selectedTools)
    ? [...prompt.selectedTools]
    : undefined;
  const thinkingLevel = inferThinkingLevel(ctx);
  return {
    sourceCwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    sessionOptions: {
      ...(tools ? { tools } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
  };
}

function resetKeyboardModes(): void {
  try {
    process.stdout.write("\x1b[<999u\x1b[>4;0m");
  } catch {
    /* terminal already closed */
  }
}

/** Derived from pi-parallel-sessions 0.2.8 (MIT). */
class InteractiveModeAdapter {
  state: "never-started" | "active" | "suspended" | "stopped" = "never-started";
  private terminalGateInstalled = false;

  constructor(
    readonly id: string,
    readonly runtime: any,
    readonly mode: any,
    private readonly host: NativeSessionHost,
  ) {}

  private get ui(): any {
    return this.mode.ui;
  }

  private installTerminalGate(): void {
    if (this.terminalGateInstalled) return;
    const terminal = this.ui?.terminal;
    if (!terminal) return;
    this.terminalGateInstalled = true;
    const startUi = this.ui.start?.bind(this.ui);
    const setProgress = terminal.setProgress?.bind(terminal);
    const setTitle = terminal.setTitle?.bind(terminal);
    if (startUi)
      this.ui.start = (...args: unknown[]) => {
        if (this.state !== "stopped") startUi(...args);
      };
    if (setProgress)
      terminal.setProgress = (active: boolean) => {
        if (this.host.activeId === this.id) setProgress(active);
      };
    if (setTitle)
      terminal.setTitle = (...args: unknown[]) => {
        if (this.host.activeId === this.id) setTitle(...args);
      };
  }

  start(): void {
    if (this.state !== "never-started") {
      this.resume();
      return;
    }
    this.installTerminalGate();
    this.state = "active";
    const record = this.host.get(this.id);
    if (!record) return;
    record.started = true;
    record.state = "active";
    try {
      const run = Promise.resolve(this.mode.run()) as Promise<void>;
      record.runPromise = run;
      void run.then(
        () => this.host.handleModeEnd(this.id),
        (error) => this.host.handleModeEnd(this.id, error),
      );
    } catch (error) {
      void this.host.handleModeEnd(this.id, error);
    }
  }

  suspend(): void {
    if (this.state === "stopped") return;
    try {
      this.ui?.stop?.();
      resetKeyboardModes();
    } catch {
      /* best effort */
    }
    this.state = "suspended";
    const record = this.host.get(this.id);
    if (record && record.state !== "stopped" && record.state !== "error")
      record.state = "suspended";
  }

  resume(): void {
    if (this.state === "stopped") return;
    this.installTerminalGate();
    try {
      this.ui?.start?.();
      this.ui?.requestRender?.(true);
      this.mode.updateTerminalTitle?.();
    } catch {
      /* best effort */
    }
    this.state = "active";
    const record = this.host.get(this.id);
    if (record) record.state = "active";
  }

  async dispose(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";
    const ui = this.ui;
    const originalStop = ui?.stop;
    const ownsTerminal = this.host.activeId === this.id;
    try {
      if (ui && originalStop && !ownsTerminal) ui.stop = () => undefined;
      this.mode.stop("resume-hint");
    } catch {
      /* best effort */
    } finally {
      if (ui && originalStop) ui.stop = originalStop;
    }
    try {
      await this.runtime.dispose();
    } catch {
      /* best effort */
    }
  }
}

export class NativeSessionHost {
  activeId = MAIN_SESSION_ID;
  shuttingDown = false;
  private records = new Map<string, LiveSessionRecord>();
  private ownership = new SessionOwnership();
  private parentTui: any;
  private parentDone?: () => void;
  private parentHandoff = false;
  private restoreParentTerminalGate?: () => void;
  private activation?: Promise<void>;
  private recovering = new Set<string>();
  private pendingMainNotifications: string[] = [];

  constructor() {
    this.records.set(MAIN_SESSION_ID, {
      id: MAIN_SESSION_ID,
      kind: "main",
      name: "main",
      cwd: process.cwd(),
      state: "active",
      activity: "idle",
      createdAt: Date.now(),
    });
  }

  get(id = this.activeId): LiveSessionRecord | undefined {
    return this.records.get(id);
  }
  detour(): LiveSessionRecord | undefined {
    return [...this.records.values()].find(
      (record) =>
        record.kind === "detour" &&
        !["stopped", "error"].includes(record.state),
    );
  }

  bind(api: ExtensionAPI, ctx: ExtensionContext): LiveSessionRecord {
    const manager = ctx.sessionManager as object;
    let ownerId = this.ownership.owner(manager);
    if (!ownerId) {
      ownerId = MAIN_SESSION_ID;
      this.ownership.claim(manager, ownerId);
    }
    const record = this.records.get(ownerId);
    if (!record) throw new Error(`Unknown live session owner: ${ownerId}`);
    record.api = api;
    record.context = ctx;
    record.cwd = ctx.cwd;
    record.sessionId = ctx.sessionManager.getSessionId();
    record.sessionFile = ctx.sessionManager.getSessionFile();
    if (record.kind === "main" && this.pendingMainNotifications.length) {
      for (const message of this.pendingMainNotifications.splice(0)) {
        try {
          ctx.ui.notify(message, "error");
        } catch {
          this.pendingMainNotifications.push(message);
        }
      }
    }
    return record;
  }

  reviveMain(): void {
    this.shuttingDown = false;
    const main = this.records.get(MAIN_SESSION_ID);
    if (main && this.activeId === MAIN_SESSION_ID) main.state = "active";
  }

  detachMain(): void {
    const main = this.records.get(MAIN_SESSION_ID);
    if (!main) return;
    main.api = undefined;
    main.context = undefined;
  }

  activityFor(
    api: ExtensionAPI,
    ctx: ExtensionContext,
    activity: Activity,
  ): void {
    this.bind(api, ctx).activity = activity;
  }

  blocksLiveSessionSwitch(
    record: LiveSessionRecord,
    targetFile: string | undefined,
  ): boolean {
    if (!targetFile) return false;
    const other =
      record.kind === "main"
        ? this.detour()
        : this.records.get(MAIN_SESSION_ID);
    return sameSessionFile(other?.sessionFile, targetFile);
  }

  private createRuntimeFor(ownerId: string): CreateAgentSessionRuntimeFactory {
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      this.ownership.claim(sessionManager, ownerId);
      const record = this.records.get(ownerId);
      const fence = record?.bashFence;
      if (!fence) throw new Error("Detour Bash fence is not prepared");
      assertFenceWorkspace(fence, cwd);
      const inheritance = record.inheritance ?? {};
      let projectTrusted = true;
      if (hasTrustRequiringProjectResources(cwd)) {
        projectTrusted =
          inheritance.sourceCwd &&
          resolve(inheritance.sourceCwd) === resolve(cwd)
            ? inheritance.projectTrusted === true
            : new ProjectTrustStore(agentDir).get(cwd) === true;
      }
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted,
      });
      const extensionFactories = [
        bashFenceInlineExtension(fence, {
          commandPrefix: settingsManager.getShellCommandPrefix(),
          shellPath: settingsManager.getShellPath(),
        }),
        ...(await loadBuiltInExtensions()),
        bashFenceOwnershipGuardInlineExtension(),
      ];
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        extensionFlagValues: CLI_RESOURCES.extensionFlagValues,
        resourceLoaderOptions: {
          ...CLI_RESOURCES.resourceLoaderOptions,
          extensionFactories,
        },
      });
      assertBashFenceRegistrationOrder(
        services.resourceLoader.getExtensions().extensions,
      );

      const options: Record<string, unknown> = {
        ...(inheritance.sessionOptions ?? {}),
      };
      const hasMessages =
        sessionManager.buildSessionContext().messages.length > 0;
      if (hasMessages) {
        delete options.model;
        delete options.thinkingLevel;
      }
      try {
        const patterns =
          CLI_RESOURCES.models ?? settingsManager.getEnabledModels();
        if (patterns?.length) {
          const resolvedScope = await resolveModelScopeWithDiagnostics(
            patterns,
            services.modelRuntime,
          );
          if (resolvedScope.scopedModels.length)
            options.scopedModels = resolvedScope.scopedModels;
          for (const diagnostic of resolvedScope.diagnostics) {
            services.diagnostics.push({
              type: "warning",
              message: diagnostic.message,
            });
          }
        }
      } catch (error) {
        services.diagnostics.push({
          type: "warning",
          message: `Could not inherit child model scope: ${safeMessage(error)}`,
        });
      }
      const requestedProvider = (
        options.model as { provider?: string } | undefined
      )?.provider;
      if (CLI_RESOURCES.apiKey && requestedProvider) {
        await services.modelRuntime.setRuntimeApiKey(
          requestedProvider,
          CLI_RESOURCES.apiKey,
        );
      }
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        ...options,
      });
      const selectedProvider = result.session.model?.provider;
      if (
        CLI_RESOURCES.apiKey &&
        selectedProvider &&
        selectedProvider !== requestedProvider
      ) {
        await services.modelRuntime.setRuntimeApiKey(
          selectedProvider,
          CLI_RESOURCES.apiKey,
        );
      }
      return { ...result, services, diagnostics: services.diagnostics };
    };
  }

  private patchChildShutdown(record: LiveSessionRecord): void {
    const mode = record.mode;
    // The main InteractiveMode remains the sole process-signal owner and disposes the child through host.shutdown().
    mode.registerSignalHandlers = () => undefined;
    mode.shutdown = async () => {
      await this.stopDetourById(record.id);
    };
  }

  async createDetour(
    ctx: ExtensionCommandContext,
    task: string,
    forkLeaf: string | undefined,
  ): Promise<LiveSessionRecord> {
    if (this.detour()) throw new Error("A detour is already active");
    if (this.shuttingDown) throw new Error("Pi is shutting down");
    const sourceFile = ctx.sessionManager.getSessionFile();
    if (!sourceFile || !existsSync(sourceFile) || !forkLeaf)
      throw new Error("Current session is not persisted yet");

    const bashFence = prepareBashFence(ctx.cwd);
    const manager = SessionManager.open(sourceFile);
    const forkFile = manager.createBranchedSession(forkLeaf);
    if (!forkFile) throw new Error("Could not create detour session fork");
    const id = `detour-${Date.now().toString(36)}`;
    const record: LiveSessionRecord = {
      id,
      kind: "detour",
      name: task.slice(0, 60),
      cwd: ctx.cwd,
      state: "starting",
      activity: "idle",
      sessionId: manager.getSessionId(),
      sessionFile: forkFile,
      createdAt: Date.now(),
      inheritance: collectInheritance(ctx),
      bashFence,
    };
    this.records.set(id, record);
    this.ownership.claim(manager, id);

    let runtime: any;
    try {
      runtime = await createAgentSessionRuntime(this.createRuntimeFor(id), {
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        sessionManager: manager,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      if (
        this.shuttingDown ||
        record.expectedStop ||
        this.records.get(id) !== record
      ) {
        throw new Error("Detour creation was cancelled");
      }
      const mode = new InteractiveMode(runtime, {
        migratedProviders: [],
        modelFallbackMessage: runtime.modelFallbackMessage,
        initialMessage: task,
        initialImages: [],
        initialMessages: [],
        tuiMode: CLI_RESOURCES.tuiMode,
        initialThemeSetting: CLI_RESOURCES.useTheme,
      });
      record.runtime = runtime;
      record.mode = mode;
      record.adapter = new InteractiveModeAdapter(id, runtime, mode, this);
      this.patchChildShutdown(record);
      record.state = "suspended";
      return record;
    } catch (error) {
      record.expectedStop = true;
      record.state = "error";
      record.error = safeMessage(error);
      if (runtime) {
        try {
          await runtime.dispose();
        } catch {
          /* best effort */
        }
      }
      if (this.records.get(id) === record) this.records.delete(id);
      throw error;
    }
  }

  async activate(targetId: string): Promise<void> {
    if (this.shuttingDown) return;
    const target = this.records.get(targetId);
    if (!target) throw new Error(`Session not found: ${targetId}`);
    if (targetId === this.activeId) return;
    if (this.activation) {
      await this.activation;
      return this.activate(targetId);
    }
    this.activation = this.doActivate(target).finally(() => {
      this.activation = undefined;
    });
    await this.activation;
  }

  private async doActivate(target: LiveSessionRecord): Promise<void> {
    const current = this.get();
    if (current?.kind === "detour") current.adapter?.suspend();
    else if (current) current.state = "suspended";

    if (target.kind === "main") {
      this.restoreMainTerminal();
      return;
    }
    this.activeId = target.id;
    target.state = "active";
    if (target.started) target.adapter?.resume();
    else target.adapter?.start();
  }

  private installParentTerminalGate(tui: any): void {
    const terminal = tui?.terminal;
    if (!terminal || this.restoreParentTerminalGate) return;
    const originalProgress = terminal.setProgress;
    const originalTitle = terminal.setTitle;
    if (typeof originalProgress === "function") {
      terminal.setProgress = (...args: unknown[]) => {
        if (this.activeId === MAIN_SESSION_ID)
          originalProgress.apply(terminal, args);
      };
    }
    if (typeof originalTitle === "function") {
      terminal.setTitle = (...args: unknown[]) => {
        if (this.activeId === MAIN_SESSION_ID)
          originalTitle.apply(terminal, args);
      };
    }
    this.restoreParentTerminalGate = () => {
      if (typeof originalProgress === "function")
        terminal.setProgress = originalProgress;
      if (typeof originalTitle === "function")
        terminal.setTitle = originalTitle;
      this.restoreParentTerminalGate = undefined;
    };
  }

  private releaseParentHandoff(): void {
    this.restoreParentTerminalGate?.();
    const done = this.parentDone;
    this.parentTui = undefined;
    this.parentDone = undefined;
    this.parentHandoff = false;
    try {
      done?.();
    } catch {
      /* session was disposed */
    }
  }

  private restoreMainTerminal(): void {
    this.activeId = MAIN_SESSION_ID;
    const main = this.records.get(MAIN_SESSION_ID);
    if (main) main.state = "active";
    try {
      this.parentTui?.terminal?.setProgress?.(false);
      this.parentTui?.start?.();
      this.parentTui?.requestRender?.(true);
      const cwd = basename(
        main?.context?.sessionManager.getCwd() ?? main?.cwd ?? process.cwd(),
      );
      const name = main?.context?.sessionManager.getSessionName();
      main?.context?.ui.setTitle(`π - ${name ? `${name} - ` : ""}${cwd}`);
    } catch {
      /* best effort */
    }
    this.releaseParentHandoff();
  }

  async activateFrom(ctx: ExtensionContext, targetId: string): Promise<void> {
    if (this.activeId !== MAIN_SESSION_ID || targetId === MAIN_SESSION_ID) {
      await this.activate(targetId);
      return;
    }
    if (this.parentHandoff) {
      await this.activate(targetId);
      return;
    }
    // Blank terminal handoff only; no conversation content is rendered here.
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      this.parentTui = tui;
      this.parentDone = done;
      this.parentHandoff = true;
      this.installParentTerminalGate(tui);
      try {
        tui.stop();
        resetKeyboardModes();
      } catch {
        /* best effort */
      }
      void this.activate(targetId).catch((error) => {
        this.restoreMainTerminal();
        try {
          ctx.ui.notify(safeMessage(error), "error");
        } catch {
          /* main context already replaced */
        }
      });
      return {
        render: () => [],
        invalidate: () => undefined,
        dispose: () => undefined,
      };
    });
  }

  async stopDetour(): Promise<void> {
    const record = this.detour();
    if (record) await this.stopDetourById(record.id);
  }

  private async stopDetourById(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.kind !== "detour" || record.expectedStop) return;
    record.expectedStop = true;
    record.state = "stopped";
    if (this.activeId === id) {
      try {
        await this.activate(MAIN_SESSION_ID);
      } catch {
        this.restoreMainTerminal();
      }
    }
    try {
      await record.adapter?.dispose();
    } finally {
      this.records.delete(id);
    }
    this.showMainStatus();
  }

  async handleModeEnd(id: string, error?: unknown): Promise<void> {
    const record = this.records.get(id);
    if (
      !record ||
      record.expectedStop ||
      this.shuttingDown ||
      this.recovering.has(id)
    )
      return;
    this.recovering.add(id);
    record.expectedStop = true;
    record.state = "error";
    record.error = error
      ? safeMessage(error)
      : "Native detour UI stopped unexpectedly";
    try {
      if (this.activeId === id) {
        try {
          await this.activate(MAIN_SESSION_ID);
        } catch {
          this.restoreMainTerminal();
        }
      }
      try {
        await record.adapter?.dispose();
      } finally {
        this.records.delete(id);
      }
      this.showMainStatus();
      this.notifyMain(`Detour stopped: ${record.error}`);
    } finally {
      this.recovering.delete(id);
    }
  }

  private notifyMain(message: string): void {
    const context = this.records.get(MAIN_SESSION_ID)?.context;
    if (context) {
      try {
        context.ui.notify(message, "error");
        return;
      } catch {
        /* retry after main rebinds */
      }
    }
    this.pendingMainNotifications.push(message);
  }

  private showMainStatus(): void {
    try {
      const ui = this.records.get(MAIN_SESSION_ID)?.context?.ui;
      ui?.setStatus("pi-detour", "[MAIN]");
      ui?.setWidget("pi-detour-mode", ["[MAIN]"], {
        placement: "belowEditor",
      });
    } catch {
      /* stale context */
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const record = this.detour();
    if (record) {
      record.expectedStop = true;
      record.state = "stopped";
    }
    // A late creation sees expectedStop/record removal and disposes its runtime.
    const managed = record ? this.records.get(record.id) : undefined;
    if (managed?.adapter) {
      if (this.activeId === managed.id) managed.adapter.suspend();
      await managed.adapter.dispose();
    }
    if (record) this.records.delete(record.id);
    if (this.parentDone) this.releaseParentHandoff();
    this.activeId = MAIN_SESSION_ID;
  }
}

export function getNativeSessionHost(): NativeSessionHost {
  const globals = globalThis as typeof globalThis & {
    [HOST_KEY]?: NativeSessionHost;
  };
  globals[HOST_KEY] ??= new NativeSessionHost();
  return globals[HOST_KEY];
}
