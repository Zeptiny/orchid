/**
 * Server-side snapshot trimming with a history_page continuation (#25).
 *
 * chat.snapshot / session.open used to serialize the WHOLE flattened history
 * into one protocol frame; past the 32MiB frame cap the transport dies and
 * every reopen re-requests the same snapshot (deterministic reconnect brick).
 * The trim keeps the newest messages that fit a safe budget and emits a
 * continuation cursor satisfying `session.history_page` params.
 *
 * Two layers under test: the pure helper (host/chat/snapshot-trim.ts) and the
 * chat.snapshot binding composing it. session.open should adopt the same
 * helper (see the binding owner); the renderer already pages history through
 * session.history_page on chain views.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chain } from '../../src/shared/types/chain';
import type { Message } from '../../src/shared/types/message';
import type { Session } from '../../src/shared/types/session';
import { MAX_FRAME_BYTES } from '../../src/shared/host/framing';
import { chatSessionSnapshotSchema, sessionHistoryPageSchema } from '../../src/shared/types/ipc-schemas';

const mocks = vi.hoisted(() => ({
  session: null as Session | null,
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => ({
    getActive: () => mocks.session,
    getSession: (id: string) => (mocks.session?.id === id ? mocks.session : null),
  }),
}));
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => 'trusted',
}));
vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: () => ({ projectDir: '/tmp/project', config: {} }) }),
}));
vi.mock('../../src/main/host/chat/send', () => ({ startChatTurn: vi.fn() }));
vi.mock('../../src/main/host/chat/cancel', () => ({ requestChatCancel: vi.fn() }));
vi.mock('../../src/main/host/chat/compaction', () => ({ compactSessionNow: vi.fn() }));
vi.mock('../../src/main/host/chat/abort', () => ({ forceStopSession: vi.fn(() => false) }));
vi.mock('../../src/main/agents/next-request-stop', () => ({ requestNextRequestStop: vi.fn() }));

import {
  SNAPSHOT_FRAME_BYTE_BUDGET,
  _setSnapshotFrameByteBudgetForTests,
  trimMessagesForFrame,
} from '../../src/main/host/chat/snapshot-trim';
import { buildChatBindings } from '../../src/main/host/bindings/chat';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function message(id: string, content: string): Message {
  return {
    id,
    role: 'user',
    content,
    type: 'text',
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-08-23T00:00:00.000Z',
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

function chain(id: string, messages: readonly Message[]): Chain {
  return {
    id,
    sessionId: SESSION_ID,
    messages,
    status: 'completed',
    selection: null,
    modelLabel: null,
    agentName: 'seed',
    agentType: 'internal',
    agentTier: 'seed',
    subagentRecord: null,
    startTime: null,
    endTime: null,
    errorDetail: null,
    errorTitle: null,
  };
}

function sessionOf(chains: readonly Chain[]): Session {
  return {
    id: SESSION_ID,
    name: 'Snapshot trim session',
    selection: null,
    modelLabel: null,
    cwd: '/tmp/project',
    chains,
    activeChainId: null,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    subagentChains: [],
    todoStore: { tasks: [] },
    reasoningEffortOverride: null,
    tierOverride: null,
    permissionMode: null,
  };
}

function bytesOf(entry: Message): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

describe('trimMessagesForFrame (#25)', () => {
  it('keeps the whole history untouched under the budget', () => {
    const chains = [chain('chain-1', [
      message('m1', 'short'),
      message('m2', 'also short'),
    ])];
    const messages = chains[0]!.messages;

    const result = trimMessagesForFrame(messages, chains, 4096);

    expect(result.messages).toBe(messages);
    expect(result.trim).toBeNull();
  });

  it('keeps the newest messages that fit and emits a chain-accurate continuation cursor', () => {
    // Two chains: 3 large messages each (equal serialized sizes).
    const filler = 'x'.repeat(1000);
    const early = ['a1', 'a2', 'a3'].map((id) => message(id, filler));
    const recent = ['b1', 'b2', 'b3'].map((id) => message(id, filler));
    const chains = [chain('chain-early', early), chain('chain-recent', recent)];

    // Budget large enough for exactly the newest four messages.
    const budget = 4 * bytesOf(recent[0]!);
    const result = trimMessagesForFrame([...early, ...recent], chains, budget);

    expect(result.trim).not.toBeNull();
    expect(result.trim!.trimFromIndex).toBe(2);
    // The newest chain survives whole; the boundary sits in chain-early.
    expect(result.messages.map((entry) => entry.id)).toEqual(['a3', 'b1', 'b2', 'b3']);
    expect(result.trim!.historyBefore).toEqual({ chainId: 'chain-early', beforeIndex: 2 });

    // The kept slice fits the budget (per-message cost model; the array
    // envelope's brackets/commas ride the headroom under the frame cap)…
    expect(result.messages.reduce((total, entry) => total + bytesOf(entry), 0))
      .toBeLessThanOrEqual(budget);
    // …and the cursor is a valid session.history_page request for the session.
    expect(
      sessionHistoryPageSchema.safeParse({
        sessionId: SESSION_ID,
        chainId: result.trim!.historyBefore!.chainId,
        beforeIndex: result.trim!.historyBefore!.beforeIndex,
      }).success,
    ).toBe(true);
  });

  it('still keeps the newest message when a single one exceeds the whole budget', () => {
    const huge = ['h1', 'h2'].map((id) => message(id, 'y'.repeat(64 * 1024)));
    const chains = [chain('chain-1', huge)];

    const result = trimMessagesForFrame(huge, chains, 1024);

    expect(result.messages.map((entry) => entry.id)).toEqual(['h2']);
    expect(result.trim!.trimFromIndex).toBe(1);
    expect(result.trim!.historyBefore).toEqual({ chainId: 'chain-1', beforeIndex: 1 });
  });

  it('keeps live-tail in-flight messages and lands the cursor on the durable boundary', () => {
    const filler = 'z'.repeat(1000);
    const durable = ['d1', 'd2'].map((id) => message(id, filler));
    const chains = [chain('chain-1', durable)];
    // Live in-flight messages (not persisted in any chain) trail the durable
    // history; the kept suffix starts on a durable message, then goes live.
    const liveOnly = message('live-1', filler);
    const liveTail = message('live-2', filler);
    const messages = [durable[0]!, durable[1]!, liveOnly, liveTail];

    // Budget for the newest three: d2 + the two live messages.
    const budget = bytesOf(durable[1]!) + bytesOf(liveOnly) + bytesOf(liveTail);
    const result = trimMessagesForFrame(messages, chains, budget);

    expect(result.trim).not.toBeNull();
    expect(result.messages.map((entry) => entry.id)).toEqual(['d2', 'live-1', 'live-2']);
    expect(result.trim!.historyBefore).toEqual({ chainId: 'chain-1', beforeIndex: 1 });
  });

  it('returns a null cursor when the boundary message is live-only', () => {
    const filler = 'w'.repeat(1000);
    const dropped = [message('d1', filler), message('d2', filler)];
    const chains = [chain('chain-1', dropped)];
    const kept = [message('live-1', filler), message('live-2', filler)];

    // Budget for only the newest two (both live-only): d2 is dropped, so no
    // kept message can be located in a durable chain.
    const budget = bytesOf(kept[0]!) + bytesOf(kept[1]!);
    const result = trimMessagesForFrame([...dropped, ...kept], chains, budget);

    expect(result.messages.map((entry) => entry.id)).toEqual(['live-1', 'live-2']);
    expect(result.trim).not.toBeNull();
    expect(result.trim!.historyBefore).toBeNull();
  });

  it('rejects a budget at or above the wire frame cap', () => {
    expect(() => trimMessagesForFrame([], [], MAX_FRAME_BYTES)).toThrow(/frame cap/);
    expect(() => trimMessagesForFrame([], [], MAX_FRAME_BYTES + 1)).toThrow(/frame cap/);
  });

  it('keeps the default budget safely under the frame cap', () => {
    expect(SNAPSHOT_FRAME_BYTE_BUDGET).toBeLessThan(MAX_FRAME_BYTES);
    expect(SNAPSHOT_FRAME_BYTE_BUDGET).toBe(24 * 1024 * 1024);
  });
});

describe('chat.snapshot binding trimming (#25)', () => {
  afterEach(() => {
    _setSnapshotFrameByteBudgetForTests(null);
    mocks.session = null;
  });

  function chatSnapshotBinding() {
    const bindings = buildChatBindings();
    const binding = bindings.find(([method]) => method === 'chat.snapshot')?.[1];
    if (!binding) throw new Error('chat.snapshot binding missing');
    return binding as (
      ctx: { clientId: string },
      params: { sessionId?: string | null },
    ) => unknown | Promise<unknown>;
  }

  it('trims an oversized session to the frame budget and attaches a usable continuation cursor', async () => {
    const filler = 'q'.repeat(2048);
    const old = ['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => message(id, filler));
    const recent = ['r1', 'r2'].map((id) => message(id, filler));
    const chains = [chain('chain-old', old), chain('chain-recent', recent)];
    mocks.session = sessionOf(chains);
    // Budget for exactly the newest three messages (o5 + r1 + r2): the kept
    // suffix spans the chain boundary, so the cursor must name chain-old.
    _setSnapshotFrameByteBudgetForTests(3 * bytesOf(recent[0]!));

    const result = (await chatSnapshotBinding()({ clientId: '7' }, {})) as {
      sessionId: string;
      messages: Message[];
      live: unknown;
      trim: { trimFromIndex: number; historyBefore: { chainId: string; beforeIndex: number } };
    };

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.live).toBeNull();
    // The trimmed slice fits the budget (per-message cost model)…
    expect(result.messages.reduce((total, entry) => total + bytesOf(entry), 0))
      .toBeLessThanOrEqual(3 * bytesOf(recent[0]!));
    // …kept a strict suffix of the flattened history…
    expect(result.messages.map((entry) => entry.id)).toEqual(['o5', 'r1', 'r2']);
    // …dropped a non-empty prefix…
    expect(result.trim.trimFromIndex).toBe(4);
    // …and the cursor satisfies session.history_page params, landing inside
    // the older chain at the boundary message's index.
    expect(result.trim.historyBefore).toEqual({ chainId: 'chain-old', beforeIndex: 4 });
    const cursorOk = sessionHistoryPageSchema.safeParse({
      sessionId: SESSION_ID,
      chainId: result.trim.historyBefore.chainId,
      beforeIndex: result.trim.historyBefore.beforeIndex,
    });
    expect(cursorOk.success).toBe(true);
    // The whole result validates against the protocol/preload snapshot schema.
    expect(chatSessionSnapshotSchema.safeParse(result).success).toBe(true);
  });

  it('returns the full history with no trim marker when everything fits', async () => {
    const small = [message('s1', 'fits'), message('s2', 'easily')];
    mocks.session = sessionOf([chain('chain-1', small)]);
    _setSnapshotFrameByteBudgetForTests(6 * 1024);

    const result = (await chatSnapshotBinding()({ clientId: '7' }, {})) as {
      messages: Message[];
      trim?: unknown;
    };

    expect(result.messages.map((entry) => entry.id)).toEqual(['s1', 's2']);
    expect(result.trim).toBeUndefined();
    expect(chatSessionSnapshotSchema.safeParse(result).success).toBe(true);
  });

  it('answers null for a client with no active session (unchanged)', async () => {
    mocks.session = null;
    _setSnapshotFrameByteBudgetForTests(6 * 1024);
    expect(chatSnapshotBinding()({ clientId: '7' }, {})).toBeNull();
  });
});
