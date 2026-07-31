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
  toolCalls: ChatToolCallSnapshot[];
  usage: Usage | null;
  error: string | null;
  interruptState: ChatSnapshot['interruptState'];
  cwd: string | null;
  startedAt: number | null;
  interrupted: boolean;
  /** Terminal facts are retained independently of later state notifications. */
  terminal: ChatTurnTerminalFact | null;
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
  return actions.reduce(applyChatTurnEvent, projection);
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
    action.sessionId !== projection.sessionId ||
    action.turnId !== projection.turnId ||
    action.sequence <= projection.sequence
  ) {
    return projection;
  }

  const next = { ...projection, sequence: action.sequence };
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
        const terminal = action.status !== 'running';
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
    status: normalizeState(event.state),
    error: event.error,
    interruptState: event.interruptState,
    cwd: event.cwd ?? projection.cwd,
  };
}

function normalizeState(state: string): ChatSnapshotState {
  if (state === 'idle') return 'idle';
  if (state === 'error') return 'error';
  return 'streaming';
}

function updateTool(
  projection: ChatTurnProjection,
  toolCallId: string,
  toolName: string | undefined,
  occurredAt: string,
  patch: (tool: ChatToolCallSnapshot) => Partial<ChatToolCallSnapshot>,
): ChatTurnProjection {
  const index = projection.toolCalls.findIndex((tool) => tool.toolCallId === toolCallId);
  const existing = index === -1
    ? createTool(toolCallId, toolName ?? 'unknown', occurredAt)
    : projection.toolCalls[index]!;
  const updated: ChatToolCallSnapshot = {
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
): ChatToolCallSnapshot {
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
  segments: readonly ChatStreamSegmentSnapshot[],
  toolCallId: string,
): ChatStreamSegmentSnapshot[] {
  if (segments.some((segment) => segment.kind === 'tool' && segment.toolCallId === toolCallId)) {
    return segments.slice();
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
