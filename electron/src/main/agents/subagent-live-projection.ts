/**
 * Renderer-facing, runtime-only subagent stream state.
 *
 * Durable subagent records intentionally do not contain these fields. This
 * store owns the mutable projection and its wire ordering so records remain
 * suitable for persistence, prompt context, and terminal handoff.
 */
import type { Message, Usage } from '../../shared/types/message';
import { makeAssistantMessage, makeThinkingMessage } from '../llm/message-factories';
import type { Chain } from '../../shared/types/chain';
import {
  SubagentDeltaEventType,
  type SubagentDeltaEvent,
  type SubagentDeltaEventBase,
  type SubagentLiveProjection,
  type SubagentLiveSegment,
  type SubagentStatus,
  type SubagentTerminalState,
  type SubagentToolSnapshot,
} from '../../shared/types/subagent';
import type { SubagentRunProjectionEffect } from './subagent-run-assembler';

type MutableToolSnapshot = { -readonly [K in keyof SubagentToolSnapshot]: SubagentToolSnapshot[K] };

type MutableLiveProjection = {
  -readonly [K in keyof SubagentLiveProjection]: K extends 'segments'
    ? SubagentLiveSegment[]
    : K extends 'toolCalls'
      ? MutableToolSnapshot[]
      : SubagentLiveProjection[K];
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type SubagentDeltaPayload = DistributiveOmit<SubagentDeltaEvent, keyof SubagentDeltaEventBase>;

interface ProjectionEntry {
  readonly projection: MutableLiveProjection;
  committedSegmentCount: number;
  terminalEmitted: boolean;
  lastUsageDeltaAt: number;
}

export interface SubagentProjectionStart {
  readonly subagentId: string;
  readonly sessionId: string | null;
  readonly state: SubagentStatus;
  readonly runId: string;
  /** Restored terminal records must never re-emit a terminal handoff. */
  readonly terminalEmitted?: boolean;
}

/** The explicit non-durable input needed to materialize a persistence tail. */
export interface SubagentProjectionCheckpoint {
  readonly segments: readonly SubagentLiveSegment[];
  readonly committedSegmentCount: number;
  readonly usage: Usage | null;
}

/**
 * The only work returned to the domain manager after projection processing.
 * The store has already updated its live state and owns delta construction;
 * the manager applies transcript/usage mutations and an optional notification
 * before calling `publish` to preserve established event order.
 */
export interface SubagentProjectionDurableEffect {
  readonly usage?: Usage;
  readonly transcript?: {
    readonly messages: readonly Message[];
  };
  readonly notify?: boolean;
  readonly publish?: () => void;
}

export interface SubagentLiveProjectionStoreOptions {
  readonly getUsageDeltaIntervalMs?: () => number;
  readonly now?: () => number;
}

/**
 * Dedicated runtime store and publisher for renderer-facing subagent state.
 * It is deliberately small: projection mutations from the assembler in,
 * typed delta events and cloned snapshots out.
 */
export class SubagentLiveProjectionStore {
  private readonly entries = new Map<string, ProjectionEntry>();
  private readonly sessionRevisions = new Map<string, number>();
  private readonly getUsageDeltaIntervalMs: () => number;
  private readonly now: () => number;
  private onDelta: ((event: SubagentDeltaEvent) => void) | null = null;

  constructor(options: SubagentLiveProjectionStoreOptions = {}) {
    this.getUsageDeltaIntervalMs = options.getUsageDeltaIntervalMs ?? (() => 0);
    this.now = options.now ?? Date.now;
  }

  setOnDelta(listener: ((event: SubagentDeltaEvent) => void) | null): void {
    this.onDelta = listener;
  }

  /** Create or replace one run's mutable state. A follow-up gets a fresh runId. */
  start(params: SubagentProjectionStart): void {
    this.entries.set(params.subagentId, {
      projection: {
        sessionId: params.sessionId,
        subagentId: params.subagentId,
        runId: params.runId,
        sequence: 0,
        state: params.state,
        segments: [],
        toolCalls: [],
        usage: null,
        result: null,
        error: null,
      },
      committedSegmentCount: 0,
      terminalEmitted: params.terminalEmitted === true,
      lastUsageDeltaAt: 0,
    });
  }

  /** Drop an individual projection when its runtime record is removed. */
  remove(subagentId: string): void {
    this.entries.delete(subagentId);
  }

  /** Drop a session's projections and its freshness clock. */
  removeSession(sessionId: string): void {
    for (const [subagentId, entry] of this.entries) {
      if (entry.projection.sessionId === sessionId) this.entries.delete(subagentId);
    }
    this.sessionRevisions.delete(sessionId);
  }

  /** Reset freshness without disturbing an aborting run's terminal handoff. */
  clearSessionRevision(sessionId: string): void {
    this.sessionRevisions.delete(sessionId);
  }

  /** Snapshot a projection without leaking references to mutable run state. */
  get(subagentId: string): SubagentLiveProjection | undefined {
    const entry = this.entries.get(subagentId);
    return entry ? cloneLiveProjection(entry.projection) : undefined;
  }

  /** Snapshot all known projections, optionally scoped to a session. */
  getAll(sessionId?: string | null): SubagentLiveProjection[] {
    return [...this.entries.values()]
      .filter((entry) => sessionId === undefined || entry.projection.sessionId === sessionId)
      .map((entry) => cloneLiveProjection(entry.projection));
  }

  /** Explicit checkpoint used by durable conversion; never attached to records. */
  getCheckpoint(subagentId: string): SubagentProjectionCheckpoint | undefined {
    const entry = this.entries.get(subagentId);
    if (!entry) return undefined;
    return {
      segments: entry.projection.segments.map((segment) => ({ ...segment })),
      committedSegmentCount: entry.committedSegmentCount,
      usage: entry.projection.usage,
    };
  }

  getSessionRevision(sessionId: string): number {
    return this.sessionRevisions.get(sessionId) ?? 0;
  }

  /** Domain mutations participate in the same per-session freshness clock. */
  bumpSessionRevision(sessionId: string | null): void {
    if (!sessionId) return;
    this.sessionRevisions.set(sessionId, (this.sessionRevisions.get(sessionId) ?? 0) + 1);
  }

  update(
    subagentId: string,
    patch: Partial<Omit<SubagentLiveProjection, 'sequence' | 'subagentId' | 'runId'>>,
  ): void {
    const entry = this.requireEntry(subagentId);
    const live = entry.projection;
    if (patch.sessionId !== undefined) live.sessionId = patch.sessionId;
    if (patch.state !== undefined) live.state = patch.state;
    if (patch.usage !== undefined) live.usage = patch.usage;
    if (patch.result !== undefined) live.result = patch.result;
    if (patch.error !== undefined) live.error = patch.error;
    if (patch.segments !== undefined) {
      live.segments.length = 0;
      live.segments.push(...patch.segments.map((segment) => ({ ...segment })));
    }
    if (patch.toolCalls !== undefined) {
      live.toolCalls.length = 0;
      live.toolCalls.push(...patch.toolCalls.map((tool) => ({ ...tool })));
    }
    this.advance(entry);
  }

  /** Publish a manager-originated status/spawn delta with current stream identity. */
  emit(subagentId: string, delta: SubagentDeltaPayload): void {
    this.emitEntry(this.requireEntry(subagentId), delta);
  }

  /**
   * Fold assembler projection effects into live state. Returned entries are
   * deliberately only domain work and notification boundaries; individual
   * wire events remain authored and published by this store.
   */
  applyAssemblerEffects(
    subagentId: string,
    effects: readonly SubagentRunProjectionEffect[],
  ): readonly SubagentProjectionDurableEffect[] {
    const applied: SubagentProjectionDurableEffect[] = [];
    const entry = this.requireEntry(subagentId);

    for (const effect of effects) {
      switch (effect.type) {
        case 'append_text': {
          const last = entry.projection.segments.at(-1);
          if (last?.kind === effect.kind && last.id === effect.segmentId) {
            last.content += effect.append;
          } else {
            entry.projection.segments.push({
              kind: effect.kind,
              id: effect.segmentId,
              content: effect.append,
            });
          }
          this.advance(entry);
          const sequence = entry.projection.sequence;
          applied.push({
            publish: () => this.emitEntry(entry, effect.kind === 'text'
              ? { type: SubagentDeltaEventType.TEXT_DELTA, segmentId: effect.segmentId, append: effect.append }
              : { type: SubagentDeltaEventType.THINKING_DELTA, segmentId: effect.segmentId, append: effect.append },
            sequence),
          });
          break;
        }
        case 'usage': {
          entry.projection.usage = effect.usage;
          this.advance(entry);
          const sequence = entry.projection.sequence;
          const now = this.now();
          const publish = entry.lastUsageDeltaAt === 0 ||
            now - entry.lastUsageDeltaAt >= this.getUsageDeltaIntervalMs();
          if (publish) entry.lastUsageDeltaAt = now;
          applied.push({
            usage: effect.usage,
            ...(publish
              ? {
                  publish: () => this.emitEntry(
                    entry,
                    { type: SubagentDeltaEventType.USAGE, usage: effect.usage },
                    sequence,
                  ),
                }
              : {}),
          });
          break;
        }
        case 'tool_start': {
          if (entry.projection.toolCalls.some((tool) => tool.toolCallId === effect.toolCallId)) break;
          entry.projection.toolCalls.push({
            toolCallId: effect.toolCallId,
            toolName: effect.toolName,
            status: 'generating',
            partialArgs: '',
            args: '',
            content: null,
            toolResult: null,
            startedAt: effect.startedAt,
            finishedAt: null,
          });
          entry.projection.segments.push({ kind: 'tool', id: effect.segmentId, toolCallId: effect.toolCallId });
          this.advance(entry);
          const sequence = entry.projection.sequence;
          applied.push({
            publish: () => this.emitEntry(entry, {
              type: SubagentDeltaEventType.TOOL_START,
              segmentId: effect.segmentId,
              toolCallId: effect.toolCallId,
              toolName: effect.toolName,
              status: 'generating',
              args: '',
              startedAt: effect.startedAt,
            }, sequence),
          });
          break;
        }
        case 'tool_args_delta': {
          const tool = entry.projection.toolCalls.find((item) => item.toolCallId === effect.toolCallId);
          if (!tool) break;
          tool.partialArgs += effect.append;
          this.advance(entry);
          const sequence = entry.projection.sequence;
          applied.push({
            publish: () => this.emitEntry(entry, {
              type: SubagentDeltaEventType.TOOL_ARGS_DELTA,
              toolCallId: effect.toolCallId,
              append: effect.append,
            }, sequence),
          });
          break;
        }
        case 'tool_call': {
          const tool = entry.projection.toolCalls.find((item) => item.toolCallId === effect.toolCallId);
          if (tool) {
            tool.toolName = effect.toolName;
            tool.status = 'running';
            tool.args = effect.args;
            tool.partialArgs = effect.args;
            this.advance(entry);
          }
          const sequence = entry.projection.sequence;
          // The assembler has committed every segment through this durable
          // tool-call boundary. Move the checkpoint cursor atomically with the
          // transcript effect so a later checkpoint cannot duplicate its
          // already-durable text/thinking prefix.
          entry.committedSegmentCount = effect.committedSegmentCount;
          applied.push({
            transcript: {
              messages: effect.messages,
            },
            notify: true,
            ...(effect.segmentId && effect.startedAt
              ? { publish: () => this.emitEntry(entry, {
                type: SubagentDeltaEventType.TOOL_START,
                segmentId: effect.segmentId!,
                toolCallId: effect.toolCallId,
                toolName: effect.toolName,
                status: 'running',
                args: effect.args,
                startedAt: effect.startedAt!,
              }, sequence) }
              : {}),
          });
          break;
        }
        case 'tool_result': {
          const tool = entry.projection.toolCalls.find((item) => item.toolCallId === effect.toolCallId);
          if (tool) {
            tool.status = effect.status;
            tool.content = effect.content;
            tool.toolResult = effect.toolResult;
            tool.finishedAt = effect.finishedAt;
            this.advance(entry);
          }
          const sequence = entry.projection.sequence;
          // A result can also materialize a missing tool-call transcript, so
          // only advance the checkpoint when the assembler provides an
          // authoritative cursor for an already-materialized call.
          if (effect.committedSegmentCount !== undefined) {
            entry.committedSegmentCount = effect.committedSegmentCount;
          }
          applied.push({
            transcript: {
              messages: effect.messages,
            },
            notify: true,
            publish: () => this.emitEntry(entry, {
              type: SubagentDeltaEventType.TOOL_RESULT,
              toolCallId: effect.toolCallId,
              status: effect.status,
              content: effect.content,
              toolResult: effect.toolResult,
              finishedAt: effect.finishedAt,
            }, sequence),
          });
          break;
        }
      }
    }

    return applied;
  }

  /** Clear heavy tail arrays without advancing wire freshness (eviction-only). */
  clearLiveTail(subagentId: string): void {
    const entry = this.entries.get(subagentId);
    if (!entry) return;
    entry.projection.segments.length = 0;
    entry.projection.toolCalls.length = 0;
    entry.committedSegmentCount = 0;
  }

  /** Emit the one authoritative terminal event after its durable record is available. */
  finish(
    subagentId: string,
    params: {
      readonly state: SubagentTerminalState;
      readonly result: string | null;
      readonly error: string | null;
      readonly usage: Usage | null;
      readonly terminalRecord: () => Extract<SubagentDeltaEvent, { type: 'terminal' }>['record'];
    },
  ): void {
    // Session purge may remove a record while its aborted runner is still
    // unwinding. The cancel path already emitted its terminal event, so the
    // late finally-block call is intentionally a no-op.
    const entry = this.entries.get(subagentId);
    if (!entry) return;
    if (entry.terminalEmitted) return;
    entry.terminalEmitted = true;
    entry.projection.state = params.state;
    entry.projection.result = params.result;
    entry.projection.error = params.error;
    entry.projection.usage = params.usage;
    entry.projection.segments.length = 0;
    entry.projection.toolCalls.length = 0;
    entry.committedSegmentCount = 0;
    this.advance(entry);
    this.emitEntry(entry, {
      type: SubagentDeltaEventType.TERMINAL,
      record: params.terminalRecord(),
      state: params.state,
      usage: params.usage,
    });
  }

  private requireEntry(subagentId: string): ProjectionEntry {
    const entry = this.entries.get(subagentId);
    if (!entry) throw new Error(`Missing live projection for subagent '${subagentId}'`);
    return entry;
  }

  private advance(entry: ProjectionEntry): void {
    entry.projection.sequence += 1;
    this.bumpSessionRevision(entry.projection.sessionId);
  }

  private emitEntry(
    entry: ProjectionEntry,
    delta: SubagentDeltaPayload,
    sequence = entry.projection.sequence,
  ): void {
    if (!this.onDelta) return;
    const sessionId = entry.projection.sessionId ?? '';
    const event = {
      sessionId,
      subagentId: entry.projection.subagentId,
      runId: entry.projection.runId,
      sequence,
      sessionRevision: this.getSessionRevision(sessionId),
      ...delta,
    } as SubagentDeltaEvent;
    try {
      this.onDelta(event);
    } catch (err) {
      console.debug('Subagent delta listener failed (non-fatal):', err);
    }
  }
}

/** Deep-copy a projection so snapshot reads never alias mutable run state. */
export function cloneLiveProjection(projection: SubagentLiveProjection): SubagentLiveProjection {
  return {
    ...projection,
    segments: projection.segments.map((segment) => ({ ...segment })),
    toolCalls: projection.toolCalls.map((tool) => ({ ...tool })),
  };
}

/** Materialize an explicit projection checkpoint without mutating its chain. */
export function materializeProjectionTail(
  checkpoint: SubagentProjectionCheckpoint,
  chain: Chain,
): Chain {
  const tail = checkpoint.segments.slice(checkpoint.committedSegmentCount);
  if (tail.length === 0) return chain;
  const messages = [...chain.messages];
  const lastTextIndex = tail.findLastIndex((segment) => segment.kind === 'text');
  for (const [index, segment] of tail.entries()) {
    if (segment.kind === 'thinking' && segment.content) {
      messages.push(makeThinkingMessage(segment.content, segment.id));
    } else if (segment.kind === 'text' && segment.content) {
      messages.push(makeAssistantMessage(
        segment.content,
        index === lastTextIndex ? checkpoint.usage : null,
        segment.id,
      ));
    }
  }
  return { ...chain, messages };
}
