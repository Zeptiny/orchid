/**
 * Pure, platform-independent projection for one in-flight chat turn.
 *
 * The IPC event contracts remain the wire authority. This module gives every
 * consumer the same deterministic live view without materializing durable
 * Message records (that remains the main-process persistence boundary).
 */
import type { Usage } from '../types/message';
import type {
  ChatChunkEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatSnapshot,
  ChatSnapshotState,
  ChatStateEvent,
  ChatStreamSegmentSnapshot,
  ChatThinkingEvent,
  ChatToolCallDeltaEvent,
  ChatToolCallSnapshot,
  ChatToolCallStartEvent,
  ChatToolCallUpdateEvent,
  ChatUsageEvent,
} from '../types/ipc';

/** IPC events that contribute facts to the live turn projection. */
export type ChatTurnEvent =
  | ChatChunkEvent
  | ChatThinkingEvent
  | ChatStateEvent
  | ChatDoneEvent
  | ChatErrorEvent
  | ChatUsageEvent
  | ChatToolCallStartEvent
  | ChatToolCallDeltaEvent
  | ChatToolCallUpdateEvent;

/**
 * Event metadata belongs to the local dispatch, not to the IPC schema. In
 * particular, tool snapshots need a deterministic timestamp when a start
 * event was lost before hydration.
 */
export type ChatTurnEventAction = ChatTurnEvent & {
  occurredAt: string;
};

/** Durable outcome facts retained after the live stream reaches a terminal state. */
export type ChatTurnTerminalFact =
  | {
    type: 'done';
    response: string;
    interrupted: boolean;
    usage: Usage | null;
  }
  | {
    type: 'error';
    error: string;
    title?: ChatErrorEvent['title'];
    kind?: ChatErrorEvent['kind'];
  };

/** Renderer-neutral live extension: locally cancelled tools may be `failed`. */
export type ChatTurnToolSnapshot = Omit<ChatToolCallSnapshot, 'status'> & {
  status: ChatToolCallSnapshot['status'] | 'failed';
};

/** Renderer-neutral, in-flight view reconstructed from ordered turn events. */
export interface ChatTurnProjection {
  sessionId: string;
  turnId: string;
  /** Last accepted per-turn event sequence (the snapshot hydration watermark). */
  sequence: number;
  /** Normalized main-process status, never an arbitrary XState value. */
  status: ChatSnapshotState;
  response: string;
  thinking: string;
  streamSegments: ChatStreamSegmentSnapshot[];
  toolCalls: ChatTurnToolSnapshot[];
  usage: Usage | null;
  error: string | null;
  interruptState: ChatSnapshot['interruptState'];
  cwd: string | null;
  startedAt: number | null;
  interrupted: boolean;
  /** Terminal facts are retained independently of later state notifications. */
  terminal: ChatTurnTerminalFact | null;
}

/**
 * The reducer vocabulary is deliberately free of renderer concerns. Consumers
 * can seed from a snapshot, fold one batch of normalized transport events, or
 * perform the small lifecycle transitions that exist before/after a turn has
 * a server-assigned identity.
 */
export type ChatTurnProjectionAction =
  | { type: 'seed'; snapshot: ChatSnapshot }
  | { type: 'begin'; sessionId: string; startedAt: number }
  | { type: 'events'; actions: readonly ChatTurnEventAction[] }
  | { type: 'clear_stream'; status?: ChatSnapshotState }
  | { type: 'clear_error' }
  | { type: 'local_error'; error: string; status?: ChatSnapshotState }
  | {
    type: 'interrupt';
    interruptState: ChatSnapshot['interruptState'];
    status?: ChatSnapshotState;
    occurredAt: string;
    /** First Esc is phase-only; later phases explicitly mark interruption. */
    interrupted: boolean;
    /** Only cancellation phases may fail currently-running tool projections. */
    failActiveTools: boolean;
  }
  | { type: 'reset' };

/** Empty local projection while a send awaits its server-assigned turn id. */
export function beginChatTurnProjection(sessionId: string, startedAt: number | null): ChatTurnProjection {
  return {
    sessionId,
    turnId: '',
    sequence: -1,
    status: 'streaming',
    response: '',
    thinking: '',
    streamSegments: [],
    toolCalls: [],
    usage: null,
    error: null,
    interruptState: 'idle',
    cwd: null,
    startedAt,
    interrupted: false,
    terminal: null,
  };
}

/** Reduce the shared turn vocabulary, without ever materializing Message[]. */
export function reduceChatTurnProjection(
  projection: ChatTurnProjection | null,
  action: ChatTurnProjectionAction,
): ChatTurnProjection | null {
  switch (action.type) {
    case 'seed':
      return seedChatTurnProjection(action.snapshot);
    case 'begin':
      return beginChatTurnProjection(action.sessionId, action.startedAt);
    case 'reset':
      return null;
    case 'events': {
      if (action.actions.length === 0) return projection;
      const first = action.actions[0]!;
      const base = projection ?? beginChatTurnProjection(first.sessionId, null);
      return applyChatTurnEvents(base, action.actions);
    }
    case 'clear_stream':
      if (!projection) return projection;
      return {
        ...projection,
        status: action.status ?? projection.status,
        response: '',
        thinking: '',
        streamSegments: [],
        startedAt: null,
      };
    case 'clear_error':
      return projection
        ? {
          ...projection,
          error: null,
          terminal: projection.terminal?.type === 'error' ? null : projection.terminal,
        }
        : projection;
    case 'local_error':
      return projection
        ? { ...projection, ...(action.status === undefined ? {} : { status: action.status }), error: action.error }
        : {
          ...beginChatTurnProjection('', null),
          ...(action.status === undefined ? {} : { status: action.status }),
          error: action.error,
        };
    case 'interrupt':
      if (!projection) return projection;
      return {
        ...projection,
        ...(action.status === undefined ? {} : { status: action.status }),
        interrupted: action.interrupted,
        interruptState: action.interruptState,
        toolCalls: projection.toolCalls.map((tool) =>
          action.failActiveTools && (tool.status === 'generating' || tool.status === 'running')
            ? { ...tool, status: 'failed', finishedAt: tool.finishedAt ?? action.occurredAt }
            : tool,
        ),
      };
  }
}

/** Copy a main-process live snapshot exactly into the renderer-neutral shape. */
export function seedChatTurnProjection(snapshot: ChatSnapshot): ChatTurnProjection {
  return {
    sessionId: snapshot.sessionId,
    turnId: snapshot.turnId,
    sequence: snapshot.sequence,
    status: snapshot.state,
    response: snapshot.response,
    thinking: snapshot.thinking,
    streamSegments: snapshot.streamSegments.map(copySegment),
    toolCalls: snapshot.toolCalls.map((tool) => ({ ...tool })),
    usage: snapshot.usage,
    error: snapshot.error,
    interruptState: snapshot.interruptState,
    cwd: snapshot.cwd,
    startedAt: snapshot.startedAt,
    interrupted: snapshot.interrupted,
    terminal: null,
  };
}

/** Apply several events in one pure reduction (suitable for one RAF publish). */
export function applyChatTurnEvents(
  projection: ChatTurnProjection,
  actions: readonly ChatTurnEventAction[],
): ChatTurnProjection {
  return coalesceAcceptedDeltas(projection, actions).reduce(applyChatTurnEvent, projection);
}

/**
 * Fold one existing chat IPC event into the projection.
 *
 * Events outside this turn, and all events at/below the current watermark, are
 * ignored by returning the original reference. That makes rejected replay
 * cheap and lets callers use object identity as an acceptance signal.
 */
export function applyChatTurnEvent(
  projection: ChatTurnProjection,
  action: ChatTurnEventAction,
): ChatTurnProjection {
  if (
    (projection.sessionId && action.sessionId !== projection.sessionId) ||
    (projection.turnId && action.turnId !== projection.turnId) ||
    action.sequence <= projection.sequence
  ) {
    return projection;
  }

  const next = {
    ...projection,
    sessionId: projection.sessionId || action.sessionId,
    turnId: projection.turnId || action.turnId,
    sequence: action.sequence,
  };
  if ('state' in action) return applyState(next, action);

  switch (action.type) {
    case 'chunk':
      return {
        ...next,
        response: next.response + action.data,
        streamSegments: appendSegment(next.streamSegments, 'text', action.segmentId, action.data),
      };
    case 'thinking':
      return {
        ...next,
        thinking: next.thinking + action.data,
        streamSegments: appendSegment(next.streamSegments, 'thinking', action.segmentId, action.data),
      };
    case 'usage':
      return { ...next, usage: action.usage };
    case 'tool_call_start':
      return updateTool(next, action.toolCallId, action.toolName, action.occurredAt, () => ({}));
    case 'tool_call_delta':
      return updateTool(next, action.toolCallId, undefined, action.occurredAt, (tool) => ({
        partialArgs: tool.partialArgs + action.argsDelta,
      }));
    case 'tool_call_update':
      return updateTool(next, action.toolCallId, action.toolName, action.occurredAt, (tool) => {
        const terminal = action.status !== 'running' && action.status !== 'generating';
        const alreadyTerminal = tool.status !== 'generating' && tool.status !== 'running';
        const status = alreadyTerminal && action.status === 'running' ? tool.status : action.status;
        return {
          status,
          args: action.args ?? (terminal && !tool.args ? tool.partialArgs : tool.args),
          content: action.content ?? tool.content,
          toolResult: action.toolResult ?? tool.toolResult,
          finishedAt: terminal ? tool.finishedAt ?? action.occurredAt : tool.finishedAt,
        };
      });
    case 'done': {
      const interrupted = action.interrupted ?? next.interrupted;
      const usage = action.usage ?? next.usage;
      return {
        ...next,
        status: 'idle',
        response: action.response,
        usage,
        interrupted,
        terminal: { type: 'done', response: action.response, interrupted, usage },
      };
    }
    case 'error':
      return {
        ...next,
        status: 'error',
        error: action.error,
        terminal: {
          type: 'error',
          error: action.error,
          ...(action.title === undefined ? {} : { title: action.title }),
          ...(action.kind === undefined ? {} : { kind: action.kind }),
        },
      };
  }
}

function applyState(
  projection: ChatTurnProjection,
  event: ChatStateEvent & { occurredAt: string },
): ChatTurnProjection {
  return {
    ...projection,
    status: normalizeChatSnapshotState(event.state),
    error: event.error,
    interruptState: event.interruptState,
    cwd: event.cwd ?? projection.cwd,
  };
}

/** Normalize arbitrary XState values at the shared snapshot boundary. */
export function normalizeChatSnapshotState(state: string): ChatSnapshotState {
  if (state === 'idle' || state === 'interrupted') return 'idle';
  if (state === 'error') return 'error';
  return 'streaming';
}

/**
 * Frame batches commonly contain many adjacent text or tool-argument deltas.
 * Reject stale/wrong-turn events first, then combine only behavior-equivalent
 * adjacent deltas so the pure reducer does not copy projection arrays per token.
 */
function coalesceAcceptedDeltas(
  projection: ChatTurnProjection,
  actions: readonly ChatTurnEventAction[],
): ChatTurnEventAction[] {
  let sessionId = projection.sessionId;
  let turnId = projection.turnId;
  let sequence = projection.sequence;
  const accepted: ChatTurnEventAction[] = [];

  for (const action of actions) {
    if (
      (sessionId && action.sessionId !== sessionId)
      || (turnId && action.turnId !== turnId)
      || action.sequence <= sequence
    ) {
      continue;
    }

    sessionId ||= action.sessionId;
    turnId ||= action.turnId;
    sequence = action.sequence;
    const previous = accepted.at(-1);
    const merged = previous ? mergeAdjacentDelta(previous, action) : null;
    if (merged) {
      accepted[accepted.length - 1] = merged;
    } else {
      accepted.push(action);
    }
  }

  return accepted;
}

function mergeAdjacentDelta(
  previous: ChatTurnEventAction,
  action: ChatTurnEventAction,
): ChatTurnEventAction | null {
  if (!('type' in previous) || !('type' in action)) return null;

  if (
    previous.type === 'chunk'
    && action.type === 'chunk'
    && previous.segmentId === action.segmentId
  ) {
    return { ...previous, sequence: action.sequence, data: previous.data + action.data };
  }
  if (
    previous.type === 'thinking'
    && action.type === 'thinking'
    && previous.segmentId === action.segmentId
  ) {
    return { ...previous, sequence: action.sequence, data: previous.data + action.data };
  }
  if (
    previous.type === 'tool_call_delta'
    && action.type === 'tool_call_delta'
    && previous.toolCallId === action.toolCallId
  ) {
    return {
      ...previous,
      sequence: action.sequence,
      argsDelta: previous.argsDelta + action.argsDelta,
    };
  }
  return null;
}

function updateTool(
  projection: ChatTurnProjection,
  toolCallId: string,
  toolName: string | undefined,
  occurredAt: string,
  patch: (tool: ChatTurnToolSnapshot) => Partial<ChatTurnToolSnapshot>,
): ChatTurnProjection {
  const index = projection.toolCalls.findIndex((tool) => tool.toolCallId === toolCallId);
  const existing = index === -1
    ? createTool(toolCallId, toolName ?? 'unknown', occurredAt)
    : projection.toolCalls[index]!;
  const updated: ChatTurnToolSnapshot = {
    ...existing,
    ...(toolName === undefined ? {} : { toolName }),
    ...patch(existing),
  };
  const toolCalls = index === -1
    ? [...projection.toolCalls, updated]
    : projection.toolCalls.map((tool, candidateIndex) => candidateIndex === index ? updated : tool);
  return {
    ...projection,
    toolCalls,
    streamSegments: ensureToolSegment(projection.streamSegments, toolCallId),
  };
}

function createTool(
  toolCallId: string,
  toolName: string,
  occurredAt: string,
): ChatTurnToolSnapshot {
  return {
    toolCallId,
    toolName,
    status: 'generating',
    partialArgs: '',
    args: '',
    content: null,
    toolResult: null,
    startedAt: occurredAt,
    finishedAt: null,
  };
}

function ensureToolSegment(
  segments: ChatStreamSegmentSnapshot[],
  toolCallId: string,
): ChatStreamSegmentSnapshot[] {
  if (segments.some((segment) => segment.kind === 'tool' && segment.toolCallId === toolCallId)) {
    return segments;
  }
  return [...segments, { kind: 'tool', toolCallId }];
}

function appendSegment(
  segments: readonly ChatStreamSegmentSnapshot[],
  kind: 'text' | 'thinking',
  id: string,
  data: string,
): ChatStreamSegmentSnapshot[] {
  const last = segments.at(-1);
  if (last?.kind === kind && last.id === id) {
    return [...segments.slice(0, -1), { ...last, content: last.content + data }];
  }
  return [...segments, { kind, id, content: data }];
}

function copySegment(segment: ChatStreamSegmentSnapshot): ChatStreamSegmentSnapshot {
  return { ...segment };
}
