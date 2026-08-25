/**
 * Host protocol contract tests (plan U2): every registered method and event
 * round-trips a representative payload through its zod schema, unknown names
 * miss the registries, the handshake accepts equal versions and produces a
 * typed PROTOCOL_MISMATCH on mismatch, and the envelope guards discriminate.
 *
 * Fixtures mirror the minimal valid shapes the referenced IPC schemas accept;
 * params/results REUSE the IPC schemas, so these fixtures double as parity
 * checks between the protocol registry and the IPC boundary.
 */
import { describe, expect, it } from 'vitest';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import {
  ALLOWED_EVENT_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
} from '../../src/shared/types/ipc';
import {
  HOST_CAPABILITIES,
  HOST_ERROR_CODES,
  HOST_EVENTS,
  HOST_HELLO_METHOD,
  HOST_METHODS,
  HostProtocolError,
  PROTOCOL_VERSION,
  assertProtocolVersionMatches,
  channelToMethod,
  hostErrorPayloadSchema,
  hostEventSchema,
  hostHelloParamsSchema,
  hostHelloResultSchema,
  hostMessageSchema,
  hostRequestSchema,
  hostResponseSchema,
  isHostEvent,
  isHostRequest,
  isHostResponse,
  lookupHostEvent,
  lookupHostMethod,
  methodToChannel,
} from '../../src/shared/host/protocol';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TOOL_CALL_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_DIR = '/tmp/orchid-host-protocol-project';
const CHAIN_ID = 'chain-1';
const TURN_ID = 'turn-1';

const workspace = {
  cwd: PROJECT_DIR,
  source: 'session',
  status: 'valid',
  trust: 'trusted',
};

const workingSet = {
  openSessionIds: [SESSION_ID],
  focusedSessionId: SESSION_ID,
  mruSessionIds: [],
};

const sessionEnvelope = {
  id: SESSION_ID,
  name: 'Host protocol session',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

const activity = {
  sessionId: SESSION_ID,
  cwd: PROJECT_DIR,
  state: 'working',
  phase: 'agent',
  detail: null,
  startedAt: 1,
  updatedAt: 2,
  completedAt: null,
  unread: false,
  backgroundProcessCount: 0,
  canCancel: true,
};

const askedEvent = {
  sessionId: SESSION_ID,
  toolCallId: TOOL_CALL_ID,
  questions: [
    {
      type: 'single',
      title: 'Continue?',
      options: [{ label: 'Yes' }],
    },
  ],
};

const approvalRequested = {
  toolCallId: TOOL_CALL_ID,
  sessionId: SESSION_ID,
  toolName: 'write',
  riskClass: 'mutation',
  args: { path: '/tmp/orchid-host-protocol-project/README.md' },
  cwd: PROJECT_DIR,
};

const managedSkill = {
  name: 'code-review',
  description: 'Review the working diff',
  requires: [],
  content: 'Review carefully.',
  resources: [],
  scope: 'global',
  path: '/home/u/.orchid/skills/code-review/SKILL.md',
  overriddenByProject: false,
};

const managedAgent = {
  name: 'reviewer',
  type: 'subagent',
  tier: 'bloom',
  description: 'Reviews changes',
  system_prompt: 'You review changes.',
  allowed_tools: ['read'],
  allowed_skills: [],
  scope: 'global',
  path: '/home/u/.orchid/agents/reviewer/AGENT.md',
  overriddenByProject: false,
};

const modelView = {
  id: 'gpt-4o',
  displayName: 'GPT-4o',
  protocol: 'openai-compatible',
  lifecycle: null,
  source: 'catalog',
  capabilities: null,
  limits: null,
};

const connectionView = {
  id: CONNECTION_ID,
  providerId: 'openai',
  providerDisplayName: 'OpenAI',
  name: 'Work',
  protocol: 'openai-compatible',
  authMethod: 'environment',
  credentialKind: 'environment',
  environmentVariable: 'OPENAI_API_KEY',
  modelIds: ['gpt-4o'],
  customModels: [],
  health: 'ready',
  activeTurnCount: 0,
  endpoint: null,
  allowInsecureHttp: false,
};

const providerOverview = {
  definitions: [],
  connections: [connectionView],
  statuses: [],
  secureStorage: { available: false, backend: null, reason: 'unavailable' },
};

const providerMutation = { connection: connectionView, message: null };

const toolResult = {
  canonical: createCanonicalToolResult('generic', {
    status: 'complete',
    data: { value: 'ok' },
  }),
  agentProjection: { content: 'ok', completeness: 'complete' },
};

const METHOD_FIXTURES: Record<string, { params: unknown; result: unknown }> = {
  'host.hello': {
    params: { protocolVersion: PROTOCOL_VERSION, clientId: 'window-1' },
    result: {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '0.1.0',
      capabilities: [HOST_CAPABILITIES.CONFIG_WRITE],
    },
  },
  'host.pending_state': {
    params: { sessionId: SESSION_ID },
    result: {
      approvals: [approvalRequested],
      questions: [askedEvent],
      // #19: the reconnect catch-up's session scoping rides along so resync
      // never needs a full chat.snapshot round-trip.
      activeSession: {
        sessionId: SESSION_ID,
        live: { state: 'streaming', startedAt: 1721875200000 },
      },
    },
  },
  'chat.send': {
    params: { message: 'hello' },
    result: { status: 'started', sessionId: SESSION_ID, turnId: TURN_ID },
  },
  'chat.cancel': { params: {}, result: { status: 'cancelled' } },
  'chat.queue_next': { params: { sessionId: SESSION_ID }, result: null },
  'chat.stop': { params: { sessionId: SESSION_ID }, result: { status: 'stopped' } },
  'chat.snapshot': {
    params: {},
    result: { sessionId: SESSION_ID, messages: [], live: null },
  },
  'chat.compact': {
    params: {},
    result: { status: 'compacted', sessionId: SESSION_ID },
  },
  'subagents.snapshot': {
    params: { sessionId: SESSION_ID },
    result: { sessionId: SESSION_ID, sessionRevision: 0, records: [], live: [] },
  },
  'subagents.detail': {
    params: { sessionId: SESSION_ID, subagentId: 'sa-1' },
    result: { sessionId: SESSION_ID, subagentId: 'sa-1', record: null },
  },
  'session.list': {
    params: undefined,
    result: [
      {
        id: SESSION_ID,
        name: 'Host protocol session',
        modelLabel: 'GPT-4o',
        cwd: PROJECT_DIR,
        chainCount: 1,
        updatedAt: 1,
      },
    ],
  },
  'session.load': { params: { id: SESSION_ID }, result: sessionEnvelope },
  'session.open': {
    params: { id: SESSION_ID },
    result: {
      session: sessionEnvelope,
      messages: [],
      live: null,
      workspace,
      lastChainError: null,
    },
  },
  'session.history_page': {
    params: { sessionId: SESSION_ID, chainId: CHAIN_ID },
    result: {
      sessionId: SESSION_ID,
      chainId: CHAIN_ID,
      messages: [],
      startIndex: 0,
      totalMessages: 0,
      complete: true,
    },
  },
  'session.create': { params: undefined, result: sessionEnvelope },
  'session.clear_active': { params: undefined, result: { status: 'cleared' } },
  'session.delete': {
    params: { id: SESSION_ID },
    result: { status: 'deleted', workingSet },
  },
  'session.rename': {
    params: { id: SESSION_ID, name: 'Renamed' },
    result: { status: 'renamed' },
  },
  'session.change_model': {
    params: { id: SESSION_ID, selection: null, modelLabel: null },
    result: { status: 'changed', selection: null, modelLabel: null },
  },
  'session.get_workspace': { params: undefined, result: workspace },
  'session.set_workspace': { params: { cwd: PROJECT_DIR }, result: workspace },
  'session.pick_project_dir': { params: undefined, result: workspace },
  'session.change_cwd': {
    params: { id: SESSION_ID, cwd: PROJECT_DIR },
    result: sessionEnvelope,
  },
  'session.set_reasoning_effort': {
    params: { effort: 'high' },
    result: { status: 'ok' },
  },
  'session.set_service_tier': {
    params: { tier: 'priority' },
    result: { status: 'ok' },
  },
  'session.get_reasoning_config': {
    params: { selection: { connectionId: CONNECTION_ID, modelId: 'o3' } },
    result: {
      levels: ['low', 'medium', 'high'],
      default: 'medium',
      override: 'high',
      supportsReasoning: true,
    },
  },
  'session.get_service_tier_config': {
    params: {},
    result: {
      mechanism: 'request-parameter',
      tiers: [
        { id: 'flex', displayName: 'Flex', description: null },
        { id: 'fast', displayName: null, description: null },
      ],
      selected: 'fast',
      override: null,
      effective: 'fast',
    },
  },
  'session.working_set_get': { params: undefined, result: workingSet },
  'session.working_set_open_or_focus': {
    params: { id: SESSION_ID },
    result: workingSet,
  },
  'session.working_set_close': { params: { id: SESSION_ID }, result: workingSet },
  'session.working_set_remove': { params: { id: SESSION_ID }, result: workingSet },
  'session.working_set_set_focus': { params: { id: null }, result: workingSet },
  'session.activity_list': { params: undefined, result: [activity] },
  'session.activity_mark_seen': { params: { id: SESSION_ID }, result: activity },
  'bgcmd.snapshot': { params: { commandId: 1 }, result: { found: false } },
  'bgcmd.list': { params: {}, result: [] },
  'bgcmd.send_input': {
    params: { commandId: 1, text: 'y\n' },
    result: { ok: true },
  },
  'bgcmd.terminate': { params: { commandId: 1 }, result: { ok: true } },
  'bgcmd.release_input': { params: { commandId: 1 }, result: { ok: true } },
  'ask_question.snapshot': {
    params: undefined,
    result: { questions: [askedEvent] },
  },
  'ask_question.answer': {
    params: {
      toolCallId: TOOL_CALL_ID,
      answers: [{ selected: ['Yes'], text: null, skipped: false }],
    },
    result: { ok: true },
  },
  'ask_question.cancel': {
    params: { toolCallId: TOOL_CALL_ID },
    result: { ok: true },
  },
  'permission.snapshot': {
    params: undefined,
    result: { approvals: [approvalRequested] },
  },
  'permission.approval_answer': {
    params: { toolCallId: TOOL_CALL_ID, decision: 'approved' },
    result: { ok: true },
  },
  'permission.set_session_mode': {
    params: { mode: 'ask', expectedSessionId: SESSION_ID },
    result: { ok: true, sessionId: SESSION_ID },
  },
  'permission.get_session_mode': {
    params: { expectedSessionId: SESSION_ID },
    result: { ok: true, sessionId: SESSION_ID, mode: 'ask' },
  },
  'project.trust_get': {
    params: { cwd: PROJECT_DIR },
    result: { projectDir: PROJECT_DIR, state: 'untrusted', report: null },
  },
  'project.trust_set': {
    params: { cwd: PROJECT_DIR, trusted: true },
    result: { projectDir: PROJECT_DIR, state: 'trusted', report: null },
  },
  'project.trust_list': {
    params: undefined,
    result: [
      { projectDir: PROJECT_DIR, trustedAt: '2026-08-23T00:00:00.000Z', state: 'trusted' },
    ],
  },
  'definitions.list': {
    params: undefined,
    result: {
      projectDir: null,
      skills: [managedSkill],
      agents: [managedAgent],
      personalities: [
        {
          name: 'pirate',
          content: 'Arr.',
          scope: 'global',
          path: '/home/u/.orchid/personalities/pirate.md',
          overriddenByProject: false,
        },
      ],
      sharedPrompts: [
        {
          slot: 'all-agents',
          content: 'Be brief.',
          scope: 'global',
          path: '/home/u/.orchid/prompts/all-agents.md',
          overriddenByProject: false,
        },
      ],
      availableTools: ['read'],
      availableSkills: ['code-review'],
    },
  },
  'agent.save': {
    params: {
      scope: 'global',
      name: 'reviewer',
      type: 'subagent',
      tier: 'bloom',
      description: 'Reviews changes',
      system_prompt: 'You review changes.',
      allowed_tools: ['read'],
      allowed_skills: [],
    },
    result: managedAgent,
  },
  'agent.delete': { params: { scope: 'global', name: 'reviewer' }, result: { status: 'deleted' } },
  'skill.save': {
    params: {
      scope: 'global',
      name: 'code-review',
      description: 'Review the working diff',
      requires: [],
      content: 'Review carefully.',
    },
    result: managedSkill,
  },
  'skill.delete': { params: { scope: 'global', name: 'code-review' }, result: { status: 'deleted' } },
  'personality.save': {
    params: { scope: 'global', name: 'pirate', content: 'Arr.' },
    result: {
      name: 'pirate',
      content: 'Arr.',
      scope: 'global',
      path: '/home/u/.orchid/personalities/pirate.md',
      overriddenByProject: false,
    },
  },
  'personality.delete': { params: { scope: 'global', name: 'pirate' }, result: { status: 'deleted' } },
  'shared_prompt.save': {
    params: { scope: 'global', slot: 'all-agents', content: 'Be brief.' },
    result: {
      slot: 'all-agents',
      content: 'Be brief.',
      scope: 'global',
      path: '/home/u/.orchid/prompts/all-agents.md',
      overriddenByProject: false,
    },
  },
  'shared_prompt.delete': {
    params: { scope: 'global', slot: 'all-agents' },
    result: { status: 'deleted' },
  },
  'definition.reveal': {
    params: { path: '/home/u/.orchid/skills/code-review/SKILL.md' },
    result: { status: 'ok' },
  },
  'mcp.status': {
    params: undefined,
    result: [
      { name: 'context7', status: 'connected', toolCount: 0, tools: [], error: null },
    ],
  },
  'rag.status': {
    params: undefined,
    result: {
      totalChunks: 0,
      totalFiles: 0,
      lastIndexed: null,
      lastIndexDuration: null,
      lastAutoRefresh: null,
    },
  },
  'rag.index': {
    params: { force: false },
    result: {
      filesScanned: 1,
      filesIndexed: 1,
      filesSkipped: 0,
      filesDeleted: 0,
      chunksCreated: 2,
      errors: [],
      durationSeconds: 0.1,
    },
  },
  'rag.clear': { params: undefined, result: { status: 'cleared' } },
  'rag.index_state': {
    params: undefined,
    result: { indexing: true, progress: { phase: 'indexing', done: 1, total: 4 } },
  },
  'ast.status': {
    params: undefined,
    result: {
      totalFiles: 0,
      totalSymbols: 0,
      lastIndexed: null,
      lastIndexDuration: null,
      lastAutoRefresh: null,
    },
  },
  'ast.index': {
    params: { force: false },
    result: {
      filesScanned: 1,
      filesIndexed: 1,
      filesSkipped: 0,
      filesDeleted: 0,
      symbolsExtracted: 3,
      errors: [],
      durationSeconds: 0.1,
    },
  },
  'ast.index_state': {
    params: undefined,
    result: { indexing: false, progress: null },
  },
  'tool.execute': {
    params: { name: 'read', args: { path: '/tmp/orchid-host-protocol-project/README.md' } },
    result: toolResult,
  },
  'config.get': { params: undefined, result: {} },
  'config.save': { params: { updates: {} }, result: { status: 'saved' } },
  'config.get_home': { params: undefined, result: {} },
  'config.read_project': {
    params: PROJECT_DIR,
    result: { projectDir: PROJECT_DIR, overrides: {} },
  },
  'config.save_project': {
    params: { projectDir: PROJECT_DIR, updates: {} },
    result: null,
  },
  'config.permission_scopes': {
    params: undefined,
    result: { global: { grep: 'ask' }, project: {}, projectDir: null },
  },
  'config.save_permission_scope': {
    params: { scope: 'global', updates: { grep: 'allow' } },
    result: { status: 'saved' },
  },
  'providers.list': { params: undefined, result: providerOverview },
  'providers.validate': {
    params: { connectionId: CONNECTION_ID },
    result: providerMutation,
  },
  'providers.disable': {
    params: { connectionId: CONNECTION_ID },
    result: providerMutation,
  },
  'providers.enable': {
    params: { connectionId: CONNECTION_ID },
    result: providerMutation,
  },
  'providers.disconnect': {
    params: { connectionId: CONNECTION_ID, confirm: true },
    result: providerMutation,
  },
  'providers.delete': {
    params: { connectionId: CONNECTION_ID, confirm: true },
    result: {
      connectionId: CONNECTION_ID,
      message: 'The connection was deleted.',
      config: {},
      clearedConfigReferences: {
        defaultModel: false,
        tierModels: [],
        ragEmbeddingModel: false,
      },
    },
  },
  'providers.model_list': {
    params: { connectionId: CONNECTION_ID, includeDisabled: false },
    result: [
      {
        selection: { connectionId: CONNECTION_ID, modelId: 'gpt-4o' },
        connectionName: 'Work',
        providerId: 'openai',
        providerDisplayName: 'OpenAI',
        model: modelView,
        enabled: true,
        customized: false,
        discoveredAt: null,
        available: true,
        unavailableReason: null,
      },
    ],
  },
  'providers.discover_models': {
    params: { connectionId: CONNECTION_ID },
    result: {
      connection: connectionView,
      status: 'ok',
      discoveredModelCount: 1,
      addedModelIds: ['gpt-4o-mini'],
      message: null,
    },
  },
  'providers.status_refresh': {
    params: { providerId: 'openai', connectionId: CONNECTION_ID },
    result: null,
  },
  'providers.quota_refresh': {
    params: { connectionId: CONNECTION_ID },
    result: null,
  },
};

const identity = { sessionId: SESSION_ID, turnId: TURN_ID, sequence: 1 };

const EVENT_FIXTURES: Record<string, unknown> = {
  'chat:chunk': { ...identity, type: 'chunk', data: 'he', segmentId: 'seg-1' },
  'chat:thinking': { ...identity, type: 'thinking', data: 'hm', segmentId: 'seg-2' },
  'chat:state': {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sequence: 2,
    state: 'streaming',
    error: null,
    interruptState: 'idle',
  },
  'chat:done': {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sequence: 3,
    type: 'done',
    response: 'ok',
    messages: [],
  },
  'chat:error': {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sequence: 3,
    type: 'error',
    error: 'boom',
    messages: [],
  },
  'chat:usage': {
    ...identity,
    type: 'usage',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 },
  },
  'chat:tool_call_start': {
    ...identity,
    type: 'tool_call_start',
    toolCallId: 'tc-1',
    toolName: 'read',
  },
  'chat:tool_call_delta': {
    ...identity,
    type: 'tool_call_delta',
    toolCallId: 'tc-1',
    argsDelta: '{"pa',
  },
  'chat:tool_call_update': {
    ...identity,
    type: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'running',
  },
  'chat:compaction_progress': {
    ...identity,
    type: 'compaction_progress',
    agentScopeId: null,
    phase: 'preparing',
  },
  'subagents:event': { sessionId: SESSION_ID, events: [] },
  'session:deleted': { id: SESSION_ID, workingSet },
  'session:renamed': { id: SESSION_ID, name: 'Renamed' },
  'session:created': {
    session: { id: SESSION_ID, name: 'New chat' },
    draftGeneration: 1,
  },
  'session:updated': {
    sessionId: SESSION_ID,
    chain: { id: CHAIN_ID, sessionId: SESSION_ID, messages: [] },
    activeChainId: CHAIN_ID,
    updatedAt: '2026-08-23T00:00:00.000Z',
  },
  'session:compaction': {
    sessionId: SESSION_ID,
    updatedAt: '2026-08-23T00:00:00.000Z',
  },
  'session:workspace_changed': { workspace },
  'session:subagents_changed': undefined,
  'session:todos_changed': { sessionId: SESSION_ID },
  'session:activity_changed': {
    activity: { sessionId: SESSION_ID, state: 'working', updatedAt: 1 },
  },
  'session:working_set_changed': { snapshot: workingSet },
  'project:trust_changed': { projectDir: PROJECT_DIR, state: 'trusted' },
  'bgcmd:changed': { sessionId: SESSION_ID },
  'ask_question:asked': askedEvent,
  'ask_question:settled': {
    sessionId: SESSION_ID,
    toolCallId: TOOL_CALL_ID,
    result: 'answered',
  },
  'permission:approval_requested': approvalRequested,
  'permission:approval_settled': {
    sessionId: SESSION_ID,
    toolCallId: TOOL_CALL_ID,
    result: { decision: 'approved' },
  },
  'rag:progress': { phase: 'indexing', done: 1, total: 4 },
  'ast:progress': { phase: 'discovering', done: 0, total: 3 },
  'index:auto_refresh': { phase: 'started', rag: true, ast: false },
};

describe('HOST_METHODS registry', () => {
  it('registers the full host-routed method surface', () => {
    expect(Object.keys(HOST_METHODS)).toHaveLength(85);
    expect(HOST_METHODS[HOST_HELLO_METHOD]).toBeDefined();
    expect(HOST_METHODS['host.pending_state']).toBeDefined();
    for (const method of Object.keys(HOST_METHODS)) {
      expect(
        ['machines.', 'analytics.', 'updater.', 'startup.'].some((prefix) =>
          method.startsWith(prefix),
        ),
        `local-only family leaked into the protocol: ${method}`,
      ).toBe(false);
    }
  });

  it('gives every method defined params and result schemas', () => {
    for (const [method, spec] of Object.entries(HOST_METHODS)) {
      expect(typeof spec.params?.safeParse, `params schema missing for ${method}`).toBe('function');
      expect(typeof spec.result?.safeParse, `result schema missing for ${method}`).toBe('function');
    }
  });

  it('parses a representative params and result fixture for every method', () => {
    const failures: string[] = [];
    for (const [method, spec] of Object.entries(HOST_METHODS)) {
      const fixture = METHOD_FIXTURES[method];
      if (fixture === undefined) {
        failures.push(`${method}: no fixture`);
        continue;
      }
      const params = spec.params.safeParse(fixture.params);
      if (!params.success) failures.push(`${method} params: ${params.error.message}`);
      const result = spec.result.safeParse(fixture.result);
      if (!result.success) failures.push(`${method} result: ${result.error.message}`);
    }
    expect(failures).toEqual([]);
  });

  it('has a fixture for exactly the registered methods', () => {
    expect(Object.keys(METHOD_FIXTURES).sort()).toEqual(Object.keys(HOST_METHODS).sort());
  });

  it('accepts the post-normalization wire values the server actually emits', () => {
    // The response envelope normalizes `undefined` results to `null`
    // (server handleRequest), so every void-result method must validate the
    // wire's `null` — not just the in-process `undefined`.
    const voidResultMethods = ['chat.queue_next', 'config.save_project'];
    for (const method of voidResultMethods) {
      expect(
        HOST_METHODS[method as keyof typeof HOST_METHODS].result.safeParse(null).success,
        `${method} result must accept the wire-normalized null`,
      ).toBe(true);
      expect(
        HOST_METHODS[method as keyof typeof HOST_METHODS].result.safeParse(undefined).success,
        `${method} result must accept the in-process undefined`,
      ).toBe(true);
    }

    // chat.snapshot legitimately answers `null` for "no session" (the server
    // binding returns null before touching the session store; the IPC handler
    // is typed ChatSessionSnapshot | null).
    expect(HOST_METHODS['chat.snapshot'].result.safeParse(null).success).toBe(true);
  });

  it('accepts the binding-emitted shapes for chat.compact and session.change_model', () => {
    // The chat.compact binding answers `sessionId: ''` when no session was
    // active at all — the registry must not demand a non-empty id there.
    expect(
      HOST_METHODS['chat.compact'].result.safeParse({
        status: 'nothing_to_compact',
        sessionId: '',
        detail: 'No active session to compact.',
      }).success,
    ).toBe(true);

    // session.change_model echoes selection + modelLabel only on the
    // changed/unchanged paths; not_found/not_active carry status alone.
    for (const result of [
      { status: 'unchanged', selection: null, modelLabel: null },
      { status: 'changed', selection: { connectionId: CONNECTION_ID, modelId: 'gpt-4o' }, modelLabel: 'GPT-4o' },
      { status: 'not_found' },
      { status: 'not_active' },
    ]) {
      expect(HOST_METHODS['session.change_model'].result.safeParse(result).success).toBe(true);
    }
  });

  it('maps every method back to a real IPC invoke channel', () => {
    const invokeChannels = ALLOWED_INVOKE_CHANNELS as readonly string[];
    for (const method of Object.keys(HOST_METHODS)) {
      // Host-internal methods (handshake, reconnect resync) deliberately have
      // no IPC channel counterpart.
      if (method.startsWith('host.')) continue;
      expect(invokeChannels, `method ${method} has no IPC channel counterpart`).toContain(
        methodToChannel(method),
      );
    }
  });

  it('detects unknown and local-only method names as registry misses', () => {
    expect(lookupHostMethod('chat.nope')).toBeUndefined();
    expect(lookupHostMethod('machines.list')).toBeUndefined();
    expect(lookupHostMethod('analytics.overview')).toBeUndefined();
    expect(lookupHostMethod('providers.submit_api_key')).toBeUndefined();
    expect(lookupHostMethod('__proto__')).toBeUndefined();
    expect(lookupHostMethod('chat.send')).toBe(HOST_METHODS['chat.send']);
    expect(lookupHostMethod('host.pending_state')).toBe(HOST_METHODS['host.pending_state']);
  });

  it('excludes provider vault writes from the routed surface', () => {
    for (const vaultWrite of [
      'providers.create',
      'providers.update',
      'providers.submit_api_key',
      'providers.discover_draft_models',
    ]) {
      expect(HOST_METHODS).not.toHaveProperty(vaultWrite);
    }
  });
});

describe('HOST_EVENTS registry', () => {
  it('registers every host-push event exactly after its IPC channel name', () => {
    expect(Object.keys(HOST_EVENTS)).toHaveLength(30);
    const eventChannels = ALLOWED_EVENT_CHANNELS as readonly string[];
    for (const ev of Object.keys(HOST_EVENTS)) {
      expect(eventChannels, `event ${ev} is not an allowed IPC event channel`).toContain(ev);
    }
    expect(Object.keys(HOST_EVENTS)).not.toContain('machines:changed');
    expect(Object.keys(HOST_EVENTS)).not.toContain('startup:changed');
  });

  it('parses a representative fixture for every event', () => {
    const failures: string[] = [];
    for (const [ev, schema] of Object.entries(HOST_EVENTS)) {
      if (!Object.hasOwn(EVENT_FIXTURES, ev)) {
        failures.push(`${ev}: no fixture`);
        continue;
      }
      const parsed = schema.safeParse(EVENT_FIXTURES[ev]);
      if (!parsed.success) failures.push(`${ev}: ${parsed.error.message}`);
    }
    expect(failures).toEqual([]);
  });

  it('has a fixture for exactly the registered events', () => {
    expect(Object.keys(EVENT_FIXTURES).sort()).toEqual(Object.keys(HOST_EVENTS).sort());
  });

  it('detects unknown event names as registry misses', () => {
    expect(lookupHostEvent('chat:nope')).toBeUndefined();
    expect(lookupHostEvent('machines:changed')).toBeUndefined();
    expect(lookupHostEvent('constructor')).toBeUndefined();
    expect(lookupHostEvent('chat:chunk')).toBe(HOST_EVENTS['chat:chunk']);
  });
});

describe('handshake', () => {
  it('round-trips hello params and result at equal versions', () => {
    const params = hostHelloParamsSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'window-1',
    });
    expect(params.protocolVersion).toBe(PROTOCOL_VERSION);
    const result = hostHelloResultSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [HOST_CAPABILITIES.PROVIDERS_READ],
    });
    expect(result.capabilities).toEqual(['providers.read']);
    expect(() => assertProtocolVersionMatches(PROTOCOL_VERSION, PROTOCOL_VERSION)).not.toThrow();
  });

  it('rejects a hello result without a capabilities array', () => {
    expect(hostHelloResultSchema.safeParse({ protocolVersion: 1 }).success).toBe(false);
  });

  it('produces a typed PROTOCOL_MISMATCH error shape on version mismatch', () => {
    let caught: unknown;
    try {
      assertProtocolVersionMatches(PROTOCOL_VERSION, PROTOCOL_VERSION + 1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostProtocolError);
    const protocolError = caught as HostProtocolError;
    expect(protocolError.code).toBe(HOST_ERROR_CODES.PROTOCOL_MISMATCH);
    const payload = protocolError.toPayload();
    expect(hostErrorPayloadSchema.parse(payload).code).toBe('PROTOCOL_MISMATCH');
    expect(payload.data).toEqual({ expected: 1, offered: 2 });
  });
});

describe('envelopes', () => {
  const request = { id: 1, method: 'chat.send', params: { message: 'hi' } };
  const success = { id: 1, ok: true, result: { status: 'started' } };
  const failure = {
    id: 'req-2',
    ok: false,
    error: { code: HOST_ERROR_CODES.METHOD_NOT_FOUND, message: 'nope' },
  };
  const event = { ev: 'chat:chunk', params: { data: 'he' }, seq: 3 };

  it('discriminates requests, responses, and events', () => {
    expect(isHostRequest(request)).toBe(true);
    expect(isHostRequest(success)).toBe(false);
    expect(isHostRequest(event)).toBe(false);

    expect(isHostResponse(success)).toBe(true);
    expect(isHostResponse(failure)).toBe(true);
    expect(isHostResponse(request)).toBe(false);
    expect(isHostResponse(event)).toBe(false);

    expect(isHostEvent(event)).toBe(true);
    expect(isHostEvent(request)).toBe(false);
    expect(isHostEvent(success)).toBe(false);
  });

  it('rejects non-envelope values', () => {
    for (const guard of [isHostRequest, isHostResponse, isHostEvent]) {
      expect(guard(null)).toBe(false);
      expect(guard('chat:send')).toBe(false);
      expect(guard({ id: 1 })).toBe(false);
      expect(guard({ method: 'chat.send' })).toBe(false);
    }
  });

  it('accepts a void-result success response without a result key', () => {
    expect(isHostResponse({ id: 7, ok: true })).toBe(true);
  });

  it('rejects a response whose error leg is malformed', () => {
    expect(hostResponseSchema.safeParse({ id: 1, ok: false }).success).toBe(false);
    expect(
      hostResponseSchema.safeParse({ id: 1, ok: false, error: { code: 'X' } }).success,
    ).toBe(false);
    expect(
      hostResponseSchema.safeParse({ id: 1, ok: 'true', result: {} }).success,
    ).toBe(false);
  });

  it('rejects envelopes carrying unknown keys', () => {
    expect(hostRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(hostEventSchema.safeParse({ ...event, id: 1 }).success).toBe(false);
  });

  it('accepts each envelope kind through the shared message schema', () => {
    for (const message of [request, success, failure, event]) {
      expect(hostMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

describe('channelToMethod / methodToChannel', () => {
  it('maps channel names to method names mechanically', () => {
    expect(channelToMethod('chat:send')).toBe('chat.send');
    expect(channelToMethod('session:working_set_get')).toBe('session.working_set_get');
    expect(methodToChannel('chat.send')).toBe('chat:send');
    expect(methodToChannel('session:working_set_get')).toBe('session:working_set_get');
    expect(methodToChannel('host.hello')).toBe('host:hello');
  });

  it('round-trips every registered method except host-internal ones', () => {
    for (const method of Object.keys(HOST_METHODS)) {
      if (method === HOST_HELLO_METHOD) continue;
      expect(channelToMethod(methodToChannel(method))).toBe(method);
    }
    for (const ev of Object.keys(HOST_EVENTS)) {
      expect(methodToChannel(channelToMethod(ev))).toBe(ev);
    }
  });
});

describe('HOST_CAPABILITIES', () => {
  it('declares the plan-defined capability constants', () => {
    expect(Object.values(HOST_CAPABILITIES)).toEqual([
      'config.write',
      'providers.read',
      'providers.vault-writes',
      'definitions.reveal',
      'session.pick_project_dir',
    ]);
  });
});
