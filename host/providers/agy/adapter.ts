// Antigravity (`agy acp`) as a provider: JSON-RPC 2.0 ACP stdio server, one per chat.
// Uses the user's own `agy` CLI and login; supports streaming text & thinking,
// tool cards, interactive permissions, model/effort/mode pickers, /resume via
// session/list + session/load, images, and /tui via `agy --conversation <id>`.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { AgyProcess, AgyRpcError, type RequestId } from "./rpc.ts";
import { AgyMapper, mapStopReason, mapUsage } from "./mapper.ts";
import { AGY_TOOLS } from "./tools.ts";
import { agentEnv } from "../env.ts";
import { AgentError } from "../types.ts";
import type {
  AdapterHost,
  AdapterOptions,
  AgentCommand,
  AgentModel,
  Ask,
  AskAnswer,
  Capabilities,
  Disposition,
  ModelInfo,
  NormalizedEvent,
  PermissionChoice,
  PermissionMode,
  Prompt,
  ProviderAdapter,
  SessionInfo,
  SessionScope,
  SessionSource,
  StartInfo,
  UsageInfo,
} from "../types.ts";

type Rec = Record<string, any>;

const CLIENT_NAME = "herdr-chat";
const CLIENT_VERSION = "0.1.0";

export const AGY_PERMISSION_MODES: PermissionMode[] = [
  { id: "default", label: "Ask", description: "Ask before edits and commands, per your permission settings" },
  { id: "accept-edits", label: "Accept edits", description: "Approve file edits in the workspace without asking" },
  { id: "auto", label: "Auto", description: "Approve edits and safe commands; ask before irreversible actions" },
  { id: "plan", label: "Plan", description: "Plan carefully before executing a task" },
];

type PendingAsk = { rpcId: RequestId; optionIds: Set<string> };

export function agySessionPath(sessionId: string): string {
  return join(homedir(), ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
}

export function agySessionIdOf(ref: string): string {
  return basename(ref).replace(/\.db$/, "");
}

/** Read default `model` and `agentMode` from `~/.gemini/antigravity-cli/settings.json` (or `AGY_SETTINGS_PATH`), if set. */
export function readAgyUserSettings(settingsPath?: string): { model?: string; agentMode?: string } {
  const path = settingsPath ?? process.env.AGY_SETTINGS_PATH ?? join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Rec;
    const model = typeof s?.model === "string" ? s.model.trim() : "";
    const agentMode = typeof s?.agentMode === "string" ? s.agentMode.trim() : "";
    return {
      ...(model ? { model } : {}),
      ...(agentMode ? { agentMode } : {}),
    };
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function mapPermissionKind(kind: unknown): PermissionChoice["kind"] {
  switch (kind) {
    case "allow_once":
      return "allow";
    case "allow_always":
      return "allow_always";
    case "reject_once":
    case "reject_always":
      return "deny";
    default:
      return "other";
  }
}

export class AgyAdapter implements ProviderAdapter {
  readonly id = "agy";
  readonly name = "Antigravity";
  readonly tools = AGY_TOOLS;
  readonly capabilities: Capabilities = {
    steer: false,
    followUp: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    permissions: true,
    permissionModes: AGY_PERMISSION_MODES,
    extensionUi: false,
    compact: false,
    compactInstructions: false,
    rename: false,
    fork: false,
    images: true,
    cost: false,
    tui: true,
  };

  private opts: AdapterOptions;
  private proc: AgyProcess | null = null;
  private host: AdapterHost | null = null;
  private mapper = new AgyMapper();

  private sessionId: string | null = null;
  private configOptions: Rec[] = [];
  private availableModels: { modelId: string; name: string }[] = [];
  private currentModelId: string | null = null;
  private currentModeId: string | null = "default";
  private availableModes: PermissionMode[] = AGY_PERMISSION_MODES;
  private availableCommands: AgentCommand[] = [];

  private contextUsed: number | null = null;
  private contextWindow: number | null = null;

  private activePrompt = false;
  private aborting = false;
  private replayBuffer: NormalizedEvent[] | null = null;
  private loadedHistory: NormalizedEvent[] = [];
  private asks = new Map<string, PendingAsk>();

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private emitAll(evs: NormalizedEvent[]): void {
    for (const ev of evs) this.emit(ev);
  }

  private require(): AgyProcess {
    if (!this.proc || this.proc.exited) throw new AgentError("Antigravity is not running. Use /reload to restart it.", true);
    return this.proc;
  }

  private requireSession(): string {
    if (!this.sessionId) throw new AgentError("Antigravity has no session open. Use /reload to restart it.");
    return this.sessionId;
  }

  private configOpt(id: string): Rec | undefined {
    return this.configOptions.find((o) => o?.id === id || o?.category === id);
  }

  private modelInfo(): ModelInfo {
    const opt = this.configOpt("model");
    if (opt && typeof opt.currentValue === "string") {
      const id = opt.currentValue;
      const found = Array.isArray(opt.options) ? opt.options.find((x: Rec) => x?.value === id) : null;
      const thought = this.configOpt("thought_level");
      return {
        provider: "antigravity",
        id,
        name: str(found?.name) ?? id,
        reasoning: Boolean(thought && Array.isArray(thought.options) && thought.options.length > 0),
        contextWindow: this.contextWindow,
        input: ["text", "image"],
      };
    }
    const id = this.currentModelId ?? "default";
    const found = this.availableModels.find((m) => m.modelId === id);
    return {
      provider: "antigravity",
      id,
      name: found?.name ?? id,
      reasoning: true,
      contextWindow: this.contextWindow,
      input: ["text", "image"],
    };
  }

  private modelRef(): string {
    const m = this.modelInfo();
    return `${m.provider}/${m.id}`;
  }

  private applySessionMeta(res: Rec): void {
    if (Array.isArray(res.configOptions)) {
      this.configOptions = res.configOptions;
    }
    if (res.models && typeof res.models === "object") {
      if (Array.isArray(res.models.availableModels)) {
        this.availableModels = res.models.availableModels
          .filter((m: Rec) => typeof m?.modelId === "string")
          .map((m: Rec) => ({ modelId: m.modelId, name: str(m.name) ?? m.modelId }));
      }
      if (typeof res.models.currentModelId === "string") {
        this.currentModelId = res.models.currentModelId;
      }
    }
    if (res.modes && typeof res.modes === "object") {
      if (Array.isArray(res.modes.availableModes) && res.modes.availableModes.length) {
        this.availableModes = res.modes.availableModes
          .filter((m: Rec) => typeof m?.id === "string")
          .map((m: Rec) => ({
            id: m.id,
            label: str(m.name) ?? m.id,
            ...(str(m.description) ? { description: m.description } : {}),
          }));
      }
      if (typeof res.modes.currentModeId === "string") {
        this.currentModeId = res.modes.currentModeId;
      }
    }
    this.emitConfigState();
  }

  private emitConfigState(): void {
    const thought = this.configOpt("thought_level");
    const levels = Array.isArray(thought?.options)
      ? thought.options.map((o: Rec) => str(o?.value)).filter((v: string | undefined): v is string => Boolean(v))
      : [];
    const modeOpt = this.configOpt("mode");
    const mode = str(modeOpt?.currentValue) ?? this.currentModeId;
    this.emit({ type: "model", model: this.modelInfo() });
    this.emit({
      type: "capabilities",
      capabilities: {
        thinkingLevels: levels,
        permissionModes: this.availableModes,
      },
    });
    if (typeof thought?.currentValue === "string") {
      this.emit({ type: "thinking", level: thought.currentValue });
    }
    if (mode) {
      this.currentModeId = mode;
      this.emit({ type: "permission_mode", mode });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.mapper.reset();
    this.asks.clear();
    this.activePrompt = false;
    this.aborting = false;
    this.loadedHistory = [];
    this.replayBuffer = null;

    const args = ["acp", ...this.opts.args];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const env = agentEnv({});
    const p = new AgyProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env });
    this.proc = p;

    p.onNotification = (method, params) => {
      if (this.proc !== p) return;
      this.onNotification(method, params);
    };
    p.onServerRequest = (id, method, params) => {
      if (this.proc !== p) return;
      this.onServerRequest(id, method, params);
    };
    p.onStderrLine = (line) => {
      if (this.proc !== p) return;
      host.log(`agy stderr: ${line.slice(0, 300)}`);
    };
    p.onBadLine = (line) => {
      if (this.proc !== p) return;
      host.log(`agy stdout (not JSON): ${line.slice(0, 200)}`);
    };
    p.onOversized = (o) => {
      if (this.proc !== p) return;
      host.log(`dropped oversized agy record (${o.size} bytes)`);
      this.emit({ type: "heartbeat" });
      this.emit({
        type: "notice",
        level: "warning",
        source: "host",
        text: `Antigravity sent an update too large to show (${(o.size / 1048576).toFixed(1)} MiB).`,
        once: "run",
      });
    };
    p.onExit = (info) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.activePrompt = false;
      this.asks.clear();
      host.emit({
        type: "exited",
        code: info.code,
        signal: info.signal,
        stderrTail: info.stderr,
        ...(info.spawnError ? { spawnError: info.spawnError } : {}),
        command: this.opts.command,
      });
    };

    const init = await p.request<Rec>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    }, 30_000);

    const version = str(init?.agentInfo?.version) ?? null;
    this.emit({ type: "version", version });

    if (session) {
      const hasHistory = await this.openExistingSession(p, session);
      return { streaming: false, hasHistory };
    }
    await this.openNewSession(p);
    return { streaming: false, hasHistory: false };
  }

  private async openNewSession(p: AgyProcess): Promise<void> {
    this.mapper.reset();
    this.loadedHistory = [];
    this.contextUsed = 0;
    const res = await p.request<Rec>("session/new", { cwd: this.opts.cwd, mcpServers: [] }, 30_000);
    const sid = str(res?.sessionId);
    if (!sid) throw new AgentError("Antigravity did not return a sessionId");
    this.sessionId = sid;
    this.emit({ type: "session", id: sid, file: agySessionPath(sid), name: null });
    this.applySessionMeta(res);
    await this.applyUserDefaults();
  }

  private async applyUserDefaults(): Promise<void> {
    const s = readAgyUserSettings();
    if (s.model) {
      const want = s.model;
      const opt = this.configOpt("model");
      const options = Array.isArray(opt?.options) ? (opt.options as Rec[]) : [];
      const avail = this.availableModels.find((m) => m.modelId === want || m.name === want);
      const optMatch = options.find((o) => o?.value === want || o?.name === want);
      const targetId = avail?.modelId ?? str(optMatch?.value);
      const currentOptVal = str(opt?.currentValue);
      if (targetId && targetId !== this.currentModelId && targetId !== currentOptVal) {
        try {
          await this.setModel("antigravity", targetId);
        } catch (e) {
          this.host?.log(`failed to apply agy default model (${want}): ${errText(e)}`);
        }
      }
    }
    if (s.agentMode && this.availableModes.some((m) => m.id === s.agentMode) && s.agentMode !== this.currentModeId) {
      try {
        await this.setPermissionMode(s.agentMode);
      } catch (e) {
        this.host?.log(`failed to apply agy default agentMode (${s.agentMode}): ${errText(e)}`);
      }
    }
  }

  private async openExistingSession(p: AgyProcess, sessionRef: string): Promise<boolean> {
    const sessionId = agySessionIdOf(sessionRef);
    const prevSessionId = this.sessionId;
    this.sessionId = sessionId;
    this.mapper.reset();
    this.replayBuffer = [];
    this.loadedHistory = [];
    try {
      const res = await p.request<Rec>("session/load", { sessionId, cwd: this.opts.cwd, mcpServers: [] }, 30_000);
      const sid = str(res?.sessionId) ?? sessionId;
      this.sessionId = sid;
      const tail = this.mapper.finishTurn({ stopReason: "stop", model: this.modelRef() });
      const buffered = [...(this.replayBuffer ?? []), ...tail];
      this.replayBuffer = null;
      this.loadedHistory = buffered;
      this.emit({ type: "session", id: sid, file: agySessionPath(sid) });
      this.applySessionMeta(res);
      return this.loadedHistory.length > 0;
    } catch (e) {
      this.sessionId = prevSessionId;
      this.replayBuffer = null;
      throw e;
    }
  }

  async dispose(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    this.activePrompt = false;
    this.asks.clear();
    if (!p) return;
    await p.stop();
  }

  kill(): void {
    const p = this.proc;
    this.proc = null;
    this.activePrompt = false;
    this.asks.clear();
    p?.killNow();
  }

  // ---------------------------------------------------------------- notifications & asks

  private onNotification(method: string, params: Rec): void {
    if (method !== "session/update") return;
    const sid = str(params.sessionId);
    if (this.sessionId && sid && sid !== this.sessionId) return;
    const u = params.update as Rec | undefined;
    if (!u || typeof u !== "object") return;
    const kind = str(u.sessionUpdate);
    if (!kind) return;

    this.emit({ type: "heartbeat" });

    if (kind === "available_commands_update") {
      if (Array.isArray(u.availableCommands)) {
        this.availableCommands = (u.availableCommands as Rec[])
          .filter((c) => typeof c?.name === "string" && c.name.trim())
          .map((c) => ({
            name: String(c.name).replace(/^\//, ""),
            description: str(c.description) ?? "",
            source: "extension" as const,
          }));
      }
      return;
    }
    if (kind === "usage_update") {
      const used = num(u.used);
      const size = num(u.size);
      if (used !== undefined) this.contextUsed = used;
      if (size !== undefined && size > 0) this.contextWindow = size;
      return;
    }
    if (kind === "config_option_update") {
      if (Array.isArray(u.configOptions)) {
        this.configOptions = u.configOptions;
        this.emitConfigState();
      }
      return;
    }

    const replay = this.replayBuffer !== null;
    const evs = this.mapper.onUpdate(u, { replay, model: this.modelRef() });
    if (replay) {
      for (const ev of evs) {
        if (ev.type === "session" || ev.type === "permission_mode") this.emit(ev);
        else this.replayBuffer!.push(ev);
      }
    } else {
      this.emitAll(evs);
    }
  }

  private onServerRequest(rpcId: RequestId, method: string, params: Rec): void {
    if (method === "session/request_permission") {
      const askId = `agy-perm-${String(rpcId)}`;
      const tc = (params.toolCall ?? {}) as Rec;
      const options = Array.isArray(params.options) ? (params.options as Rec[]) : [];
      const choices: PermissionChoice[] = options
        .filter((o) => typeof o?.optionId === "string")
        .map((o) => ({
          id: o.optionId,
          label: str(o.name) ?? o.optionId,
          kind: mapPermissionKind(o.kind),
        }));
      if (!choices.length) {
        choices.push(
          { id: "allow_once", label: "Allow once", kind: "allow" },
          { id: "reject_once", label: "Deny", kind: "deny" },
        );
      }
      this.asks.set(askId, { rpcId, optionIds: new Set(choices.map((c) => c.id)) });
      const toolName = str(tc.name) ?? str(tc.title);
      const toolArgs = tc.args ?? tc.rawInput;
      const ask: Ask = {
        id: askId,
        kind: "permission",
        title: str(tc.title) ?? (toolName ? `Allow ${toolName}?` : "Allow action?"),
        ...(toolName ? { tool: { name: toolName, args: toolArgs, ...(str(tc.toolCallId) ? { callId: tc.toolCallId } : {}) } } : {}),
        choices,
      };
      this.emit({ type: "ask", ask });
      return;
    }
    this.proc?.respondError(rpcId, -32601, `Unsupported client method: ${method}`);
  }

  answer(askId: string, answer: AskAnswer): void {
    const open = this.asks.get(askId);
    if (!open) return;
    this.asks.delete(askId);
    if ("cancelled" in answer && answer.cancelled) {
      this.proc?.respond(open.rpcId, { outcome: { outcome: "cancelled" } });
      return;
    }
    if ("choice" in answer && open.optionIds.has(answer.choice)) {
      this.proc?.respond(open.rpcId, { outcome: { outcome: "selected", optionId: answer.choice } });
      return;
    }
    this.proc?.respond(open.rpcId, { outcome: { outcome: "cancelled" } });
  }

  // ---------------------------------------------------------------- turns

  async prompt(p: Prompt): Promise<{ disposition: Disposition }> {
    const proc = this.require();
    const sessionId = this.requireSession();
    if (this.activePrompt || p.busy) {
      throw new AgentError("Antigravity is already running a turn. Queue a follow-up (Alt+Enter) or press Esc to stop.");
    }

    const blocks: Rec[] = [];
    if (p.text) blocks.push({ type: "text", text: p.text });
    for (const img of p.images) {
      blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    if (!blocks.length) throw new AgentError("Nothing to send");

    this.activePrompt = true;
    this.aborting = false;
    this.mapper.reset();

    // Confirm the user message and mark the run active right away so Chat.send resolves immediately.
    this.emit({
      type: "user_message",
      text: p.lead ? p.lead.rest : p.text,
      images: p.images.length,
      ...(p.images.length ? { imageBlocks: p.images } : {}),
      ...(p.lead?.skills.length ? { skills: p.lead.skills } : {}),
      clientId: p.id,
    });
    this.emit({ type: "run_started" });

    void proc.request<Rec>("session/prompt", { sessionId, prompt: blocks }, 0).then(
      (res) => {
        if (this.proc !== proc) return;
        this.activePrompt = false;
        const stopReason = this.aborting ? "aborted" : mapStopReason(res?.stopReason);
        const usage = mapUsage(res?.usage);
        this.emitAll(this.mapper.finishTurn({ stopReason, model: this.modelRef(), usage }));
        this.emit({ type: "turn_end" });
        this.emit({ type: "run_settled", aborted: stopReason === "aborted" });
        this.aborting = false;
      },
      (err) => {
        if (this.proc !== proc) return;
        this.activePrompt = false;
        const aborted = this.aborting;
        const exited = err instanceof AgyRpcError && err.agentExited;
        if (!exited) {
          this.emitAll(this.mapper.finishTurn({
            stopReason: aborted ? "aborted" : "error",
            ...(aborted ? {} : { error: errText(err) }),
            model: this.modelRef(),
          }));
          this.emit({ type: "turn_end" });
          this.emit({ type: "run_settled", aborted });
        }
        this.aborting = false;
      },
    );

    return { disposition: "started" };
  }

  async clearQueue(): Promise<string[]> {
    return [];
  }

  abort(): void {
    if (!this.proc || this.proc.exited || !this.sessionId) return;
    this.aborting = true;
    for (const [id, open] of this.asks) {
      this.asks.delete(id);
      this.proc.respond(open.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit({ type: "ask_closed", id });
    }
    this.proc.notify("session/cancel", { sessionId: this.sessionId });
  }

  // ---------------------------------------------------------------- queries

  async history(): Promise<NormalizedEvent[]> {
    return this.loadedHistory;
  }

  readonly sessions: SessionSource = {
    kind: "agent",
    list: async (scope: SessionScope): Promise<SessionInfo[]> => {
      const proc = this.require();
      const params: Rec = scope === "cwd" ? { cwd: this.opts.cwd } : {};
      const res = await proc.request<Rec>("session/list", params, 15_000);
      const raw = Array.isArray(res?.sessions) ? (res.sessions as Rec[]) : [];
      return raw
        .filter((s) => typeof s?.sessionId === "string")
        .map((s) => {
          const updatedAt = str(s.updatedAt);
          const modified = updatedAt ? Date.parse(updatedAt) || 0 : 0;
          const title = str(s.title) ?? null;
          return {
            path: agySessionPath(s.sessionId),
            name: title,
            firstMessage: title ?? s.sessionId,
            modified,
            messageCount: null,
            cwd: str(s.cwd) ?? null,
          };
        });
    },
  };

  async listModels(): Promise<AgentModel[]> {
    const opt = this.configOpt("model");
    if (opt && Array.isArray(opt.options) && opt.options.length) {
      return (opt.options as Rec[])
        .filter((o) => typeof o?.value === "string")
        .map((o) => ({
          provider: "antigravity",
          id: o.value,
          name: str(o.name) ?? o.value,
          reasoning: true,
          enabled: true,
        }));
    }
    return this.availableModels.map((m) => ({
      provider: "antigravity",
      id: m.modelId,
      name: m.name,
      reasoning: true,
      enabled: true,
    }));
  }

  async commands(): Promise<AgentCommand[]> {
    return this.availableCommands;
  }

  async usage(): Promise<UsageInfo> {
    const used = this.contextUsed;
    const win = this.contextWindow;
    const percent = used !== null && win !== null && win > 0 ? Math.min(100, (used / win) * 100) : null;
    return { contextTokens: used, contextWindow: win, percent, cost: null };
  }

  tuiCommand(session: string): string[] {
    return [this.opts.command, "--conversation", agySessionIdOf(session)];
  }

  // ---------------------------------------------------------------- settings & sessions

  async setModel(_provider: string, id: string): Promise<void> {
    const proc = this.require();
    const sessionId = this.requireSession();
    const opt = this.configOpt("model");
    if (opt && Array.isArray(opt.options) && opt.options.some((o: Rec) => o?.value === id)) {
      const res = await proc.request<Rec>("session/set_config_option", { sessionId, configId: "model", value: id }, 15_000);
      if (Array.isArray(res?.configOptions)) {
        this.configOptions = res.configOptions;
        this.emitConfigState();
      }
      return;
    }
    await proc.request("session/set_model", { sessionId, modelId: id }, 15_000);
    this.currentModelId = id;
    this.emitConfigState();
  }

  async setThinking(level: string): Promise<void> {
    const proc = this.require();
    const sessionId = this.requireSession();
    const res = await proc.request<Rec>("session/set_config_option", { sessionId, configId: "thought_level", value: level }, 15_000);
    if (Array.isArray(res?.configOptions)) {
      this.configOptions = res.configOptions;
      this.emitConfigState();
    } else {
      this.emit({ type: "thinking", level });
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    const proc = this.require();
    const sessionId = this.requireSession();
    await proc.request("session/set_mode", { sessionId, modeId: mode }, 15_000);
    this.currentModeId = mode;
    this.emit({ type: "permission_mode", mode });
  }

  async compact(): Promise<void> {
    throw new AgentError("Use /compact directly in the chat composer for Antigravity.");
  }

  async newSession(): Promise<void> {
    const proc = this.require();
    await this.openNewSession(proc);
  }

  async switchSession(path: string): Promise<void> {
    const proc = this.require();
    await this.openExistingSession(proc, path);
  }

  async setName(): Promise<void> {
    throw new AgentError("Antigravity names sessions automatically.");
  }
}
