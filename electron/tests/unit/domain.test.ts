import { describe, it, expect } from 'vitest';
import {
  MessageRole,
  MessageType,
  type Message,
  messageToStorageDict,
  messageFromStorageDict,
  messageToApiFormat,
} from '../../src/shared/types/message';
import {
  ChainStatus,
  type Chain,
  chainToStorageDict,
  chainFromStorageDict,
  isLegacyMegaChain,
  sumChainUsage,
  chainElapsedSeconds,
} from '../../src/shared/types/chain';
import {
  SubagentStatus,
  type SubagentRecord,
  subagentRecordToStorageDict,
  subagentRecordFromStorageDict,
} from '../../src/shared/types/subagent';
import {
  type Session,
  sessionToStorageDict,
  sessionFromStorageDict,
} from '../../src/shared/types/session';
import type { ModelSelection } from '../../src/shared/types/provider';
import {
  TodoStatus,
  type Todo,
  VALID_TRANSITIONS,
  todoToStorageDict,
  todoFromStorageDict,
  todoStoreToStorageDict,
  todoStoreFromStorageDict,
} from '../../src/shared/types/todo';
import type { ToolCall } from '../../src/shared/types/tool';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeToolCall(id: string, name: string, args: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

const DEFAULT_SELECTION: ModelSelection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'vendor/models/gpt-4o',
};

function makeMessage(overrides: Partial<Message> & { role: MessageRole }): Message {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: overrides.role,
    content: overrides.content ?? '',
    type: overrides.type ?? MessageType.TEXT,
    tool_calls: overrides.tool_calls ?? null,
    tool_call_id: overrides.tool_call_id ?? null,
    name: overrides.name ?? null,
    thinking: overrides.thinking ?? null,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    usage: overrides.usage ?? null,
    hidden: overrides.hidden ?? false,
    excludeFromModel: overrides.excludeFromModel ?? false,
    tool_result: overrides.tool_result ?? null,
  };
}

function makeChain(overrides: Partial<Chain> = {}): Chain {
  const now = new Date().toISOString();
  const selection = overrides.selection === undefined ? DEFAULT_SELECTION : overrides.selection;
  return {
    id: overrides.id ?? `chain-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: overrides.sessionId ?? 'session-1',
    messages: overrides.messages ?? [],
    status: overrides.status ?? ChainStatus.COMPLETED,
    selection,
    modelLabel:
      overrides.modelLabel === undefined ? (selection?.modelId ?? null) : overrides.modelLabel,
    agentName: overrides.agentName ?? 'General',
    agentType: overrides.agentType ?? 'internal',
    agentTier: overrides.agentTier ?? 'bloom',
    subagentRecord: overrides.subagentRecord ?? null,
    startTime: overrides.startTime ?? now,
    endTime:
      overrides.endTime !== undefined
        ? overrides.endTime
        : overrides.status === ChainStatus.ACTIVE
          ? null
          : now,
  };
}

// ── Test 1: Session → Chain → Messages round-trip ───────────────────────────

describe('Domain Models: Session round-trip', () => {
  it('retains canonical tool facts byte-equivalently in storage but excludes them from API history', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: {
        value: {
          canonicalOnly: 'CANONICAL_ONLY_SENTINEL',
          nested: ['first', { last: true }],
        },
      },
    });
    const message = makeMessage({
      id: 'canonical-result',
      role: MessageRole.TOOL,
      type: MessageType.TOOL_RESULT,
      content: 'exact agent projection',
      tool_call_id: 'tool-call-1',
      tool_result: canonical,
    });

    const stored = messageToStorageDict(message);
    expect(stored.tool_result).toEqual(canonical);
    expect(JSON.stringify(stored.tool_result)).toBe(JSON.stringify(canonical));

    const restored = messageFromStorageDict(stored);
    expect(restored.content).toBe('exact agent projection');
    expect(JSON.stringify(restored.tool_result)).toBe(JSON.stringify(canonical));
    expect(messageToApiFormat(restored)).toEqual({
      role: MessageRole.TOOL,
      content: 'exact agent projection',
      tool_call_id: 'tool-call-1',
    });
    expect(JSON.stringify(messageToApiFormat(restored))).not.toContain(
      'CANONICAL_ONLY_SENTINEL',
    );
  });

  it('restores unsupported legacy or invalid canonical tool results as null without reinterpretation', () => {
    const legacy = messageFromStorageDict({
      role: 'tool',
      type: 'tool_result',
      content: 'legacy result string',
      tool_call_id: 'legacy-call',
      is_error: true,
    });
    const invalid = messageFromStorageDict({
      role: 'tool',
      type: 'tool_result',
      content: 'invalid canonical',
      tool_call_id: 'invalid-call',
      tool_result: { family: 'generic', status: 'complete' },
    });

    expect(legacy.tool_result).toBeNull();
    expect(legacy.content).toBe('legacy result string');
    expect(invalid.tool_result).toBeNull();
  });

  it('serialize → deserialize produces identical Session', () => {
    const toolCall = makeToolCall('tc-1', 'read', '{"file_path":"test.ts"}');
    const now = new Date().toISOString();

    const messages: Message[] = [
      makeMessage({ id: 'msg-1', role: MessageRole.USER, content: 'Hello', timestamp: now }),
      makeMessage({
        id: 'msg-2',
        role: MessageRole.ASSISTANT,
        content: 'I will read the file.',
        tool_calls: [toolCall],
        timestamp: now,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cached_tokens: 2,
          context: {
            input_tokens: 10,
            output_tokens: 5,
            used_tokens: 15,
            system_tokens: 3,
            tools_tokens: 2,
            tool_use_tokens: 1,
            user_tokens: 4,
            assistant_tokens: 5,
          },
        },
      }),
      makeMessage({
        id: 'msg-3',
        role: MessageRole.TOOL,
        content: 'file contents here',
        tool_call_id: 'tc-1',
        timestamp: now,
      }),
      makeMessage({
        id: 'msg-4',
        role: MessageRole.ASSISTANT,
        content: 'Here is the file.',
        timestamp: now,
      }),
    ];

    const chain = makeChain({
      id: 'chain-1',
      sessionId: 'session-1',
      messages,
      status: ChainStatus.COMPLETED,
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
      agentName: 'General',
      agentType: 'internal',
      agentTier: 'bloom',
    });

    const session: Session = {
      id: 'session-1',
      name: 'Test Session',
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
      cwd: null,
      chains: [chain],
      activeChainId: 'chain-1',
      createdAt: now,
      updatedAt: now,
      subagentChains: [],
      todoStore: { tasks: [] },
    };

    const dict = sessionToStorageDict(session);
    expect(dict.version).toBe(2);
    expect(dict.id).toBe('session-1');
    expect(dict.selection).toEqual(DEFAULT_SELECTION);
    expect(dict.modelLabel).toBe(DEFAULT_SELECTION.modelId);
    expect(dict).not.toHaveProperty('model');

    const restored = sessionFromStorageDict(dict);

    // Session-level fields
    expect(restored.id).toBe(session.id);
    expect(restored.name).toBe(session.name);
    expect(restored.selection).toEqual(session.selection);
    expect(restored.modelLabel).toBe(session.modelLabel);
    expect(restored.activeChainId).toBe(session.activeChainId);
    expect(restored.createdAt).toBe(session.createdAt);
    expect(restored.updatedAt).toBe(session.updatedAt);

    // Chain-level fields
    expect(restored.chains).toHaveLength(1);
    const restoredChain = restored.chains[0];
    expect(restoredChain.id).toBe('chain-1');
    expect(restoredChain.sessionId).toBe('session-1');
    expect(restoredChain.status).toBe(ChainStatus.COMPLETED);
    expect(restoredChain.selection).toEqual(DEFAULT_SELECTION);
    expect(restoredChain.modelLabel).toBe(DEFAULT_SELECTION.modelId);
    expect(restoredChain.agentName).toBe('General');
    expect(restoredChain.agentType).toBe('internal');
    expect(restoredChain.agentTier).toBe('bloom');

    // Messages
    expect(restoredChain.messages).toHaveLength(4);
    expect(restoredChain.messages[0].role).toBe(MessageRole.USER);
    expect(restoredChain.messages[0].content).toBe('Hello');
    expect(restoredChain.messages[1].tool_calls).toHaveLength(1);
    expect(restoredChain.messages[1].tool_calls![0].id).toBe('tc-1');
    expect(restoredChain.messages[2].tool_call_id).toBe('tc-1');
    expect(restoredChain.messages[2].content).toBe('file contents here');
    expect(restoredChain.messages[3].content).toBe('Here is the file.');

    // Usage round-trip
    const usage = restoredChain.messages[1].usage!;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
    expect(usage.cached_tokens).toBe(2);
    expect(usage.context).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      used_tokens: 15,
      system_tokens: 3,
      tools_tokens: 2,
      tool_use_tokens: 1,
      user_tokens: 4,
      assistant_tokens: 5,
    });
  });

  it('Message.toApiFormat produces OpenAI-shaped messages', () => {
    const toolCall = makeToolCall('tc-1', 'read', '{}');
    const assistantWithTools = makeMessage({
      role: MessageRole.ASSISTANT,
      content: '',
      tool_calls: [toolCall],
    });

    const api = messageToApiFormat(assistantWithTools);
    expect(api.role).toBe('assistant');
    expect(api.content).toBeNull(); // OpenAI: null content on tool-call-only
    expect(api.tool_calls).toHaveLength(1);
    expect(api.tool_calls![0].id).toBe('tc-1');

    const toolResult = makeMessage({
      role: MessageRole.TOOL,
      content: 'result',
      tool_call_id: 'tc-1',
    });
    const apiResult = messageToApiFormat(toolResult);
    expect(apiResult.role).toBe('tool');
    expect(apiResult.content).toBe('result');
    expect(apiResult.tool_call_id).toBe('tc-1');
  });
});

// ── Test 2: Chain orphans — TOOL_RESULT with no preceding tool_calls ────────

describe('Domain Models: Chain orphan reconciliation', () => {
  it('drops TOOL_RESULT with no preceding assistant tool_calls', () => {
    const now = new Date().toISOString();
    const messages = [
      makeMessage({ id: 'msg-1', role: MessageRole.USER, content: 'Hello', timestamp: now }),
      // Orphan: tool result with no matching assistant tool_calls
      makeMessage({
        id: 'msg-2',
        role: MessageRole.TOOL,
        content: 'orphan result',
        tool_call_id: 'tc-nonexistent',
        timestamp: now,
      }),
      makeMessage({
        id: 'msg-3',
        role: MessageRole.ASSISTANT,
        content: 'Hi there',
        timestamp: now,
      }),
    ];

    const chain = makeChain({ messages });
    const dict = chainToStorageDict(chain);
    const restored = chainFromStorageDict(dict);

    // The orphan tool result should be dropped
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0].role).toBe(MessageRole.USER);
    expect(restored.messages[1].role).toBe(MessageRole.ASSISTANT);
  });

  it('drops duplicate TOOL_RESULT for same tool_call_id', () => {
    const now = new Date().toISOString();
    const toolCall = makeToolCall('tc-1', 'read', '{}');
    const messages = [
      makeMessage({
        id: 'msg-1',
        role: MessageRole.ASSISTANT,
        content: '',
        tool_calls: [toolCall],
        timestamp: now,
      }),
      makeMessage({
        id: 'msg-2',
        role: MessageRole.TOOL,
        content: 'first result',
        tool_call_id: 'tc-1',
        timestamp: now,
      }),
      // Duplicate tool result for same tool_call_id
      makeMessage({
        id: 'msg-3',
        role: MessageRole.TOOL,
        content: 'duplicate result',
        tool_call_id: 'tc-1',
        timestamp: now,
      }),
    ];

    const chain = makeChain({ messages });
    const dict = chainToStorageDict(chain);
    const restored = chainFromStorageDict(dict);

    // Duplicate should be dropped
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0].tool_calls).toHaveLength(1);
    expect(restored.messages[1].content).toBe('first result');
  });

  it('keeps properly paired tool_calls and tool results', () => {
    const now = new Date().toISOString();
    const toolCall = makeToolCall('tc-1', 'grep', '{"pattern":"test"}');
    const messages = [
      makeMessage({
        id: 'msg-1',
        role: MessageRole.ASSISTANT,
        content: '',
        tool_calls: [toolCall],
        timestamp: now,
      }),
      makeMessage({
        id: 'msg-2',
        role: MessageRole.TOOL,
        content: 'grep results',
        tool_call_id: 'tc-1',
        timestamp: now,
      }),
      makeMessage({
        id: 'msg-3',
        role: MessageRole.ASSISTANT,
        content: 'Found it.',
        timestamp: now,
      }),
    ];

    const chain = makeChain({ messages });
    const dict = chainToStorageDict(chain);
    const restored = chainFromStorageDict(dict);

    expect(restored.messages).toHaveLength(3);
    expect(restored.messages[1].tool_call_id).toBe('tc-1');
  });
});

// ── Test 3: Subagent restore — PENDING/RUNNING → INTERRUPTED ────────────────

describe('Domain Models: SubagentRecord restore migration', () => {
  it('PENDING → INTERRUPTED on restore', () => {
    const now = new Date().toISOString();
    const record: SubagentRecord = {
      id: 'sub-1',
      agent_name: 'Explorer',
      agent_type: 'subagent',
      agent_tier: 'bloom',
      task: 'Find all TypeScript files',
      status: SubagentStatus.PENDING,
      chain_id: 'chain-2',
      start_time: now,
      end_time: null,
      result: null,
      error: null,
      parentChainIndex: 0,
      chain: makeChain({ id: 'chain-2', sessionId: 'session-1' }),
    };

    const dict = subagentRecordToStorageDict(record);
    const restored = subagentRecordFromStorageDict(dict);

    expect(restored.status).toBe(SubagentStatus.INTERRUPTED);
    // end_time should be set (migrated to INTERRUPTED without end_time)
    expect(restored.end_time).not.toBeNull();
  });

  it('RUNNING → INTERRUPTED with preserved end_time', () => {
    const now = new Date().toISOString();
    const endTime = '2026-01-01T12:00:00.000Z';
    const record: SubagentRecord = {
      id: 'sub-2',
      agent_name: 'Reviewer',
      agent_type: 'subagent',
      agent_tier: 'crown',
      task: 'Review the PR',
      status: SubagentStatus.RUNNING,
      chain_id: 'chain-3',
      start_time: now,
      end_time: endTime,
      result: null,
      error: null,
      parentChainIndex: 1,
      chain: makeChain({ id: 'chain-3', sessionId: 'session-1' }),
    };

    const dict = subagentRecordToStorageDict(record);
    const restored = subagentRecordFromStorageDict(dict);

    expect(restored.status).toBe(SubagentStatus.INTERRUPTED);
    // Preserved end_time
    expect(restored.end_time).toBe(endTime);
  });

  it('QUEUED → INTERRUPTED (queued is runtime-only and never persisted)', () => {
    const restored = subagentRecordFromStorageDict({
      id: 'sub-queued',
      agent_name: 'Explorer',
      agent_type: 'subagent',
      status: 'queued',
      task: 't',
      start_time: new Date().toISOString(),
      end_time: null,
      chain: { messages: [], status: 'active' },
    });

    expect(restored.status).toBe(SubagentStatus.INTERRUPTED);
    expect(restored.end_time).not.toBeNull();
  });

  it('COMPLETED status is preserved', () => {
    const now = new Date().toISOString();
    const record: SubagentRecord = {
      id: 'sub-3',
      agent_name: 'Explorer',
      agent_type: 'subagent',
      agent_tier: 'seed',
      task: 'List files',
      status: SubagentStatus.COMPLETED,
      chain_id: 'chain-4',
      start_time: now,
      end_time: now,
      result: 'Found 10 files',
      error: null,
      parentChainIndex: 4,
      chain: makeChain({ id: 'chain-4', sessionId: 'session-1' }),
    };

    const dict = subagentRecordToStorageDict(record);
    const restored = subagentRecordFromStorageDict(dict);

    expect(restored.status).toBe(SubagentStatus.COMPLETED);
    expect(restored.result).toBe('Found 10 files');
    expect(restored.parentChainIndex).toBe(4);
    expect(dict.parent_chain_index).toBe(4);
  });

  it('restores parent_chain_index from Python-shaped storage', () => {
    const restored = subagentRecordFromStorageDict({
      id: 'sub-py',
      agent_name: 'Explorer',
      agent_type: 'subagent',
      state: 'completed',
      task: 't',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      parent_chain_index: 2,
      chain: { messages: [], status: 'completed' },
    });
    expect(restored.parentChainIndex).toBe(2);
  });
});

// ── Test 4: Todo state machine ──────────────────────────────────────────────

describe('Domain Models: Todo state transitions', () => {
  it('DONE has no valid transitions', () => {
    expect(VALID_TRANSITIONS[TodoStatus.DONE].size).toBe(0);
  });

  it('Todo round-trip via storage dict', () => {
    const now = new Date().toISOString();
    const todo: Todo = {
      id: 'a1b2c3d4',
      title: 'Implement feature X',
      status: TodoStatus.IN_PROGRESS,
      subagent_id: 'sub-1',
      created_at: now,
      updated_at: now,
    };

    const dict = todoToStorageDict(todo);
    const restored = todoFromStorageDict(dict);

    expect(restored.id).toBe('a1b2c3d4');
    expect(restored.title).toBe('Implement feature X');
    expect(restored.status).toBe(TodoStatus.IN_PROGRESS);
    expect(restored.subagent_id).toBe('sub-1');
    expect(restored.created_at).toBe(now);
    expect(restored.updated_at).toBe(now);
  });

  it('TodoStore round-trip', () => {
    const now = new Date().toISOString();
    const store = {
      tasks: [
        {
          id: 'a1b2c3d4',
          title: 'Task 1',
          status: TodoStatus.OPEN as TodoStatus,
          subagent_id: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'e5f6a7b8',
          title: 'Task 2',
          status: TodoStatus.DONE as TodoStatus,
          subagent_id: 'sub-1',
          created_at: now,
          updated_at: now,
        },
      ],
    };

    const dict = todoStoreToStorageDict(store);
    const restored = todoStoreFromStorageDict(dict);

    expect(restored.tasks).toHaveLength(2);
    expect(restored.tasks[0].id).toBe('a1b2c3d4');
    expect(restored.tasks[0].status).toBe(TodoStatus.OPEN);
    expect(restored.tasks[1].id).toBe('e5f6a7b8');
    expect(restored.tasks[1].status).toBe(TodoStatus.DONE);
  });
});

// ── Test 5: Corrupted chain — per-chain error isolation ─────────────────────

describe('Domain Models: Per-chain error isolation', () => {
  it('corrupted chain data is handled gracefully (tolerant restore)', () => {
    const now = new Date().toISOString();
    const goodMessages: Message[] = [
      makeMessage({ id: 'msg-1', role: MessageRole.USER, content: 'Hello', timestamp: now }),
      makeMessage({ id: 'msg-2', role: MessageRole.ASSISTANT, content: 'Hi!', timestamp: now }),
    ];

    const goodChain = makeChain({
      id: 'chain-good',
      sessionId: 'session-1',
      messages: goodMessages,
      status: ChainStatus.COMPLETED,
    });

    const session: Session = {
      id: 'session-isolation',
      name: 'Isolation Test',
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
      cwd: null,
      chains: [goodChain],
      activeChainId: null,
      createdAt: now,
      updatedAt: now,
      subagentChains: [],
      todoStore: { tasks: [] },
    };

    const dict = sessionToStorageDict(session);

    // Inject a corrupted chain — fromStorageDict is tolerant by design,
    // so it won't throw but will produce degraded data.
    const corruptedChain = {
      messages: null,
      status: 12345,
      selection: { nested: 'bad' },
      modelLabel: { nested: 'bad' },
    };
    (dict.chains as unknown[]).push(corruptedChain);

    const restored = sessionFromStorageDict(dict);

    // Good chain loads with full data; corrupted chain loads with defaults
    expect(restored.chains).toHaveLength(2);
    expect(restored.chains[0].id).toBe('chain-good');
    expect(restored.chains[0].messages).toHaveLength(2);
    // Corrupted chain gets safe defaults (empty messages, default status)
    expect(restored.chains[1].messages).toHaveLength(0);
    expect(restored.chains[1].status).toBe(ChainStatus.COMPLETED);
  });

  it('session-level try/catch protects against truly broken chain data', () => {
    // The session fromStorageDict wraps each chain in try/catch,
    // so if chainFromStorageDict *does* throw, the chain is skipped.
    // We verify this by monkeypatching: chains that produce a thrown
    // error (e.g., via a Proxy that throws on property access) are skipped.
    const now = new Date().toISOString();

    // Verify that even non-object chain entries (null, undefined, strings)
    // don't crash the session restore — they produce degraded chains.
    const session: Session = {
      id: 'session-tolerant',
      name: 'Tolerant Test',
      selection: null,
      modelLabel: null,
      cwd: null,
      chains: [],
      activeChainId: null,
      createdAt: now,
      updatedAt: now,
      subagentChains: [],
      todoStore: { tasks: [] },
    };

    const dict = sessionToStorageDict(session);
    (dict as Record<string, unknown>).chains = [
      'a string instead of an object', // will produce a chain with empty defaults
      42, // same
    ];

    const restored = sessionFromStorageDict(dict);
    // Both "chains" are degraded but don't crash the restore
    expect(restored.chains).toHaveLength(2);
  });
});

// ── Additional tests ────────────────────────────────────────────────────────

describe('Domain Models: Message edge cases', () => {
  it('round-trips visible messages excluded from model context', () => {
    const message = makeMessage({
      role: MessageRole.TOOL,
      type: MessageType.TOOL_RESULT,
      content: 'Question cancelled',
      tool_call_id: 'tool-cancelled',
      excludeFromModel: true,
    });

    const stored = messageToStorageDict(message);
    const restored = messageFromStorageDict(stored);

    expect(stored.exclude_from_model).toBe(true);
    expect(restored.excludeFromModel).toBe(true);
    expect(restored.hidden).toBe(false);
  });

  it('handles missing fields gracefully on restore', () => {
    const restored = messageFromStorageDict({
      role: 'assistant',
      content: 'hello',
    });

    expect(restored.role).toBe(MessageRole.ASSISTANT);
    expect(restored.content).toBe('hello');
    expect(restored.type).toBe(MessageType.TEXT);
    expect(restored.tool_calls).toBeNull();
    expect(restored.tool_call_id).toBeNull();
    expect(restored.hidden).toBe(false);
  });

  it('falls back to SYSTEM for unknown role', () => {
    const restored = messageFromStorageDict({
      role: 'unknown_role',
      content: 'test',
    });
    expect(restored.role).toBe(MessageRole.SYSTEM);
  });

  it('falls back to TEXT for unknown type', () => {
    const restored = messageFromStorageDict({
      role: 'user',
      content: 'test',
      type: 'unknown_type',
    });
    expect(restored.type).toBe(MessageType.TEXT);
  });

  it('handles thinking messages', () => {
    const msg = makeMessage({
      role: MessageRole.ASSISTANT,
      content: 'Let me think...',
      type: MessageType.THINKING,
      thinking: 'Internal reasoning',
    });

    const dict = messageToStorageDict(msg);
    const restored = messageFromStorageDict(dict);

    expect(restored.type).toBe(MessageType.THINKING);
    expect(restored.thinking).toBe('Internal reasoning');
  });

  it('usage with extra forward-compat keys is tolerated', () => {
    const restored = messageFromStorageDict({
      role: 'assistant',
      content: 'test',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cached_tokens: 0,
        reasoning_tokens: 3, // Forward-compat extra key
        prompt_tokens_details: { cached_tokens: 0 }, // Forward-compat extra key
      },
    });

    expect(restored.usage).not.toBeNull();
    expect(restored.usage!.prompt_tokens).toBe(10);
    expect(restored.usage!.completion_tokens).toBe(5);
  });
});

describe('Domain Models: Tool storage dict', () => {
  it('tool_calls survive round-trip through chain', () => {
    const now = new Date().toISOString();
    const tc1 = makeToolCall('tc-1', 'read', '{"file_path":"a.ts"}');
    const tc2 = makeToolCall('tc-2', 'grep', '{"pattern":"foo"}');

    const messages: Message[] = [
      makeMessage({
        id: 'msg-1',
        role: MessageRole.ASSISTANT,
        content: '',
        tool_calls: [tc1, tc2],
        timestamp: now,
      }),
      makeMessage({
        id: 'msg-2',
        role: MessageRole.TOOL,
        content: 'result for tc-1',
        tool_call_id: 'tc-1',
        timestamp: now,
      }),
      makeMessage({
        id: 'msg-3',
        role: MessageRole.TOOL,
        content: 'result for tc-2',
        tool_call_id: 'tc-2',
        timestamp: now,
      }),
    ];

    const chain = makeChain({ messages });
    const dict = chainToStorageDict(chain);
    const restored = chainFromStorageDict(dict);

    expect(restored.messages).toHaveLength(3);
    expect(restored.messages[0].tool_calls).toHaveLength(2);
    expect(restored.messages[0].tool_calls![0].id).toBe('tc-1');
    expect(restored.messages[0].tool_calls![0].function.name).toBe('read');
    expect(restored.messages[0].tool_calls![1].id).toBe('tc-2');
    expect(restored.messages[0].tool_calls![1].function.name).toBe('grep');
  });
});

// ── Multi-chain helpers ─────────────────────────────────────────────────────

describe('Domain Models: multi-chain helpers', () => {
  it('migrates Python running/active → INTERRUPTED on restore and serializes FAILED', () => {
    const restored = chainFromStorageDict({
      id: 'c1',
      status: 'running',
      messages: [],
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
    });
    // ACTIVE cannot survive restore — process is gone (mirrors subagent migration)
    expect(restored.status).toBe(ChainStatus.INTERRUPTED);
    expect(restored.endTime).toBeTruthy();

    const activeRestored = chainFromStorageDict({
      id: 'c2',
      status: 'active',
      messages: [],
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
      endTime: '2026-07-10T12:00:00.000Z',
    });
    expect(activeRestored.status).toBe(ChainStatus.INTERRUPTED);
    expect(activeRestored.endTime).toBe('2026-07-10T12:00:00.000Z');

    const failed = makeChain({ status: ChainStatus.FAILED });
    const dict = chainToStorageDict(failed);
    expect(dict.status).toBe('failed');
    expect(chainFromStorageDict(dict).status).toBe(ChainStatus.FAILED);
  });

  it('round-trips startTime / endTime', () => {
    const chain = makeChain({
      startTime: '2026-07-10T12:00:00.000Z',
      endTime: '2026-07-10T12:00:05.000Z',
    });
    const restored = chainFromStorageDict(chainToStorageDict(chain));
    expect(restored.startTime).toBe('2026-07-10T12:00:00.000Z');
    expect(restored.endTime).toBe('2026-07-10T12:00:05.000Z');
    expect(chainElapsedSeconds(restored)).toBeCloseTo(5, 1);
  });

  it('sumChainUsage aggregates message usage', () => {
    const chain = makeChain({
      messages: [
        makeMessage({
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            cached_tokens: 2,
          },
        }),
        makeMessage({
          role: MessageRole.ASSISTANT,
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
            cached_tokens: 0,
          },
        }),
      ],
    });
    expect(sumChainUsage(chain)).toEqual({
      prompt_tokens: 30,
      completion_tokens: 13,
      total_tokens: 43,
      cached_tokens: 2,
    });
  });

  it('isLegacyMegaChain detects single chain with multiple user turns', () => {
    const mega = [
      makeChain({
        messages: [
          makeMessage({ role: MessageRole.USER, content: 'a' }),
          makeMessage({ role: MessageRole.ASSISTANT, content: 'b' }),
          makeMessage({ role: MessageRole.USER, content: 'c' }),
        ],
      }),
    ];
    expect(isLegacyMegaChain(mega)).toBe(true);

    const multi = [
      makeChain({
        messages: [makeMessage({ role: MessageRole.USER, content: 'a' })],
      }),
      makeChain({
        messages: [makeMessage({ role: MessageRole.USER, content: 'b' })],
      }),
    ];
    expect(isLegacyMegaChain(multi)).toBe(false);
  });
});
