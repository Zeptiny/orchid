import type { ActorRefFrom } from 'xstate';
import type { agentMachine } from '../../agents/xstate/agent-machine';
import type { interruptMachine } from '../../agents/xstate/interrupt-machine';
import type { Agent } from '../../../shared/types/agent';
import type { ModelSelection } from '../../../shared/types/provider';
import type { Message } from '../../../shared/types/message';
import type { Session } from '../../../shared/types/session';
import type {
  ChatSendResult,
  ChatStreamSegmentSnapshot,
  ChatToolCallSnapshot,
} from '../../../shared/types/ipc';
import type { ThinkingReplayContext } from '../../llm/history';
import type { ProjectRuntime } from '../../project/runtime';

export type ActiveAgent = {
  /** Stable execution owner; all persistence and events are addressed by it. */
  sessionId: string;
  /** Window that initiated the turn (used only as an event destination). */
  windowId: string;
  /** Chain/turn identity used to order snapshot and stream events. */
  turnId: string;
  /** Project working directory frozen when this turn began. */
  cwd: string;
  /** Epoch timestamp for live elapsed-time displays. */
  startedAt: number;
  actor: ActorRefFrom<typeof agentMachine>;
  interruptActor: ActorRefFrom<typeof interruptMachine>;
  abortController: AbortController;
  /**
   * Full conversation history for the LLM at the start of this turn
   * (prior turns flattened + current user message).
   */
  messages: Message[];
  /**
   * Count of messages from prior turns only (before this turn's user message).
   * Turn-local chain messages = messages.slice(priorMessageCount) + turnMessages.
   */
  priorMessageCount: number;
  /**
   * Messages produced during this turn (tool calls/results + assistant).
   */
  turnMessages: Message[];
  /**
   * Transcript-complete turn slice (from this turn's user message) used by
   * durable writes (checkpoints, finalize, abort). Set after a mid-turn
   * compaction rewrote `messages` to the model-view replay: the replay drops
   * flagged originals and superseded heads, so deriving the durable row from
   * it would durably erase them (review #54). Absent → derive from
   * `messages.slice(priorMessageCount)` as before.
   */
  transcriptBase?: Message[];
  /** Length of context.response already snapshotted into turnMessages as text. */
  responseCommittedLength: number;
  /** Length of context.thinking already snapshotted into turnMessages. */
  thinkingCommittedLength: number;
  /** Count of context.thinkingArtifacts already flushed into turnMessages. */
  thinkingArtifactsCommitted: number;
  agent: Agent;
  /** Connection-scoped selection frozen for this turn's chain/storage. */
  selection: ModelSelection;
  /** Current model's thinking policy + identity; freezes replay per turn. */
  thinkingReplay?: ThinkingReplayContext;
  agentCancelled: boolean;
  finalized: boolean;
  /** Monotonic generation for this window; stale agents must not emit IPC. */
  generation: number;
  /** Per-turn sequence used to order live events against snapshots. */
  eventSequence: number;
  /** Last steady-state metadata sent to renderers; content travels via chunks. */
  lastChatState: ChatStatePayload | null;
  /** Current tool cards, kept outside the renderer so a session can rehydrate. */
  toolCalls: Map<string, ChatToolCallSnapshot>;
  /** Chronological live timeline (text, thinking, and tools) for rehydration. */
  streamSegments: ChatStreamSegmentSnapshot[];
  unsubscribe: () => void;
  interruptUnsubscribe: () => void;
  interruptResetTimer: ReturnType<typeof setTimeout> | null;
  /** Pending deadline that auto-names a still-default session mid-turn. */
  sessionTitleTimer: ReturnType<typeof setTimeout> | null;
  /** Project runtime frozen at turn start; reused for teardown-time naming. */
  runtime: ProjectRuntime;
  /** Chain id of this turn's chain (null when startChain failed). */
  chainId: string | null;
  /** Releases turn-scoped resources exactly once when the actor is disposed. */
  releaseResources: () => void;
};

export type ChatStatePayload = {
  state: string;
  error: string | null;
  interruptState: 'idle' | 'confirmAgent' | 'confirmSubagents';
  cwd: string | null;
};

export const activeAgents = new Map<string, ActiveAgent>();
export const sessionsStarting = new Set<string>();
export const pendingCheckpoints = new Map<string, { timer: ReturnType<typeof setTimeout>; snapshot: () => Message[]; guard?: (active: ActiveAgent) => boolean }>();
/**
 * Sessions with an auto-name LLM attempt in flight. Concurrent triggers
 * (mid-turn deadline vs. turn end vs. interruption) must not each start a
 * separate title call for the same session.
 */
export const namingInFlight = new Set<string>();
/**
 * Single-flight draft session create per window. Concurrent first sends from
 * draft mode share one in-flight ensure promise so only one session is created.
 */
export const draftEnsureByWindow = new Map<
  string,
  Promise<{
    ok: true;
    cwd: string;
    session: Session;
    runtime: ProjectRuntime;
  } | { ok: false; result: ChatSendResult }>
>();

/**
 * Per-session generation counter. Incremented on every new chat:send and on
 * forceAbort so stale actor/interrupt subscriptions can drop events even if
 * they fire after the agent was replaced or torn down.
 */
export const agentGenerations = new Map<string, number>();

export function nextAgentGeneration(sessionId: string): number {
  const gen = (agentGenerations.get(sessionId) ?? 0) + 1;
  agentGenerations.set(sessionId, gen);
  return gen;
}

/** Whether a session still has a cancellable main-agent turn. */
export function hasLiveMainTurn(sessionId: string): boolean {
  const active = activeAgents.get(sessionId);
  return active != null && !active.agentCancelled && !active.finalized;
}

/**
 * Whether this agent may still stream IPC to the renderer.
 * Drops events from cancelled, finalized, replaced, or generation-stale agents.
 */
export function canEmitStreamEvents(sessionId: string, active: ActiveAgent): boolean {
  return (
    !active.agentCancelled &&
    !active.finalized &&
    activeAgents.get(sessionId) === active &&
    agentGenerations.get(sessionId) === active.generation
  );
}

/** True when this agent still occupies the window's active slot (may be cancelled). */
export function isCurrentAgent(sessionId: string, active: ActiveAgent): boolean {
  return (
    activeAgents.get(sessionId) === active &&
    agentGenerations.get(sessionId) === active.generation
  );
}
