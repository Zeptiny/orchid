import type { AgentContext } from '../../agents/xstate/agent-machine';
import type { Usage } from '../../../shared/types/message';
import type {
  ChatSnapshot,
  ChatStreamSegmentSnapshot,
  ChatToolCallSnapshot,
} from '../../../shared/types/ipc';
import { normalizeChatSnapshotState } from '../../../shared/chat/turn-projection';
import { activeAgents, type ActiveAgent } from './state';

export function appendTextSegment(
  active: ActiveAgent,
  kind: 'text' | 'thinking',
  content: string,
): string {
  const last = active.streamSegments.at(-1);
  if (last?.kind === kind) {
    active.streamSegments[active.streamSegments.length - 1] = {
      ...last,
      content: last.content + content,
    };
    return last.id;
  }
  const id = crypto.randomUUID();
  closeOpenStreamSegment(active.streamSegments);
  active.streamSegments.push({ kind, id, content, startedAt: new Date().toISOString() });
  return id;
}

/**
 * Freeze the trailing open text/thinking segment when a newer segment
 * supersedes it, so its elapsed timer stops at the transition.
 */
function closeOpenStreamSegment(segments: ChatStreamSegmentSnapshot[]): void {
  const last = segments.at(-1);
  if (!last || last.kind === 'tool' || last.endedAt != null) return;
  segments[segments.length - 1] = { ...last, endedAt: new Date().toISOString() };
}

/** Close the open trailing segment, if any (turn finalize / flush paths). */
export function closeOpenStreamSegments(active: ActiveAgent): void {
  closeOpenStreamSegment(active.streamSegments);
}

/**
 * Measured thinking duration (ms) for the thinking text covering
 * [fromOffset, toOffset). Sums per-segment spans, so thinking split by
 * interleaved text still reports only the reasoning time. Returns null when
 * no matched segment carries both stamps (legacy snapshots).
 */
export function thinkingDurationMsForRange(
  active: ActiveAgent,
  fromOffset: number,
  toOffset: number,
): number | null {
  if (toOffset <= fromOffset) return null;
  let consumed = 0;
  let totalMs: number | null = null;
  const closeAt = new Date().toISOString();
  for (const segment of active.streamSegments) {
    if (segment.kind !== 'thinking') continue;
    const end = consumed + segment.content.length;
    if (end > fromOffset && consumed < toOffset) {
      const startedAt = segment.startedAt;
      const endedAt = segment.endedAt ?? closeAt;
      if (startedAt) {
        const span = Date.parse(endedAt) - Date.parse(startedAt);
        if (Number.isFinite(span) && span >= 0) {
          totalMs = (totalMs ?? 0) + span;
        }
      }
    }
    consumed = end;
  }
  return totalMs;
}

export function textSegmentIdAtOffset(
  active: ActiveAgent,
  kind: 'text' | 'thinking',
  offset: number,
): string | undefined {
  let consumed = 0;
  for (const segment of active.streamSegments) {
    if (segment.kind !== kind) continue;
    const end = consumed + segment.content.length;
    if (end > offset) return segment.id;
    consumed = end;
  }
  return undefined;
}

export function ensureToolSnapshot(
  active: ActiveAgent,
  toolCallId: string,
  toolName: string,
): ChatToolCallSnapshot {
  const existing = active.toolCalls.get(toolCallId);
  if (existing) return existing;
  const next: ChatToolCallSnapshot = {
    toolCallId,
    toolName,
    status: 'generating',
    partialArgs: '',
    args: '',
    content: null,
    toolResult: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  active.toolCalls.set(toolCallId, next);
  // A previous widget for the same id may have been torn down
  // (completeCompactionWidget deletes the tool call but not its segment), so
  // dedupe — a second segment would render the widget twice / shift ordering.
  const hasSegment = active.streamSegments.some(
    (segment) => segment.kind === 'tool' && segment.toolCallId === toolCallId,
  );
  if (!hasSegment) {
    closeOpenStreamSegment(active.streamSegments);
    active.streamSegments.push({ kind: 'tool', toolCallId });
  }
  return next;
}

export function updateToolSnapshot(
  active: ActiveAgent,
  toolCallId: string,
  toolName: string,
  patch: Partial<ChatToolCallSnapshot>,
): ChatToolCallSnapshot {
  const existing = ensureToolSnapshot(active, toolCallId, toolName);
  const next = { ...existing, ...patch, toolCallId };
  active.toolCalls.set(toolCallId, next);
  return next;
}

export function snapshotForAgent(active: ActiveAgent): ChatSnapshot {
  const context = active.actor.getSnapshot().context as AgentContext;
  const interruptState = active.interruptActor.getSnapshot().value as
    | 'idle'
    | 'confirmAgent'
    | 'confirmSubagents';
  return {
    sessionId: active.sessionId,
    turnId: active.turnId,
    sequence: active.eventSequence,
    state: normalizeChatSnapshotState(String(active.actor.getSnapshot().value)),
    response: context.response ?? '',
    thinking: context.thinking ?? '',
    toolCalls: [...active.toolCalls.values()].map((tool) => ({ ...tool })),
    streamSegments: active.streamSegments.map((segment) => ({ ...segment })),
    usage: (context.usage as Usage | null) ?? null,
    error: context.error ?? null,
    interruptState,
    cwd: active.cwd,
    startedAt: active.startedAt,
    interrupted: active.agentCancelled,
  };
}

/**
 * In-flight turn snapshot for a session, or null when idle/finalized.
 *
 * Shared by chat:snapshot and session:open so both hydrate the renderer from
 * one source. Finalization and persistence share one synchronous callback, so
 * a finalized actor is already represented by history when IPC observes it.
 */
export function getLiveChatSnapshot(sessionId: string): ChatSnapshot | null {
  const active = activeAgents.get(sessionId);
  return active && !active.finalized ? snapshotForAgent(active) : null;
}

/** Originating renderer window for the active main-agent turn. */
export function getActiveMainTurnWindowId(sessionId: string): string | null {
  const active = activeAgents.get(sessionId);
  return active && !active.finalized ? active.windowId : null;
}
