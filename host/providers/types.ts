// The seam between the provider-neutral host core and one agent (docs/dev/providers.md).
//
// An adapter spawns and talks to its agent, turns the agent's records into
// NormalizedEvents, and carries out commands. The core owns everything a user
// sees: phase and settle, items, coalescing, blocks/highlighting/mermaid,
// images on disk, the transcript, OSC 7501, `hc send`, the registry, session
// locks and the built-in slash commands.
import type { ToolDetail, UserSource, StopReason, Usage, NoticeItem, PlanStep } from "../timeline.ts";

export type { ToolDetail, UserSource, StopReason, Usage, PlanStep };

/** Provider ids. The core treats this as an opaque string; these are the known ones. */
export type ProviderId = "pi" | "claude" | "codex" | (string & {});

/** Base64 image content, as it arrives from the agent. The core saves it to a file. */
export type ImageBlock = { data: string; mimeType: string };

/**
 * A skill a user message invokes (host/skill.ts). `command`: what the person
 * types to run it again, without the slash (Pi "skill:name", Claude Code and
 * Codex "name"). `path`: its SKILL.md. `body`: what the agent got, when known.
 */
export type SkillRef = { name: string; command: string; path?: string; body?: string };

export type ModelInfo = { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number | null; input: string[] };

export type PermissionMode = { id: string; label: string; description?: string };

/** protocol.md v3 "ChatState additions". */
export type Capabilities = {
  /** A message mid-run is folded into the current run. */
  steer: boolean;
  /** A message mid-run can wait for the run to end. */
  followUp: boolean;
  /** The picker's levels for the current model; [] = no picker. */
  thinkingLevels: string[];
  /** The agent asks for approval itself (`ask` kind "permission"). */
  permissions: boolean;
  /** [] = no mode chip. */
  permissionModes: PermissionMode[];
  /** Statuses and widgets can arrive. */
  extensionUi: boolean;
  compact: boolean;
  rename: boolean;
  /** /fork: the adapter has `forkPoints` and `fork`. */
  fork: boolean;
  /** The current model takes images. */
  images: boolean;
  /** usage.cost is meaningful. */
  cost: boolean;
  /** A TUI hand-off exists. */
  tui: boolean;
};

// ---------------------------------------------------------------- asks

export type PermissionChoice = { id: string; label: string; kind: "allow" | "allow_always" | "deny" | "other"; description?: string };
export type Question = {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
};

/**
 * One shape for extension dialogs, permission prompts and questions. Text may
 * hold ANSI; the core strips it. `timeoutAt`: the agent resolves the ask
 * itself then, and the core drops it.
 */
export type Ask =
  /** Extension dialogs (Pi): a select answers `value` (one of `options`), a confirm `confirmed`, input/editor `value`. */
  | { id: string; kind: "select" | "confirm" | "input" | "editor"; title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; timeoutAt?: number }
  | {
      id: string; kind: "permission"; title: string; message?: string;
      /** What will run. The core classifies it like a tool card header. */
      tool?: { name: string; args?: unknown; callId?: string };
      choices: PermissionChoice[];
      timeoutAt?: number;
    }
  | { id: string; kind: "questions"; title: string; questions: Question[]; timeoutAt?: number };

/** The core validates an answer against its ask before passing it on. */
export type AskAnswer =
  | { cancelled: true }
  | { confirmed: boolean }
  | { value: string }
  | { choice: string; message?: string }
  | { answers: Record<string, string | string[]> };

// ---------------------------------------------------------------- events

/** A block of a finished assistant message, at its content index. */
export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; callId: string; name: string; args: unknown };

/**
 * Fields every event may carry:
 * - `ts`: when it happened (history replay); live events use the time they arrive.
 * - `parent`: the callId of the tool call (a subagent) whose run produced it. The core nests the item under that tool's card.
 */
type Common = { ts?: number; parent?: string };

export type NormalizedEvent = Common &
  (
    // ---- run
    /** A run began. The core decides whether it was prompted or autonomous. */
    | { type: "run_started" }
    /** The run is over: nothing is running or queued. */
    | { type: "run_settled"; aborted: boolean }
    /** Why an autonomous run started ("Started by …"); shown once per run. */
    | { type: "run_cause"; text: string }
    /** One model turn inside the run ended (the core refreshes usage). */
    | { type: "turn_end" }
    /** `steeringIds`/`followUpIds`, aligned with the texts: the host's message id of each (`prompt`'s `id`), null = not the host's. */
    | { type: "queue_changed"; steering: string[]; followUp: string[]; steeringIds?: (string | null)[]; followUpIds?: (string | null)[] }
    /**
     * The agent did something. Emit one per agent record that isn't UI-only
     * (dialogs, statuses, notifications): the core's hung-command hint counts them.
     */
    | { type: "heartbeat" }

    // ---- messages
    /**
     * A user message the agent accepted. `clientId` is the host's message id
     * (`prompt`'s `id`) when it is the echo of one the host sent: the core
     * confirms that message's item. Without `clientId` or `source` it is from
     * elsewhere (the agent's own, an extension, another client). `skill`: the
     * skill it invokes, when the adapter knows it; `text` is then only what
     * the person wrote after it. Without it the core checks `text` itself.
     */
    | { type: "user_message"; text: string; images: number; imageBlocks?: ImageBlock[]; source?: UserSource; from?: string; clientId?: string; skill?: SkillRef }
    /** Custom (extension) message, shown as its own item. */
    | { type: "custom"; customType: string; text: string }
    | { type: "assistant_start" }
    | { type: "assistant_block_start"; index: number; kind: "text" | "thinking" }
    | { type: "assistant_delta"; index: number; kind: "text" | "thinking"; delta: string }
    /** `text`, when given, replaces what streamed. */
    | { type: "assistant_block_end"; index: number; kind: "text" | "thinking"; text?: string }
    /**
     * One assistant message (one model call) is complete. `content` is
     * authoritative, indexed like the deltas (null = a block with nothing to
     * show). `model` is "provider/id".
     */
    | { type: "assistant_end"; content: (AssistantBlock | null)[]; stopReason?: StopReason; error?: string; model?: string; usage?: Usage; durationMs?: number }

    // ---- tools
    /** A tool call is being written by the model (`index` = its content index). */
    | { type: "tool_call_start"; index: number; callId: string; name: string }
    | { type: "tool_call_delta"; index: number; delta: string }
    /** The call is complete; not running yet. */
    | { type: "tool_call"; index?: number; callId: string; name: string; args: unknown }
    | { type: "tool_started"; callId: string; name: string; args?: unknown }
    /** `output` is the whole output so far, not a delta. */
    | { type: "tool_progress"; callId: string; name: string; args?: unknown; output?: string }
    /**
     * `result` is the agent's native result, read by the shared tool
     * classifier (exit codes, diffs). `declined`: permission denied or blocked
     * by a rule. `lostBytes`: the result was too large to receive.
     */
    | {
        type: "tool_ended"; callId: string; name: string; args?: unknown; isError: boolean; declined?: boolean;
        output: string; images?: ImageBlock[]; result?: unknown; durationMs?: number; lostBytes?: number;
      }
    /** A todo list or plan update; `key` identifies the plan item, replaced in place. */
    | { type: "plan"; key: string; explanation?: string; steps: PlanStep[] }

    // ---- asks
    | { type: "ask"; ask: Ask }
    /** The agent withdrew or resolved an ask itself. */
    | { type: "ask_closed"; id: string }

    // ---- decoration
    /** `text: null` removes it. */
    | { type: "status"; key: string; text: string | null }
    | { type: "widget"; key: string; placement: "aboveEditor" | "belowEditor"; lines: string[] | null }
    | { type: "title"; text: string | null }
    | { type: "editor_text"; text: string | null }
    /** `once: "run"`: at most one such notice per run. */
    | { type: "notice"; level: NoticeItem["level"]; source: NoticeItem["source"]; text: string; once?: "run" }

    // ---- session
    /** Omitted fields are unchanged. `file` is what the session lock and hand-off use. */
    | { type: "session"; id?: string | null; file?: string | null; name?: string | null }
    | { type: "model"; model: ModelInfo }
    | { type: "thinking"; level: string }
    | { type: "permission_mode"; mode: string | null }
    | { type: "capabilities"; capabilities: Partial<Capabilities> }
    | { type: "version"; version: string | null }
    | { type: "compaction"; phase: "start"; reason: "manual" | "overflow" | "auto" }
    | { type: "compaction"; phase: "end"; outcome: "done" | "aborted" | "failed"; tokensBefore?: number; tokensAfter?: number; error?: string }
    | { type: "retry"; phase: "start"; attempt: number; maxAttempts: number | null; delayMs: number; error: string }
    | { type: "retry"; phase: "end"; success: boolean; attempt: number | null; error?: string }

    // ---- lifecycle
    /** The agent process is gone. Reported once; not after `dispose`. */
    | { type: "exited"; code: number | null; signal: string | null; stderrTail: string; spawnError?: string; command?: string }
  );

export type EventOf<T extends NormalizedEvent["type"]> = Extract<NormalizedEvent, { type: T }>;

// ---------------------------------------------------------------- commands

export type PromptMode = "auto" | "steer" | "followUp";

/**
 * "started": a run begins; "handled": the agent answered without a run (a
 * local command); "queued": it waits for the current run.
 */
export type Disposition = "started" | "handled" | "queued" | (string & {});

export type AgentCommand = { name: string; description: string; source: "extension" | "prompt" | "skill" };
export type AgentModel = { provider: string; id: string; name: string; reasoning: boolean; enabled: boolean };
export type SessionInfo = { path: string; name: string | null; firstMessage: string; modified: number; messageCount: number };
export type UsageInfo = { contextTokens: number | null; contextWindow: number | null; percent: number | null; cost: number | null };

/** Errors from commands. `agentExited`: the agent went away before answering (the exit is reported separately). */
export class AgentError extends Error {
  agentExited: boolean;
  /** The agent refused the session because another process writes it (Codex "active writer"). */
  sessionBusy: boolean;
  constructor(message: string, agentExited = false, sessionBusy = false) {
    super(message);
    this.agentExited = agentExited;
    this.sessionBusy = sessionBusy;
  }
}

/** What the core lets an adapter see. Bound to one `start`: events from an older process are dropped. */
export interface AdapterHost {
  emit(ev: NormalizedEvent): void;
  log(msg: string): void;
  /** A run is active (run_started seen, not settled). */
  readonly running: boolean;
  /** The core's phase is "working" (a run is active or one is expected). */
  readonly working: boolean;
}

export type StartInfo = {
  /** The agent is mid-run already (reattached to a busy session). */
  streaming: boolean;
  /** The session has messages to load with `history()`. */
  hasHistory: boolean;
};

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Display name: "Pi", "Claude Code", "Codex". */
  readonly name: string;
  /** Initial capabilities; `capabilities` events update them. */
  readonly capabilities: Capabilities;
  /** The agent process is up. */
  readonly alive: boolean;

  /**
   * Spawn the agent on `session` (null = a new one). Emits `version`,
   * `session`, `model` and `thinking` events as they become known. Resolves
   * when the agent answers; rejects when it doesn't start (an `exited` event
   * follows if the process died).
   */
  start(session: string | null, host: AdapterHost): Promise<StartInfo>;
  /** Close stdin, wait, then kill the process tree. No `exited` event follows. */
  dispose(): Promise<void>;
  /** Synchronous last resort (process exit handlers). */
  kill(): void;
  /** Optional: the core adopted the run `start` reported (`streaming`); watch for its end. */
  watchRun?(): void;

  // ---- turns
  /** `id`: the host's id for this message; the adapter puts it on the message's echo (`user_message.clientId`) and queue entries. */
  prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }>;
  /** Drops queued messages and returns their text (for the composer). Called before `abort`. */
  clearQueue(): Promise<string[]>;
  /**
   * Optional: the agent lets the host take back this queued message (the host's
   * id, from `prompt`) now. Without it, no queued message can be removed.
   */
  canRemoveQueued?(id: string): boolean;
  /** Takes the queued message back. Resolves false when the agent already took it. It emits the new `queue_changed`. */
  removeQueued?(id: string): Promise<boolean>;
  /** Stops the run. Fire and forget: `run_settled` follows. */
  abort(): void;
  answer(askId: string, answer: AskAnswer): void;

  // ---- queries
  /** The normalized events that rebuild the current session's timeline. */
  history(): Promise<NormalizedEvent[]>;
  /** This cwd's sessions, newest first (async for agents that list them over RPC). */
  listSessions(current: string | null): SessionInfo[] | Promise<SessionInfo[]>;
  listModels(): Promise<AgentModel[]>;
  commands(): Promise<AgentCommand[]>;
  usage(): Promise<UsageInfo>;
  /**
   * The argv of the agent's own TUI on this session, run in the chat's cwd.
   * `handoffFile`: where the TUI reports the session it is on (Pi's lock
   * extension reads PI_CHAT_HANDOFF), so the chat resumes that one.
   */
  tuiCommand(session: string, ctx?: { handoffFile?: string | null }): string[];
  /**
   * Optional: the agent's own guard. A live agent process (not this adapter's)
   * that has `session` open, e.g. Claude Code's ~/.claude/sessions registry.
   */
  sessionHolder?(session: string): { pid: number } | null;
  /**
   * Optional: a terminal utility for a built-in that runs outside the chat
   * ("login", "settings", "scoped-models"), or null when the agent has none.
   * The core lists only the built-ins this returns an argv for.
   */
  utilityCommand?(name: string): string[] | null;
  /** Optional: built-ins that need the session in the agent's own TUI ("tree", "export", "hotkeys"). */
  readonly tuiOnlyCommands?: string[];
  /**
   * Optional: what the chat types into the agent's terminal once it is idle,
   * for a built-in that opens one (a utility, a TUI-only command), so
   * the person lands on that screen (Pi: "/login"). Null: nothing.
   */
  tuiInput?(name: string): string | null;
  /**
   * Optional: the cause of an autonomous run that a user message nobody sent
   * started (Pi: an extension's sendUserMessage). Without it, and without a
   * `run_cause`, the run reads "<name> started a run on its own."
   */
  readonly unsentMessageCause?: string;

  // ---- settings and sessions (each emits the events for what changed)
  setModel(provider: string, id: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  /** Resolves when compaction is done; rejects when it fails. */
  compact(instructions?: string): Promise<void>;
  newSession(): Promise<void>;
  switchSession(path: string): Promise<void>;
  setName(name: string): Promise<void>;

  // ---- fork (the person's messages, then a new session from before one of them)
  /** Optional, with `fork`: the person's messages in this session, oldest first. */
  forkPoints?(): Promise<ForkPoint[]>;
  /**
   * Switches to a new session holding everything before that message (the
   * one it was forked from stays as it was), and resolves with the message's
   * text for the composer. Emits the `session` events, like `switchSession`.
   */
  fork?(point: string): Promise<{ text: string }>;
}

/** A message the session can be forked before: the agent's id for it, and its text as typed. */
export type ForkPoint = { id: string; text: string };

export type AdapterOptions = {
  cwd: string;
  /** The agent's command (`pi`, `claude`, `codex`, or a test double). */
  command: string;
  /** Extra arguments for the agent (after `--` on the host's command line). */
  args: string[];
  log: (msg: string) => void;
};
