/**
 * U11 — host protocol parity harness.
 *
 * Runs ONE assertion set through BOTH client transports the Electron app uses
 * to reach a host (plan 2026-08-23-001; issue #112):
 *
 *   (a) in-process — `InProcessHostTransport` driving an embedded `HostServer`
 *       with zero-copy structured frames (the local machine's path).
 *   (b) daemon — a spawned node child running the real `bridgeStdioToSocket`
 *       (the `orchid-agent bridge` command) piping stdio to the server's real
 *       0600 UNIX socket over newline-delimited JSON (the remote machine's
 *       path, minus the ssh hop). The child is a real esbuild bundle of the
 *       daemon module, spawned exactly the way `orchid-agent bridge` runs.
 *
 * Both transports attach to the SAME HostServer behind the same core-service
 * seam as host-server.test.ts / host-turn-survival.test.ts (real SessionManager
 * on temp SQLite; mocked process singletons; the fake-provider fixture from
 * the host suites as the scripted turn). Because everything but the transport
 * is shared, any observable difference between the two runs is transport
 * divergence — the exact class of bug this harness exists to catch.
 *
 * Assertions per transport (defined once in `runParityScenario`): handshake,
 * chat send + streamed scripted turn + terminal event, tool.execute result
 * round-trip, session create + reopen showing persisted messages, subagent
 * snapshot, and pending approvals/questions via `host.pending_state` (with
 * byte-parity against the live delivery). The captured fingerprints are then
 * asserted equal modulo generated ids.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import { HOST_METHODS, PROTOCOL_VERSION, type HostMethodName } from '../../src/shared/host/protocol';

// Real-shaped tool-call uuids (8-hex base final group + 4-hex per-run suffix)
// so pending approvals and questions validate against the registry's schemas.
const APPROVAL_TOOL_BASE = 'aaaaaaaa-0000-4ccc-8ddd-00000000';
const QUESTION_TOOL_BASE = 'ffffffff-0000-4aaa-8bbb-00000000';
const mocks = vi.hoisted(() => {
  return {
    sessionManager: null as unknown,
    workspace: { cwd: null as string | null, status: 'unbound', source: 'unbound' },
    trustState: { current: 'untrusted' as 'trusted' | 'untrusted' | 'changed' },
    draftCwdByClient: new Map<string, string | null>(),
    runtimeConfig: null as unknown,
    configState: null as unknown,
  };
});

// ── Core service mocks (same seam as host-turn-survival.test.ts) ─────────────

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: (clientId: string) => ({
    cwd: mocks.draftCwdByClient.get(clientId) ?? mocks.workspace.cwd,
    source: mocks.workspace.source,
    status: mocks.workspace.status,
  }),
  resolveBoundProjectPath: (clientId?: string) =>
    mocks.draftCwdByClient.get(clientId ?? '') ?? mocks.workspace.cwd,
}));

vi.mock('../../src/main/project/workspace', () => ({
  isWorkspaceBound: (info: { status?: string }) => info?.status === 'valid',
  getDraftCwd: (owner: string) => mocks.draftCwdByClient.get(owner) ?? null,
  setDraftCwd: (owner: string, cwd: string) => void mocks.draftCwdByClient.set(owner, cwd),
  clearDraftCwd: (owner: string) => void mocks.draftCwdByClient.delete(owner),
  requireValidProjectDirectory: (dir: string) => fs.realpathSync(dir),
  updateStickyDefaultProjectDir: vi.fn(async () => {}),
  resolveWorkspace: (owner: string, opts: { sessionCwd: string | null; stickyDefault: string | null }) => ({
    cwd: opts.sessionCwd ?? opts.stickyDefault,
    source: opts.sessionCwd ? 'session' : 'default',
    status: opts.sessionCwd ?? opts.stickyDefault ? 'valid' : 'unbound',
  }),
}));

vi.mock('../../src/main/project/path', () => ({
  canonicalizeProjectDirectory: (dir: string) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return null;
    }
  },
  inspectProjectDirectory: (dir: string) => ({
    status: fs.existsSync(dir) ? 'valid' : 'missing',
    path: dir,
  }),
}));

vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => mocks.trustState.current,
  grantProjectTrust: vi.fn(),
  revokeProjectTrust: vi.fn(),
  revokeProjectTrustRaw: vi.fn(),
  buildProjectTrustReport: vi.fn(() => null),
  listTrustedProjects: vi.fn(() => []),
  resetProjectTrustStore: vi.fn(),
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    get: (cwd: string) => ({
      projectDir: cwd,
      config: mocks.runtimeConfig,
      agents: new Map(),
      skills: new Map(),
      personalities: new Map(),
      sharedPrompts: { 'all-agents': null, subagents: null },
    }),
    invalidate: vi.fn(() => true),
  }),
  clearProjectRuntimeRegistry: vi.fn(),
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => mocks.configState,
  };
});

vi.mock('../../src/main/mcp/project-registry', () => ({
  getProjectMCPManager: () => ({ getTools: () => [], getStatus: () => [] }),
  acquireProjectMCPManager: vi.fn(() => ({ getTools: () => [] })),
  releaseProjectMCPManager: vi.fn(),
  invalidateProjectMCPManagers: vi.fn(),
  invalidateAllProjectMCPManagers: vi.fn(),
  shutdownProjectMCPManagers: vi.fn(async () => {}),
}));

vi.mock('../../src/main/rag/indexer', () => ({
  indexProject: vi.fn(async () => ({
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0, filesDeleted: 0,
    chunksCreated: 0, errors: [], durationSeconds: 0,
  })),
  getStatus: vi.fn(() => ({
    totalChunks: 0, totalFiles: 0, lastIndexed: null, lastIndexDuration: null, lastAutoRefresh: null,
  })),
  clearIndex: vi.fn(),
  cancelIndex: vi.fn(async () => false),
  isIndexing: vi.fn(() => false),
}));

vi.mock('../../src/main/ast/indexer', () => ({
  indexProject: vi.fn(async () => ({
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0, filesDeleted: 0,
    symbolsExtracted: 0, errors: [], durationSeconds: 0,
  })),
  isIndexing: vi.fn(() => false),
}));

vi.mock('../../src/main/ast/store', () => ({
  ASTStore: class {
    status() {
      return { totalFiles: 0, totalSymbols: 0, lastIndexed: null, lastIndexDuration: null, lastAutoRefresh: null };
    }
    dispose() {}
  },
}));

vi.mock('../../src/main/indexing/watcher', () => ({
  attachWorkspaceWatcher: vi.fn(),
  detachWorkspaceWatcher: vi.fn(),
  ensureWorkspaceWatcherStarted: vi.fn(),
  reconfigureWorkspaceWatchers: vi.fn(),
  getWorkspaceWatcherState: vi.fn(() => ({ watching: false })),
  disposeAllWorkspaceWatchers: vi.fn(),
}));

vi.mock('../../src/main/indexing/refresh-coordinator', () => ({
  setIndexAutoRefreshNotifier: vi.fn(),
  cancelProjectRefresh: vi.fn(),
  cancelProjectRefreshAsync: vi.fn(async () => {}),
  disposeIndexRefreshCoordinatorAsync: vi.fn(async () => {}),
  markDirty: vi.fn(),
}));

vi.mock('../../src/main/tools', () => ({
  toolRegistry: {
    get: vi.fn(() => undefined),
    listAll: vi.fn(() => []),
  },
  getSubagentManager: () => ({
    getStates: () => [],
    recordsForSession: () => [],
    allRecords: () => [],
    isSummary: () => true,
    toDomainRecord: () => null,
    getSessionRevision: () => 0,
    getLiveProjections: () => [],
    getRecord: () => null,
    addOnChangeListener: vi.fn(() => () => {}),
    setOnDelta: vi.fn(),
    setOnChange: vi.fn(),
    setRunner: vi.fn(),
    discardSession: vi.fn(),
    trackedPersistenceSessions: () => [],
    cancelRunning: () => [],
  }),
  setTodosChangedNotifier: vi.fn(),
  getSkillsRegistry: () => new Map(),
  getBuiltinToolRegistryForRuntime: vi.fn(() => null),
  createBuiltinToolRegistry: vi.fn(() => null),
  registerBuiltinTools: vi.fn(),
}));

vi.mock('../../src/main/session/working-set-live', () => ({
  setWorkingSetBroadcast: vi.fn(),
  bootstrapWorkingSet: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
  filterIfCatalogOk: vi.fn(() => ({
    snapshot: { openSessionIds: [], focusedSessionId: null },
    membershipChanged: false,
  })),
  tryListSessionCatalog: vi.fn(() => ({ status: 'ok', ids: new Set() })),
  mutateAndPersist: vi.fn((_owner: string, run: () => unknown) => run()),
  workingSetOpenOrFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
  workingSetRemove: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
  workingSetClearFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
}));

vi.mock('../../src/main/session/working-set', () => ({
  sessionWorkingSet: {
    getSnapshot: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    setFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    close: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    openOrFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    remove: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    filterExisting: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    loadFromDisk: vi.fn(),
    saveToDisk: vi.fn(),
  },
}));

vi.mock('../../src/main/agents/wire-subagents', () => ({
  setSubagentsChangedBroadcast: vi.fn(),
  flushSubagentPersistence: vi.fn(),
  disposeSubagentPersistence: vi.fn(),
  wireSubagentRuntime: vi.fn(),
}));

vi.mock('../../src/main/agents/subagent-events', () => ({
  setSubagentDeltaDelivery: vi.fn(),
  queueSubagentDelta: vi.fn(),
  flushSubagentDeltas: vi.fn(),
}));

vi.mock('../../src/main/llm/tool-dispatch', async () => {
  // Mirror the real genericTerminalExecution (llm/terminal-result.ts): a
  // FLAT ToolExecutionResult {canonical, agentProjection} built through the
  // real canonical builder, so the registry-schema validation below sees the
  // exact wire shape production emits.
  const { createCanonicalToolResult } = await import('../../src/shared/types/tool-result');
  return {
    executeToolCall: vi.fn(async () => ({ ok: true })),
    genericTerminalExecution: vi.fn(
      (_id: string, name: string, status: 'error' | 'cancelled', message: string, code: string) => ({
        canonical: status === 'error'
          ? createCanonicalToolResult('generic', {
              status,
              data: { value: message, origin: { kind: 'built-in', name } },
              error: { code, message },
            })
          : createCanonicalToolResult('generic', {
              status,
              data: { value: message, origin: { kind: 'built-in', name } },
            }),
        agentProjection: { content: message, completeness: 'complete' as const },
      }),
    ),
  };
});

// The fake provider fixture shared with host-turn-survival.test.ts: a scripted
// two-chunk turn that finishes cleanly (the gate stays null here — no
// mid-stream disconnect in the parity matrix).
vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: vi.fn(async function* () {
    yield { type: 'content', text: 'partial' };
    yield { type: 'content', text: ' finished-on-host' };
    yield { type: 'finish', finishReason: 'stop' };
  }),
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => ({
    resolveTierContext: vi.fn(async () => ({ connection: { cacheTtl: null }, tierMechanism: undefined })),
    resolveExecution: vi.fn(async () => ({
      modelInstance: {},
      snapshot: { providerId: 'fake-provider', protocol: 'openai' },
      pricingFacet: undefined,
      thinkingPolicy: undefined,
      cacheFacet: undefined,
      tierMechanism: undefined,
      buildReasoningOptions: undefined,
      model: { limits: null, capabilities: {} },
      connection: { cacheTtl: null },
    })),
  }),
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: vi.fn(() => ({})),
}));

vi.mock('../../src/main/providers/views', () => ({
  overview: vi.fn(async () => ({ definitions: [], connections: [], statuses: [], secureStorage: { available: false, backend: null, reason: 'unavailable' } })),
  validateConnection: vi.fn(async () => ({})),
  disableConnection: vi.fn(async () => ({})),
  enableConnection: vi.fn(async () => ({})),
  disconnectConnection: vi.fn(async () => ({})),
  deleteConnection: vi.fn(async () => ({})),
  discoverModels: vi.fn(async () => ({})),
  listModelOptions: vi.fn(async () => []),
  refreshQuota: vi.fn(async () => null),
  refreshStatus: vi.fn(async () => null),
  statusView: vi.fn(() => null),
  withConnectionMutationLock: vi.fn((_id: string, task: () => unknown) => Promise.resolve().then(task)),
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { createHostServer, type HostServer } from '../../src/main/host/server';
import { serveSocket } from '../../src/main/host/daemon';
import { createInProcessTransport } from '../../src/main/host/transport-inprocess';
import { createHostClient, type HostClient } from '../../src/main/host/client';
import type { HostTransport, StructuredHostTransport } from '../../src/main/host/transport';
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';
import { activeAgents } from '../../src/main/host/chat/state';
import { approvalStore } from '../../src/main/permissions/approval-store';
import { questionStore } from '../../src/main/tools/ask-question/store';

const SELECTION = { connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'fake/model' };
const EXPECTED_TURN_TEXT = 'partial finished-on-host';

/** Everything the scenario captures; deep-compared across transports. */
interface ScenarioFingerprint {
  chatSend: unknown;
  streamedChunks: string[];
  chatDoneResponse: string;
  chatStateSequence: string[];
  reopenedMessageCount: number;
  reopenedContent: string;
  reopenedLastChainStatus: string;
  toolExecute: unknown;
  subagentSnapshot: unknown;
  pendingApprovals: unknown[];
  pendingQuestions: unknown[];
  pendingApprovalMatchesLiveDelivery: boolean;
  pendingQuestionMatchesLiveDelivery: boolean;
  pendingOwnerStripped: boolean;
  /** HOST_METHODS result-schema violations for every exercised method. */
  schemaValidationErrors: string[];
}

// ── Registry-schema validation ───────────────────────────────────────────────

/**
 * Validate one response's post-normalization result (the client returns the
 * envelope's `result` verbatim; the server already normalized undefined →
 * null) against the method's HOST_METHODS result schema. Returns a failure
 * description, or null when the wire value conforms — so binding-vs-registry
 * drift fails the harness instead of silently widening.
 */
function validateResult(method: HostMethodName, result: unknown): string | null {
  const parsed = HOST_METHODS[method].result.safeParse(result);
  return parsed.success ? null : `${method} result failed its registry schema: ${parsed.error.message}`;
}

// ── Fingerprint masking (generated ids differ between runs) ──────────────────

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function maskDynamic(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return '<uuid>';
    if (ISO_RE.test(value)) return '<timestamp>';
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(maskDynamic);
  if (typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) out[key] = maskDynamic(entry);
    return out;
  }
  return String(value);
}

// ── Stdio transport over the spawned bridge child (the daemon path) ─────────

/** JSON-line transport over a spawned `orchid-agent bridge` child's stdio. */
class StdioChildTransport implements HostTransport {
  private buffer = '';
  private dataCallback: ((line: string) => void) | null = null;
  private readonly closeCallbacks: Array<() => void> = [];
  private closed = false;
  stderrText = '';

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) this.dataCallback?.(line);
        index = this.buffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrText += chunk;
    });
    child.on('exit', () => this.fireClose());
    child.on('error', () => this.fireClose());
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of this.closeCallbacks.splice(0)) callback();
  }

  write(line: string): void {
    if (this.closed) return;
    this.child.stdin?.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  onData(cb: (line: string) => void): void {
    this.dataCallback = cb;
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.child.stdin?.end();
    this.child.kill();
    this.fireClose();
  }
}

// ── Raw handshake capture (one-shot, before the HostClient takes the wire) ──

interface HelloObservation {
  readonly protocolVersion: number;
  readonly capabilities: string[];
}

/**
 * Send `host.hello` directly over a transport and capture the advertised
 * protocol version + capabilities. Runs before the scenario's HostClient
 * installs its callbacks on the same transport.
 */
function helloOverTransport(transport: HostTransport): Promise<HelloObservation> {
  const structured = (
    'onFrame' in transport && 'writeFrame' in transport
      ? (transport as StructuredHostTransport)
      : null
  );
  return new Promise<HelloObservation>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('host.hello never answered over the transport')),
      15_000,
    );
    const handle = (frame: unknown): void => {
      const record = frame as
        | { id?: unknown; ok?: boolean; result?: { protocolVersion?: number; capabilities?: string[] } }
        | undefined;
      if (record?.id !== 'parity-hello' || record.ok === undefined) return;
      clearTimeout(timer);
      if (record.ok !== true) {
        reject(new Error('host.hello was rejected'));
        return;
      }
      resolve({
        protocolVersion: record.result?.protocolVersion ?? -1,
        capabilities: [...(record.result?.capabilities ?? [])].sort(),
      });
    };
    if (structured) structured.onFrame(handle);
    else transport.onData((line) => {
      try {
        handle(JSON.parse(line));
      } catch {
        // Non-JSON noise; the matching frame arrives later.
      }
    });
    const frame = { id: 'parity-hello', method: 'host.hello', params: { protocolVersion: PROTOCOL_VERSION } };
    if (structured) structured.writeFrame(frame);
    else transport.write(JSON.stringify(frame));
  });
}

// ── The shared assertion set ─────────────────────────────────────────────────

/**
 * Run the full parity scenario through one client. Everything captured must be
 * observably identical whichever transport the client rides.
 */
async function runParityScenario(label: string, client: HostClient): Promise<ScenarioFingerprint> {
  const chunks: string[] = [];
  const states: string[] = [];
  let doneResponse = '';
  const approvalToolCallId = `${APPROVAL_TOOL_BASE}${label === 'in-process' ? '0001' : '0002'}`;
  const questionToolCallId = `${QUESTION_TOOL_BASE}${label === 'in-process' ? '0001' : '0002'}`;
  let liveApprovalPayload: unknown = null;
  let liveQuestionPayload: unknown = null;
  const schemaValidationErrors: string[] = [];
  const checkResult = (method: HostMethodName, result: unknown): void => {
    const failure = validateResult(method, result);
    if (failure) schemaValidationErrors.push(failure);
  };

  const doneSeen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: chat:done never arrived`)), 20_000);
    const offDone = client.subscribe('chat:done', (params) => {
      doneResponse = (params as { response?: string }).response ?? '';
      clearTimeout(timer);
      offDone();
      resolve();
    });
  });
  const offChunk = client.subscribe('chat:chunk', (params) => {
    chunks.push((params as { data?: string }).data ?? '');
  });
  const offState = client.subscribe('chat:state', (params) => {
    states.push(String((params as { state?: string }).state ?? ''));
  });
  const offApproval = client.subscribe('permission:approval_requested', (params) => {
    if ((params as { toolCallId?: string }).toolCallId === approvalToolCallId) {
      liveApprovalPayload = params;
    }
  });
  const offAsked = client.subscribe('ask_question:asked', (params) => {
    if ((params as { toolCallId?: string }).toolCallId === questionToolCallId) {
      liveQuestionPayload = params;
    }
  });

  try {
    // Session create + open (the client becomes the session's active owner).
    const session = await client.request<{ id: string }>('session.create');
    checkResult('session.create', session);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    const opened = await client.request<{ session: unknown }>('session.open', { id: session.id });
    checkResult('session.open', opened);
    expect(opened).toBeTruthy();

    // Chat send + stream the scripted (fake provider) turn.
    const chatSend = await client.request('chat.send', {
      message: 'parity scripted turn',
      sessionId: session.id,
    });
    checkResult('chat.send', chatSend);
    expect(chatSend).toMatchObject({ status: 'started' });
    await doneSeen;
    // Belt and braces: the turn is fully settled host-side.
    await vi.waitFor(
      () => expect(activeAgents.get(session.id)).toBeUndefined(),
      { timeout: 10_000 },
    );
    expect(chunks.join('')).toBe(EXPECTED_TURN_TEXT);

    // Tool result round-trip: renderer-allowed name, absent from the
    // (mocked) registry — a deterministic canonical envelope.
    const toolExecute = await client.request('tool.execute', { name: 'read', args: { path: '/x' } });
    checkResult('tool.execute', toolExecute);
    expect((toolExecute as { canonical?: { status?: string; error?: { code?: string } } })
      .canonical).toMatchObject({ status: 'error', error: { code: 'unknown_tool' } });

    // Subagent snapshot for the fresh session (no subagents ran; the live
    // projection array is empty for a fresh session).
    const subagentSnapshot = await client.request<{ live?: unknown }>('subagents.snapshot', { sessionId: session.id });
    checkResult('subagents.snapshot', subagentSnapshot);
    expect(subagentSnapshot).toMatchObject({ sessionId: session.id, records: [] });
    expect(Object.keys(subagentSnapshot.live ?? {}).length).toBe(0);

    // Pending approvals/questions: created host-side (the owner-routing seam
    // is the store, not the transport), then read back over the wire.
    void approvalStore.create(
      approvalToolCallId,
      session.id,
      'write',
      'mutation',
      { path: 'parity' },
      mocks.workspace.cwd as string,
    );
    void questionStore.create(questionToolCallId, session.id, [
      { type: 'single', title: 'Parity?', options: [{ label: 'Yes' }] },
    ]);
    const pending = await client.request<{ approvals: unknown[]; questions: unknown[] }>(
      'host.pending_state',
      { sessionId: session.id },
    );
    checkResult('host.pending_state', pending);
    expect(pending.approvals).toHaveLength(1);
    expect(pending.questions).toHaveLength(1);
    const pendingApproval = pending.approvals[0] as Record<string, unknown>;
    const pendingQuestion = pending.questions[0] as Record<string, unknown>;
    const ownerStripped =
      !('ownerClientId' in pendingApproval) && !('ownerClientId' in pendingQuestion);
    // The pending ids are run-scoped (fixed uuids would collide in the shared
    // stores across the two scenario runs); normalize them for the fingerprint.
    const normalizePending = (payload: Record<string, unknown>): Record<string, unknown> => ({
      ...payload,
      toolCallId: '<pending-id>',
    });

    // Reopen: persisted messages survive and show the finished turn.
    const reopened = await client.request<{
      messages: Array<{ role: string; content: string }>;
      session: { chains: Array<{ status: string }> };
    }>('session.open', { id: session.id });
    checkResult('session.open', reopened);
    const content = reopened.messages.map((message) => message.content).join('');

    return {
      chatSend,
      streamedChunks: chunks,
      chatDoneResponse: doneResponse,
      chatStateSequence: states,
      reopenedMessageCount: reopened.messages.length,
      reopenedContent: content,
      reopenedLastChainStatus: reopened.session.chains.at(-1)?.status ?? '',
      toolExecute,
      subagentSnapshot,
      pendingApprovals: [normalizePending(pendingApproval)],
      pendingQuestions: [normalizePending(pendingQuestion)],
      pendingApprovalMatchesLiveDelivery:
        JSON.stringify(pendingApproval) === JSON.stringify(liveApprovalPayload),
      pendingQuestionMatchesLiveDelivery:
        JSON.stringify(pendingQuestion) === JSON.stringify(liveQuestionPayload),
      pendingOwnerStripped: ownerStripped,
      schemaValidationErrors,
    };
  } finally {
    offChunk();
    offState();
    offApproval();
    offAsked();
  }
}

// ── World setup + dual-transport execution ───────────────────────────────────

let tmpRoot: string;
let socketPath: string;
let netServerClose: (() => Promise<void>) | null = null;
let server: HostServer;
let inprocFingerprint: ScenarioFingerprint | null = null;
let daemonFingerprint: ScenarioFingerprint | null = null;
let inprocHello: HelloObservation | null = null;
let daemonHello: HelloObservation | null = null;
let bridgeBundlePath = '';

/** Build the real `orchid-agent bridge` bundle (host-daemon-transport pattern). */
function buildBridgeBundle(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const esbuild = require('esbuild') as typeof import('esbuild');
  const distDir = path.resolve(__dirname, '..', '..', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const entry = path.join(distDir, `parity-bridge-entry-${process.pid}.js`);
  const outfile = path.join(distDir, `parity-bridge-bundle-${process.pid}.js`);
  const daemonSource = path.resolve(__dirname, '../../src/main/host/daemon.ts');
  fs.writeFileSync(
    entry,
    `const { bridgeStdioToSocket } = require(${JSON.stringify(daemonSource)});\n` +
      `bridgeStdioToSocket(process.argv[2]).catch((error) => { console.error(error); process.exit(1); });\n`,
  );
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    outfile,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'node-pty', 'onnxruntime-node', '@huggingface/tokenizers'],
  });
  fs.rmSync(entry, { force: true });
  return outfile;
}

describe('host protocol parity (U11)', () => {
  beforeAll(async () => {
    // World: one HostServer on a real temp SessionManager behind the mock
    // seam, served over a real 0600 socket — both transports attach to it.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-host-parity-'));
    _clearDbCache();
    mocks.sessionManager = new SessionManager({ storage: { dbPath: path.join(tmpRoot, 'sessions.db') } });
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    mocks.workspace.cwd = projectDir;
    mocks.workspace.status = 'valid';
    mocks.workspace.source = 'default';
    mocks.trustState.current = 'trusted';
    mocks.draftCwdByClient.clear();
    mocks.runtimeConfig = {
      ...defaults,
      default_model: SELECTION,
      session_title_max_wait_seconds: 0,
    } as unknown;
    mocks.configState = { ...defaults } as unknown;
    approvalStore.cleanupAll();
    questionStore.cleanupAll();

    server = createHostServer({ serverVersion: 'parity' });
    socketPath = path.join(tmpRoot, 'daemon.sock');
    const netServer = await serveSocket(socketPath, { server });
    netServerClose = () =>
      new Promise<void>((resolve) => netServer.close(() => resolve()));

    // (a) In-process transport (the local embedded host path).
    const inprocTransport = createInProcessTransport({ server, clientId: 'parity-inproc' });
    inprocHello = await helloOverTransport(inprocTransport);
    const inprocClient = createHostClient(inprocTransport, {
      clientId: 'parity-inproc',
      label: 'parity:in-process',
    });
    try {
      inprocFingerprint = await runParityScenario('in-process', inprocClient);
    } finally {
      inprocClient.close();
    }

    // (b) Daemon transport: a spawned `orchid-agent bridge` child piping
    //     stdio to the socket (the remote path, minus ssh).
    bridgeBundlePath = buildBridgeBundle();
    const child = spawn(process.execPath, [bridgeBundlePath, socketPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const daemonTransport = new StdioChildTransport(child);
    daemonHello = await helloOverTransport(daemonTransport);
    const daemonClient = createHostClient(daemonTransport, {
      clientId: 'parity-daemon',
      label: 'parity:daemon',
    });
    try {
      daemonFingerprint = await runParityScenario('daemon', daemonClient);
    } finally {
      daemonClient.close();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  }, 120_000);

  afterAll(async () => {
    approvalStore.cleanupAll();
    questionStore.cleanupAll();
    server?.dispose();
    await netServerClose?.();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (bridgeBundlePath) fs.rmSync(bridgeBundlePath, { force: true });
    _clearDbCache();
  });

  it('captured a fingerprint from both transports', () => {
    expect(inprocFingerprint).not.toBeNull();
    expect(daemonFingerprint).not.toBeNull();
  });

  it('every exercised method result validates against its HOST_METHODS registry schema', () => {
    // Binding-vs-registry drift guard (finding #7/#10): the actual
    // post-normalization wire values must satisfy the declared result
    // schemas on both transports.
    expect(inprocFingerprint?.schemaValidationErrors ?? ['in-process fingerprint missing']).toEqual([]);
    expect(daemonFingerprint?.schemaValidationErrors ?? ['daemon fingerprint missing']).toEqual([]);
  });

  it('handshakes identically over both transports', () => {
    expect(inprocHello).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ['config.write', 'providers.read'],
    });
    expect(daemonHello).toEqual(inprocHello);
  });

  it('streams the scripted chat turn identically', () => {
    expect(inprocFingerprint?.streamedChunks.join('')).toBe(EXPECTED_TURN_TEXT);
    expect(daemonFingerprint?.streamedChunks.join('')).toBe(EXPECTED_TURN_TEXT);
    expect(daemonFingerprint?.streamedChunks).toEqual(inprocFingerprint?.streamedChunks);
    expect(daemonFingerprint?.chatDoneResponse).toContain('finished-on-host');
    expect(daemonFingerprint?.chatDoneResponse).toBe(inprocFingerprint?.chatDoneResponse);
    // chat.send result: same status/shape, generated session/turn ids masked.
    expect(maskDynamic(daemonFingerprint?.chatSend)).toEqual(maskDynamic(inprocFingerprint?.chatSend));
  });

  it('delivers the same chat state sequence over both transports', () => {
    expect(inprocFingerprint?.chatStateSequence.length).toBeGreaterThan(0);
    expect(daemonFingerprint?.chatStateSequence).toEqual(inprocFingerprint?.chatStateSequence);
  });

  it('round-trips the tool.execute result envelope identically', () => {
    expect(daemonFingerprint?.toolExecute).toEqual(inprocFingerprint?.toolExecute);
  });

  it('persists and reopens the session identically (messages + chain status)', () => {
    for (const fingerprint of [inprocFingerprint, daemonFingerprint]) {
      expect(fingerprint?.reopenedMessageCount).toBeGreaterThanOrEqual(2);
      expect(fingerprint?.reopenedContent).toContain(EXPECTED_TURN_TEXT);
      expect(fingerprint?.reopenedLastChainStatus).toBe('completed');
    }
    expect(maskDynamic(daemonFingerprint?.reopenedContent)).toBe(
      maskDynamic(inprocFingerprint?.reopenedContent),
    );
  });

  it('returns an identical subagent snapshot over both transports', () => {
    expect(daemonFingerprint?.subagentSnapshot).toMatchObject({ records: [] });
    expect(maskDynamic(daemonFingerprint?.subagentSnapshot)).toEqual(
      maskDynamic(inprocFingerprint?.subagentSnapshot),
    );
  });

  it('exposes pending approvals/questions via host.pending_state identically', () => {
    for (const fingerprint of [inprocFingerprint, daemonFingerprint]) {
      expect(fingerprint?.pendingApprovals).toHaveLength(1);
      expect(fingerprint?.pendingQuestions).toHaveLength(1);
      // The resync payload is byte-identical to the live delivery…
      expect(fingerprint?.pendingApprovalMatchesLiveDelivery).toBe(true);
      expect(fingerprint?.pendingQuestionMatchesLiveDelivery).toBe(true);
      // …and owner fields never cross the wire.
      expect(fingerprint?.pendingOwnerStripped).toBe(true);
    }
    expect(maskDynamic(daemonFingerprint?.pendingApprovals)).toEqual(
      maskDynamic(inprocFingerprint?.pendingApprovals),
    );
    expect(maskDynamic(daemonFingerprint?.pendingQuestions)).toEqual(
      maskDynamic(inprocFingerprint?.pendingQuestions),
    );
  });

  it('full fingerprints match across transports modulo generated ids', () => {
    expect(maskDynamic(daemonFingerprint)).toEqual(maskDynamic(inprocFingerprint));
  });
});
