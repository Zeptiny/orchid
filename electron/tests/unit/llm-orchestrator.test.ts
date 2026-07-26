/**
 * Tests for LLM stream orchestration (U9).
 *
 * Covers:
 * - history.ts: toApiMessages with pairing invariant, THINKING replay
 * - tool-dispatch.ts: executeToolCall, timeout, output offloading
 * - orchestrator.ts: streamChat (mocked AI SDK)
 *
 * Test scenarios from plan:
 * 1. No tool calls → text response yielded
 * 2. Tool call → tool executed → result fed back → stream continues
 * 3. Multi-step: tool call → result → another tool call → result → final text
 * 5. Output offloading: >20KB → cache file, pointer returned. Exempt tool → inline
 * 6. Usage tracking: Stream ends with usage data → Usage object populated
 * 7. Timeout: Tool >60s → TimeoutError caught, error result returned
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelMessage } from 'ai';
import * as os from 'node:os';
import type { Message } from '../../src/shared/types/message';
import { MessageType, MessageRole } from '../../src/shared/types/message';
import type { ToolCall } from '../../src/shared/types/tool';
import type { Agent } from '../../src/shared/types/agent';
import { AgentType, AgentTier } from '../../src/shared/types/agent';
import { toApiMessages } from '../../src/main/llm/history';
import {
  _setToolOutputCacheRootForTests,
  executeToolCall,
  maybeOffloadToolOutput,
  type ToolDispatchRequest,
} from '../../src/main/llm/tool-dispatch';
import {
  _setResultRetrievalCacheRootForTests,
} from '../../src/main/tools/result-retrieval';
import {
  buildToolMap,
  prefixProjectInstructionContext,
  streamChat,
  drainPendingToolEvents,
  combineAbortSignals,
  type StreamEvent,
  type StreamChatParams,
} from '../../src/main/llm/orchestrator';
import { ToolRegistry } from '../../src/main/tools/registry';
import type { MCPManager } from '../../src/main/mcp/manager';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import { defaults } from '../../src/main/config/schema';
import { z } from 'zod';
import {
  createCanonicalToolResult,
  genericToolResultDataSchema,
  serializeCanonicalResultForRetrieval,
  type ToolExecutionResult,
} from '../../src/shared/types/tool-result';

function canonicalStreamOutput(
  content: string,
  status: 'complete' | 'error' = 'complete',
): ToolExecutionResult {
  const canonical = status === 'error'
    ? createCanonicalToolResult('generic', {
        status,
        data: { value: content },
        error: { code: 'fixture_error', message: content },
      })
    : createCanonicalToolResult('generic', {
        status,
        data: { value: content },
      });
  return {
    canonical,
    agentProjection: { content, completeness: 'complete' },
  };
}

// ---------------------------------------------------------------------------
// AI SDK mock (streamChat imports `ai` via importESM)
// ---------------------------------------------------------------------------

const aiSdkMocks = vi.hoisted(() => {
  const streamText = vi.fn();
  const wrapLanguageModel = vi.fn(({ model }: { model: unknown }) => model);
  const isStepCount = vi.fn((count: number) => ({ type: 'step-count' as const, count }));
  return { streamText, wrapLanguageModel, isStepCount };
});

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async (specifier: string) => {
    if (specifier === 'ai') {
      return {
        streamText: aiSdkMocks.streamText,
        wrapLanguageModel: aiSdkMocks.wrapLanguageModel,
        isStepCount: aiSdkMocks.isStepCount,
      };
    }
    throw new Error(`Unexpected importESM specifier in test: ${specifier}`);
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,...overrides,
  };
}

function makeToolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

/** Dispatch request for executeToolCall (pre-parsed args or raw JSON string). */
function makeDispatchCall(
  id: string,
  name: string,
  args: unknown = {},
): ToolDispatchRequest {
  return { id, name, args };
}

function makeAssistantToolCallMessage(toolCalls: ToolCall[], content: string = ''): Message {
  return makeMessage({
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TOOL_CALL,
    tool_calls: toolCalls,
  });
}

function makeToolResultMessage(toolCallId: string, content: string): Message {
  return makeMessage({
    role: MessageRole.TOOL,
    content,
    type: MessageType.TOOL_RESULT,
    tool_call_id: toolCallId,
  });
}

function makeThinkingMessage(content: string): Message {
  return makeMessage({
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.THINKING,
  });
}

function makeUserMessage(content: string): Message {
  return makeMessage({
    role: MessageRole.USER,
    content,
    type: MessageType.TEXT,
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: 'general',
    type: AgentType.INTERNAL,
    tier: AgentTier.BLOOM,
    description: 'General agent',
    allowed_tools: ['*'],
    allowed_skills: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// History conversion tests
// ---------------------------------------------------------------------------

describe('toApiMessages', () => {
  it('converts simple text messages', () => {
    const messages = [
      makeUserMessage('Hello'),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Hi there!' }),
    ];

    const result = toApiMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
  });

  it('drops ERROR messages', () => {
    const messages = [
      makeUserMessage('Hello'),
      makeMessage({ role: MessageRole.ASSISTANT, content: '', type: MessageType.ERROR }),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Response' }),
    ];

    const result = toApiMessages(messages);
    expect(result).toHaveLength(2);
  });

  it('drops empty TOOL_CALL messages', () => {
    const messages = [
      makeUserMessage('Hello'),
      makeMessage({
        role: MessageRole.ASSISTANT,
        content: '',
        type: MessageType.TOOL_CALL,
        tool_calls: [],
      }),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Response' }),
    ];

    const result = toApiMessages(messages);
    expect(result).toHaveLength(2);
  });

  describe('pairing invariant', () => {
    it('preserves properly paired tool_call/tool_result', () => {
      const tc = makeToolCall('tc-1', 'read', '{"path":"/test"}');
      const messages = [
        makeUserMessage('Read the file'),
        makeAssistantToolCallMessage([tc], 'Let me read it'),
        makeToolResultMessage('tc-1', 'file contents'),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Here is the file' }),
      ];

      const result = toApiMessages(messages);

      // user, assistant(tool_calls), tool(result), assistant(final)
      expect(result).toHaveLength(4);
      expect(result[1].tool_calls).toHaveLength(1);
      expect(result[1].tool_calls![0].id).toBe('tc-1');
      expect(result[2].role).toBe('tool');
      expect(result[2].tool_call_id).toBe('tc-1');
    });

    it('drops orphaned TOOL_RESULT (no preceding assistant tool_calls)', () => {
      const messages = [
        makeUserMessage('Hello'),
        makeToolResultMessage('tc-orphan', 'orphaned result'),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Response' }),
      ];

      const result = toApiMessages(messages);

      // The orphaned tool result should be dropped
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });

    it('drops orphaned TOOL_RESULT when result appears after a non-tool message', () => {
      // Sequence: assistant(tool_calls=[A]) -> user -> tool(A)
      // The user message breaks the sequence, so tool(A) is orphaned
      const tc = makeToolCall('tc-1', 'read');
      const messages = [
        makeUserMessage('Read the file'),
        makeAssistantToolCallMessage([tc]),
        makeUserMessage('Actually, never mind'), // breaks sequence
        makeToolResultMessage('tc-1', 'file contents'), // orphaned
        makeMessage({ role: MessageRole.ASSISTANT, content: 'OK' }),
      ];

      const result = toApiMessages(messages);

      // user, assistant(tool_calls filtered out - no result), user, assistant
      // The tool_calls on the assistant message should be filtered since
      // the result is orphaned
      expect(result).toHaveLength(3); // user, user, assistant
      // The first assistant message should have tool_calls filtered
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('user');
      expect(result[2].role).toBe('assistant');
    });

    it('filters dangling tool_calls (no following tool result)', () => {
      const tc = makeToolCall('tc-1', 'read');
      const messages = [
        makeUserMessage('Read the file'),
        makeAssistantToolCallMessage([tc], 'Let me read it'),
        // No tool result — interrupted turn
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Response' }),
      ];

      const result = toApiMessages(messages);

      // The assistant message with dangling tool_calls should have
      // tool_calls filtered out
      expect(result).toHaveLength(3); // user, assistant(no tool_calls), assistant
      expect(result[1].tool_calls).toBeUndefined();
    });

    it('drops assistant message entirely if all tool_calls are dangling and no content', () => {
      const tc = makeToolCall('tc-1', 'read');
      const messages = [
        makeUserMessage('Read the file'),
        makeAssistantToolCallMessage([tc]), // no content, dangling tool_calls
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Response' }),
      ];

      const result = toApiMessages(messages);

      // The empty assistant message should be dropped entirely
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
      expect(result[1].content).toBe('Response');
    });

    it('handles THINKING between tool_calls and tool_result without breaking pairing', () => {
      const tc = makeToolCall('tc-1', 'read');
      const messages = [
        makeUserMessage('Read the file'),
        makeAssistantToolCallMessage([tc]),
        makeThinkingMessage('Thinking about the result...'), // intervening thinking
        makeToolResultMessage('tc-1', 'file contents'),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Here is the file' }),
      ];

      const result = toApiMessages(messages);

      // All should be preserved — THINKING doesn't break the sequence
      expect(result).toHaveLength(5);
      expect(result[1].tool_calls).toHaveLength(1);
      expect(result[2].role).toBe('assistant'); // thinking as assistant content
      expect(result[3].role).toBe('tool');
    });

    it('handles multiple tool_calls in a single message', () => {
      const tc1 = makeToolCall('tc-1', 'read');
      const tc2 = makeToolCall('tc-2', 'grep');
      const messages = [
        makeUserMessage('Read and grep'),
        makeAssistantToolCallMessage([tc1, tc2]),
        makeToolResultMessage('tc-1', 'file contents'),
        makeToolResultMessage('tc-2', 'grep results'),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Done' }),
      ];

      const result = toApiMessages(messages);

      expect(result).toHaveLength(5);
      expect(result[1].tool_calls).toHaveLength(2);
      expect(result[2].tool_call_id).toBe('tc-1');
      expect(result[3].tool_call_id).toBe('tc-2');
    });

    it('match-set only keeps surviving tool_call ids (partial filter)', () => {
      // Only tc-1 received a result; tc-2 must be stripped from emitted
      // tool_calls. Match-set is rebuilt from that surviving set (not the
      // unfiltered msg.tool_calls) so pairing stays consistent with emit.
      const tc1 = makeToolCall('tc-1', 'read');
      const tc2 = makeToolCall('tc-2', 'grep');
      const messages = [
        makeUserMessage('Read and grep'),
        makeAssistantToolCallMessage([tc1, tc2], 'Let me check'),
        makeToolResultMessage('tc-1', 'file contents'),
        // tc-2 dangling — interrupted before result
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Done with partial tools' }),
      ];

      const result = toApiMessages(messages);

      expect(result).toHaveLength(4);
      expect(result[1].tool_calls).toHaveLength(1);
      expect(result[1].tool_calls![0].id).toBe('tc-1');
      expect(result[1].tool_calls!.some((tc) => tc.id === 'tc-2')).toBe(false);
      expect(result[2].tool_call_id).toBe('tc-1');
      expect(result[3].content).toBe('Done with partial tools');
    });
  });

  describe('THINKING replay', () => {
    it('replays THINKING as assistant content with reasoning parts', () => {
      const messages = [
        makeUserMessage('Hello'),
        makeThinkingMessage('Let me think about this...'),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Here is my answer' }),
      ];

      const result = toApiMessages(messages);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Let me think about this...' },
        ],
      });
    });

    it('skips empty THINKING messages', () => {
      const messages = [
        makeUserMessage('Hello'),
        makeThinkingMessage(''),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Response' }),
      ];

      const result = toApiMessages(messages);
      expect(result).toHaveLength(2);
    });

    it('preserves THINKING as reasoning content without breaking tool pairing', () => {
      const tc = makeToolCall('tc-1', 'read');
      const messages = [
        makeUserMessage('Read the file'),
        makeThinkingMessage('I need to read this file first'),
        makeAssistantToolCallMessage([tc]),
        makeToolResultMessage('tc-1', 'contents'),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Done' }),
      ];

      const result = toApiMessages(messages);

      expect(result).toHaveLength(5);
      // Thinking should be replayed as reasoning content
      expect(result[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I need to read this file first' },
        ],
      });
      // Tool calls should still be paired
      expect(result[2].tool_calls).toHaveLength(1);
      expect(result[3].tool_call_id).toBe('tc-1');
    });
  });
});

// ---------------------------------------------------------------------------
// Tool dispatch tests
// ---------------------------------------------------------------------------

const TEST_TOOL_CWD = '/tmp/orchid-tool-test-cwd';

describe('executeToolCall', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('executes a tool and returns a canonical execution result', async () => {
    registry.register(
      {
        name: 'echo',
        riskClass: 'read-only',
        description: 'Echo input',
        inputSchema: z.object({ text: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'test',
      },
      async (input) => {
        const args = input as { text: string };
        return { status: 'complete', data: { value: `Echo: ${args.text}` } };
      },
    );

    const toolCall = makeDispatchCall('tc-1', 'echo', { text: 'hello' });
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.canonical).toMatchObject({
      schemaVersion: 1,
      family: 'generic',
      status: 'complete',
      data: { value: 'Echo: hello' },
    });
    expect(result.agentProjection).toMatchObject({ completeness: 'complete' });
    expect(result.agentProjection.content).toContain('<tool_result name="echo" status="complete">');
    expect(result.agentProjection.content).toContain('<data>Echo: hello</data>');
  });

  it('validates typed canonical data before returning the execution wrapper', async () => {
    registry.register(
      {
        name: 'typed',
        riskClass: 'read-only',
        description: 'Typed result',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: z.object({ value: z.number() }).strict(),
        category: 'test',
      },
      async () => ({ status: 'complete', data: { value: 'wrong' } }),
    );

    const result = await executeToolCall(
      makeDispatchCall('typed-call', 'typed'),
      registry,
      { cwd: TEST_TOOL_CWD },
    );

    expect(result.canonical.status).toBe('error');
    expect(result.canonical.family).toBe('generic');
    expect(result.agentProjection.content).toContain('invalid result');
  });

  it('maps parent cancellation to cancelled without turning it into model error output', async () => {
    const parentAbort = new AbortController();
    registry.register(
      {
        name: 'abortable',
        riskClass: 'read-only',
        description: 'Waits for cancellation',
        inputSchema: z.object({}),
        category: 'test',
      },
      async (_input, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal?.aborted) return resolve();
          ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'late success';
      },
    );

    const pending = executeToolCall(
      makeDispatchCall('cancel-call', 'abortable'),
      registry,
      { cwd: TEST_TOOL_CWD, abortSignal: parentAbort.signal },
    );
    parentAbort.abort();
    const result = await pending;

    expect(result.canonical.status).toBe('cancelled');
    expect(result.agentProjection.content).toContain('cancelled');
  });

  it('materializes and verifies deterministic canonical recovery before a partial projection', async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-retrieval-'));
    _setResultRetrievalCacheRootForTests(cacheRoot);
    registry.register(
      {
        name: 'bounded',
        riskClass: 'read-only',
        description: 'Bounds agent output',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        agentProjector: () => ({
          content: 'bounded preview',
          completeness: 'partial',
          retrieval: {
            kind: 'cache',
            path: 'pending',
            instructions: ['pending'],
          },
        }),
        category: 'test',
      },
      async () => ({
        status: 'complete',
        data: { value: { last: 'preserved', first: 'preserved' } },
      }),
    );

    try {
      const call = makeDispatchCall('stable-provider-call-id', 'bounded');
      const first = await executeToolCall(call, registry, {
        cwd: TEST_TOOL_CWD,
        sessionId: 'session-1',
      });
      const second = await executeToolCall(call, registry, {
        cwd: TEST_TOOL_CWD,
        sessionId: 'session-1',
      });

      expect(first.agentProjection.completeness).toBe('partial');
      expect(second.agentProjection).toEqual(first.agentProjection);
      if (first.agentProjection.completeness !== 'partial') {
        throw new Error('Expected partial projection');
      }
      expect(first.agentProjection.retrieval.kind).toBe('cache');
      if (first.agentProjection.retrieval.kind !== 'cache') {
        throw new Error('Expected cache retrieval');
      }
      const recoveryPath = first.agentProjection.retrieval.path;
      expect(fs.readFileSync(recoveryPath, 'utf-8')).toBe(
        serializeCanonicalResultForRetrieval(first.canonical),
      );
      expect(first.agentProjection.content).toContain(recoveryPath);
    } finally {
      _setResultRetrievalCacheRootForTests(null);
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a complete generic projection when recovery cache write fails', async () => {
    const blocker = path.join(os.tmpdir(), `orchid-cache-blocker-${Date.now()}`);
    fs.writeFileSync(blocker, 'not a directory');
    _setResultRetrievalCacheRootForTests(blocker);
    registry.register(
      {
        name: 'partial_with_cache',
        riskClass: 'read-only',
        description: 'Produces a partial projection expecting cache recovery',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        agentProjector: () => ({
          content: 'partial preview',
          completeness: 'partial',
          retrieval: {
            kind: 'cache',
            path: 'pending',
            instructions: ['pending'],
          },
        }),
        category: 'test',
      },
      async () => ({
        status: 'complete',
        data: { value: { detail: 'full canonical data' } },
      }),
    );

    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = await executeToolCall(
        makeDispatchCall('cache-fail-call', 'partial_with_cache'),
        registry,
        { cwd: TEST_TOOL_CWD, sessionId: 'session-cache-fail' },
      );

      expect(result.agentProjection.completeness).toBe('complete');
      if (result.agentProjection.completeness === 'partial') {
        throw new Error('Expected complete fallback, got partial');
      }
      expect(
        'retrieval' in result.agentProjection &&
          result.agentProjection.retrieval?.kind === 'cache',
      ).toBe(false);
      expect(result.agentProjection.content).toContain('full canonical data');
      warn.mockRestore();
    } finally {
      _setResultRetrievalCacheRootForTests(null);
      fs.rmSync(blocker, { force: true });
    }
  });

  it('offloads only an oversized agent projection and leaves canonical data complete inline', async () => {
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-projection-offload-'));
    _setToolOutputCacheRootForTests(cacheHome);
    const canonicalOnly = 'CANONICAL_ONLY_SENTINEL';
    const largeProjection = `${'agent '.repeat(5_000)}projection-end`;
    registry.register(
      {
        name: 'large_projected',
        riskClass: 'read-only',
        description: 'Large projection',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        agentProjector: () => ({
          content: largeProjection,
          completeness: 'complete',
        }),
        category: 'test',
      },
      async () => ({
        status: 'complete',
        data: { value: { canonicalOnly } },
      }),
    );

    try {
      const result = await executeToolCall(
        makeDispatchCall('provider-offload-call', 'large_projected'),
        registry,
        { cwd: TEST_TOOL_CWD, sessionId: 'session-offload' },
      );

      expect(result.canonical).toEqual(
        createCanonicalToolResult('generic', {
          status: 'complete',
          data: { value: { canonicalOnly } },
        }),
      );
      expect(result.agentProjection.content).not.toContain(canonicalOnly);
      expect(result.agentProjection.content).toContain('was written to');
      expect(result.agentProjection.completeness).toBe('partial');
      if (result.agentProjection.completeness !== 'partial') {
        throw new Error('Expected offloaded projection to be partial');
      }
      expect(result.agentProjection.retrieval.kind).toBe('cache');
      if (result.agentProjection.retrieval.kind !== 'cache') {
        throw new Error('Expected cache retrieval');
      }
      expect(fs.readFileSync(result.agentProjection.retrieval.path, 'utf-8')).toBe(
        largeProjection,
      );
    } finally {
      _setToolOutputCacheRootForTests(null);
      fs.rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it('handles invalid JSON arguments', async () => {
    const toolCall = makeDispatchCall('tc-1', 'echo', 'not-json');
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.agentProjection.content).toContain('invalid JSON');
  });

  it('handles non-object arguments', async () => {
    const toolCall = makeDispatchCall('tc-1', 'echo', '"just a string"');
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.agentProjection.content).toContain('must be a JSON object');
  });

  it('handles unknown tool', async () => {
    const toolCall = makeDispatchCall('tc-1', 'nonexistent', {});
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.agentProjection.content).toContain("does not exist");
  });

  it('rejects invalid args via Zod validation on the agent path', async () => {
    const handler = vi.fn(async () => 'should not run');
    registry.register(
      {
        name: 'echo',
        riskClass: 'read-only',
        description: 'Echo input',
        inputSchema: z.object({ text: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'test',
      },
      handler,
    );

    const toolCall = makeDispatchCall('tc-1', 'echo', {});
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('Invalid arguments');
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes Zod-parsed data to the handler on the agent path', async () => {
    const handler = vi.fn(async (input) => {
      const args = input as { text: string; count?: number };
      return { status: 'complete', data: { value: `Echo: ${args.text} x${args.count ?? 1}` } };
    });
    registry.register(
      {
        name: 'echo',
        riskClass: 'read-only',
        description: 'Echo input',
        inputSchema: z.object({
          text: z.string(),
          count: z.number().optional().default(1),
        }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'test',
      },
      handler,
    );

    const toolCall = makeDispatchCall('tc-1', 'echo', { text: 'hi' });
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('<data>Echo: hi x1</data>');
    expect(handler).toHaveBeenCalledWith(
      { text: 'hi', count: 1 },
      expect.objectContaining({ cwd: TEST_TOOL_CWD }),
    );
  });

  it('handles tool execution error', async () => {
    registry.register(
      {
        name: 'fail',
        riskClass: 'read-only',
        description: 'Always fails',
        inputSchema: z.object({}),
        category: 'test',
      },
      async () => {
        throw new Error('Tool failed!');
      },
    );

    const toolCall = makeDispatchCall('tc-1', 'fail', {});
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.agentProjection.content).toContain('internal error');
    expect(result.canonical.status).toBe('error');
  });

  describe('timeout', () => {
    it('times out tools exceeding the timeout', async () => {
      registry.register(
        {
          name: 'slow',
          riskClass: 'read-only',
          description: 'Slow tool',
          inputSchema: z.object({}),
          category: 'test',
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return 'done';
        },
      );

      const toolCall = makeDispatchCall('tc-1', 'slow', {});
      const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD, 
        timeoutSeconds: 0.1, // 100ms timeout
      });

      expect(result.agentProjection.content).toContain('timed out');
      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain("Tool 'slow' timed out after");
    }, 10000);

    it('rejects zero/negative timeout immediately', async () => {
      registry.register(
        {
          name: 'instant',
          riskClass: 'read-only',
          description: 'Would run if not timed out',
          inputSchema: z.object({}),
          category: 'test',
        },
        async () => 'done',
      );

      const toolCall = makeDispatchCall('tc-1', 'instant', {});
      const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD, 
        timeoutSeconds: 0,
      });

      expect(result.agentProjection.content).toContain('timed out');
      expect(result.canonical.status).toBe('error');
    });

    it('skips timeout when definition.noTimeout is set', async () => {
      registry.register(
        {
          name: 'custom_long',
          riskClass: 'read-only',
          description: 'Long-running exempt tool',
          inputSchema: z.object({}),
          resultFamily: 'generic',
          outputDataSchema: genericToolResultDataSchema,
          category: 'test',
          noTimeout: true,
        },
        async () => ({ status: 'complete', data: { value: 'ok' } }),
      );

      const toolCall = makeDispatchCall('tc-1', 'custom_long', {});
      const result = await executeToolCall(toolCall, registry, {
        cwd: TEST_TOOL_CWD,
        timeoutSeconds: 0.001,
      });

      expect(result.agentProjection.content).toContain('<data>ok</data>');
    });

    it('applies outer timeout to wait_for_subagent (no noTimeout on definition)', async () => {
      registry.register(
        {
          name: 'wait_for_subagent',
          riskClass: 'read-only',
          description: 'Wait tool',
          inputSchema: z.object({}),
          category: 'test',
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return 'never';
        },
      );

      const toolCall = makeDispatchCall('tc-1', 'wait_for_subagent', {});
      const result = await executeToolCall(toolCall, registry, {
        cwd: TEST_TOOL_CWD,
        waitTimeoutSeconds: 0.05,
      });

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('timed out');
      expect(result.agentProjection.content).toContain('wait_for_subagent');
    }, 10000);

    it('skips timeout only when definition.noTimeout is set (no name-based set)', async () => {
      registry.register(
        {
          name: 'read_output',
          riskClass: 'read-only',
          description: 'Read output tool without noTimeout flag',
          inputSchema: z.object({}),
          resultFamily: 'generic',
          outputDataSchema: genericToolResultDataSchema,
          category: 'test',
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: 'complete', data: { value: 'output' } };
        },
      );

      // Name alone no longer exempts — without noTimeout the short budget fires.
      const timed = await executeToolCall(
        makeDispatchCall('tc-1', 'read_output', {}),
        registry,
        { cwd: TEST_TOOL_CWD, timeoutSeconds: 0.001 },
      );
      expect(timed.agentProjection.content).toContain('timed out');

      registry.register(
        {
          name: 'read_output_exempt',
          riskClass: 'read-only',
          description: 'Read output with definition flag',
          inputSchema: z.object({}),
          resultFamily: 'generic',
          outputDataSchema: genericToolResultDataSchema,
          category: 'test',
          noTimeout: true,
        },
        async () => ({ status: 'complete', data: { value: 'output' } }),
      );

      const result = await executeToolCall(
        makeDispatchCall('tc-2', 'read_output_exempt', {}),
        registry,
        { cwd: TEST_TOOL_CWD, timeoutSeconds: 0.001 },
      );
      expect(result.agentProjection.content).toContain('<data>output</data>');
    });

    it('aborts tool context signal on outer timeout so process tools can kill children', async () => {
      let sawAbort = false;
      registry.register(
        {
          name: 'slow_abortable',
          riskClass: 'read-only',
          description: 'Slow tool that listens for abort',
          inputSchema: z.object({}),
          category: 'test',
        },
        async (_input, ctx) => {
          await new Promise<void>((resolve) => {
            if (ctx.abortSignal?.aborted) {
              sawAbort = true;
              resolve();
              return;
            }
            ctx.abortSignal?.addEventListener(
              'abort',
              () => {
                sawAbort = true;
                resolve();
              },
              { once: true },
            );
            setTimeout(resolve, 5000);
          });
          return 'done';
        },
      );

      const toolCall = makeDispatchCall('tc-1', 'slow_abortable', {});
      const result = await executeToolCall(toolCall, registry, {
        cwd: TEST_TOOL_CWD,
        timeoutSeconds: 0.1,
      });

      expect(result.agentProjection.content).toContain('timed out');
      expect(result.canonical.status).toBe('error');
      expect(sawAbort).toBe(true);
    }, 10_000);
  });
});

describe('output offloading', () => {
  it('passes through small outputs unchanged', () => {
    const content = 'small output';
    const result = maybeOffloadToolOutput('test', content, 'tc-1', 'session-1');
    expect(result).toBe(content);
  });

  it('passes through exempt tool outputs unchanged regardless of size', () => {
    const content = 'x'.repeat(30_000); // >20KB
    const result = maybeOffloadToolOutput('read', content, 'tc-1', 'session-1');
    expect(result).toBe(content);
  });

  it('passes through all exempt tools', () => {
    const content = 'x'.repeat(30_000);
    const exemptTools = ['read', 'grep', 'glob', 'directory_tree', 'web_fetch', 'skill', 'wait_for_subagent'];
    
    for (const tool of exemptTools) {
      const result = maybeOffloadToolOutput(tool, content, 'tc-1', 'session-1');
      expect(result).toBe(content);
    }
  });

  it('truncates large output when no session ID', () => {
    const content = 'x'.repeat(30_000);
    const result = maybeOffloadToolOutput('execute_command', content, 'tc-1');

    expect(result).toContain('truncated');
    expect(result).toContain('30000');
    expect(result.length).toBeLessThan(content.length);
  });

  it('writes large output to cache file when session ID provided', () => {
    const sessionId = 'test-session-' + Date.now();
    const content = 'x'.repeat(30_000);
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-tool-cache-'));
    _setToolOutputCacheRootForTests(testHome);

    try {
      const result = maybeOffloadToolOutput('execute_command', content, 'tc-1', sessionId);

      expect(result).toContain('file=');
      expect(result).toContain('30000');
      expect(result).toContain('warning');

      const cacheDir = path.join(testHome, '.orchid', 'cache', 'tool-output', sessionId);
      expect(fs.existsSync(cacheDir)).toBe(true);

      const files = fs.readdirSync(cacheDir);
      expect(files.length).toBe(1);
      expect(files[0]).toContain('execute_command');

      const filePath = path.join(cacheDir, files[0]);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
    } finally {
      _setToolOutputCacheRootForTests(null);
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('falls back to truncation when cache write fails', () => {
    const content = 'x'.repeat(30_000);
    // Use an invalid path to trigger cache write failure
    const result = maybeOffloadToolOutput(
      'execute_command',
      content,
      'tc-1',
      'session-with-invalid-\0-chars',
    );

    // Should fall back to truncation (contains "Truncated below" in the output)
    expect(result).toContain('Truncated below');
    expect(result).toContain('cache write failed');
  });
});

// ---------------------------------------------------------------------------
// Tool registry integration tests
// ---------------------------------------------------------------------------

describe('ToolRegistry integration with dispatch', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('executes registered tool with correct args', async () => {
    const handler = vi.fn(async () => 'result');
    registry.register(
      {
        name: 'test_tool',
        riskClass: 'read-only',
        description: 'Test',
        inputSchema: z.object({ query: z.string() }),
        category: 'test',
      },
      handler,
    );

    const toolCall = makeDispatchCall('tc-1', 'test_tool', { query: 'hello' });
    await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(handler).toHaveBeenCalledWith({ query: 'hello' }, expect.objectContaining({ cwd: TEST_TOOL_CWD }));
  });

  it('returns error for unregistered tool', async () => {
    registry.register(
      {
        name: 'existing',
        riskClass: 'read-only',
        description: 'Exists',
        inputSchema: z.object({}),
        category: 'test',
      },
      async () => 'ok',
    );

    const toolCall = makeDispatchCall('tc-1', 'nonexistent', {});
    const result = await executeToolCall(toolCall, registry, { cwd: TEST_TOOL_CWD });

    expect(result.agentProjection.content).toContain('does not exist');
    expect(result.agentProjection.content).toContain('existing');
  });

  it('buildToolMap exposes AI SDK-compatible input schemas', async () => {
    const inputSchema = z.object({ query: z.string() });
    registry.register(
      {
        name: 'test_tool',
        riskClass: 'read-only',
        description: 'Test',
        inputSchema,
        category: 'test',
      },
      async () => 'ok',
    );

    const tools = buildToolMap(['test_tool'], registry, null, {});
    const { asSchema } = await import('ai');
    const testTool = tools.test_tool as { inputSchema: z.ZodType };

    expect(testTool.inputSchema).toBe(inputSchema);
    const jsonSchema = await Promise.resolve(
      asSchema(testTool.inputSchema).jsonSchema,
    );
    expect(jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    });
  });

  it('buildToolMap keeps canonical output raw while toModelOutput exposes only the projection', async () => {
    const canonicalOnly = 'CANONICAL_ONLY_SENTINEL';
    registry.register(
      {
        name: 'projected',
        riskClass: 'read-only',
        description: 'Projection boundary',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        agentProjector: () => ({
          content: 'agent-visible summary',
          completeness: 'complete',
        }),
        category: 'test',
      },
      async () => ({
        status: 'complete',
        data: { value: { canonicalOnly } },
      }),
    );

    const tools = buildToolMap(['projected'], registry, null, {
      cwd: TEST_TOOL_CWD,
    });
    const projected = tools.projected as unknown as {
      outputSchema: z.ZodType;
      execute: (
        input: unknown,
        options: { toolCallId: string },
      ) => Promise<ToolExecutionResult>;
      toModelOutput: (options: {
        toolCallId: string;
        input: unknown;
        output: ToolExecutionResult;
      }) => PromiseLike<unknown> | unknown;
    };

    const execution = await projected.execute({}, { toolCallId: 'provider-call-123' });
    expect(projected.outputSchema.parse(execution)).toEqual(execution);
    expect(JSON.stringify(execution.canonical)).toContain(canonicalOnly);

    const modelOutput = await projected.toModelOutput({
      toolCallId: 'provider-call-123',
      input: {},
      output: execution,
    });
    expect(modelOutput).toEqual({ type: 'text', value: 'agent-visible summary' });
    expect(JSON.stringify(modelOutput)).not.toContain(canonicalOnly);
  });

  it('toModelOutput uses error-text only for canonical error, not cancellation', async () => {
    registry.register(
      {
        name: 'status_result',
        riskClass: 'read-only',
        description: 'Status result',
        inputSchema: z.object({ status: z.enum(['error', 'cancelled']) }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'test',
      },
      async (input) => {
        const { status } = input as { status: 'error' | 'cancelled' };
        return status === 'error'
          ? {
              status,
              data: { value: null },
              error: { code: 'expected', message: 'expected failure' },
            }
          : { status, data: { value: null } };
      },
    );
    const tool = buildToolMap(['status_result'], registry, null, {
      cwd: TEST_TOOL_CWD,
    }).status_result as unknown as {
      execute: (
        input: unknown,
        options: { toolCallId: string },
      ) => Promise<ToolExecutionResult>;
      toModelOutput: (options: { output: ToolExecutionResult }) => unknown;
    };

    const failed = await tool.execute(
      { status: 'error' },
      { toolCallId: 'error-call' },
    );
    const cancelled = await tool.execute(
      { status: 'cancelled' },
      { toolCallId: 'cancel-call' },
    );

    expect(await tool.toModelOutput({ output: failed })).toMatchObject({
      type: 'error-text',
      value: failed.agentProjection.content,
    });
    expect(await tool.toModelOutput({ output: cancelled })).toMatchObject({
      type: 'text',
      value: cancelled.agentProjection.content,
    });
  });

  it('buildToolMap exposes stable provider-safe MCP aliases and routes them internally', async () => {
    const internalNames = [
      'mcp::context7::query.docs',
      'mcp::context7::query docs',
      `mcp::long-server::${'very-long-tool-name-'.repeat(5)}ç`,
    ];
    const callTool = vi.fn(async () => 'ok');
    const mcpManager = {
      getTools: () => internalNames.map((name, index) => ({
        definition: {
          name,
          riskClass: 'read-only',
          description: `MCP tool ${index}`,
          inputSchema: z.object({ query: z.string().optional() }),
          resultFamily: 'generic',
          outputDataSchema: genericToolResultDataSchema,
          category: 'mcp',
        },
        handler: vi.fn(async (input: unknown, ctx: { abortSignal?: AbortSignal }) =>
          callTool(name, input, { signal: ctx.abortSignal })),
      })),
      callTool,
    } as unknown as MCPManager;

    const firstBuild = buildToolMap(['*'], registry, mcpManager, {
      cwd: TEST_TOOL_CWD,
    });
    const secondBuild = buildToolMap(['*'], registry, mcpManager, {
      cwd: TEST_TOOL_CWD,
    });
    const aliases = Object.keys(firstBuild);

    expect(aliases).toHaveLength(internalNames.length);
    expect(aliases).toEqual(Object.keys(secondBuild));
    expect(new Set(aliases).size).toBe(internalNames.length);
    for (const alias of aliases) {
      expect(alias).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(alias).not.toContain('::');
    }

    const routedMcpTool = firstBuild[aliases[0]] as unknown as {
      execute: (input: unknown) => Promise<ToolExecutionResult>;
    };
    const routedResult = await routedMcpTool.execute({ query: 'routing check' });

    expect(callTool).toHaveBeenCalledWith(
      internalNames[0],
      { query: 'routing check' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(routedResult.agentProjection.content).toContain(
      '<tool_result name="mcp::context7::query.docs"',
    );
    expect(routedResult.agentProjection.content).not.toContain(aliases[0]);
  });
});

// ---------------------------------------------------------------------------
// History edge cases
// ---------------------------------------------------------------------------

describe('toApiMessages edge cases', () => {
  it('handles empty message array', () => {
    const result = toApiMessages([]);
    expect(result).toHaveLength(0);
  });

  it('handles messages with only errors', () => {
    const messages = [
      makeMessage({ type: MessageType.ERROR, content: 'Error 1' }),
      makeMessage({ type: MessageType.ERROR, content: 'Error 2' }),
    ];

    const result = toApiMessages(messages);
    expect(result).toHaveLength(0);
  });

  it('handles complex multi-turn conversation with mixed content', () => {
    const tc1 = makeToolCall('tc-1', 'read');
    const tc2 = makeToolCall('tc-2', 'grep');

    const messages = [
      makeUserMessage('Read file and grep'),
      makeThinkingMessage('Let me think...'),
      makeAssistantToolCallMessage([tc1, tc2], 'I will read and grep'),
      makeToolResultMessage('tc-1', 'file contents'),
      makeToolResultMessage('tc-2', 'grep results'),
      makeThinkingMessage('Now analyzing...'),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Here are the results' }),
      makeUserMessage('Thanks!'),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'You are welcome!' }),
    ];

    const result = toApiMessages(messages);

    // user, thinking, assistant(tool_calls), tool(1), tool(2), thinking, assistant, user, assistant
    expect(result).toHaveLength(9);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant'); // thinking
    expect(result[2].role).toBe('assistant');
    expect(result[2].tool_calls).toHaveLength(2);
    expect(result[3].role).toBe('tool');
    expect(result[4].role).toBe('tool');
    expect(result[5].role).toBe('assistant'); // thinking
    expect(result[6].role).toBe('assistant');
    expect(result[7].role).toBe('user');
    expect(result[8].role).toBe('assistant');
  });
});

// ---------------------------------------------------------------------------
// streamChat — fullStream event mapping (mocked AI SDK)
// ---------------------------------------------------------------------------

type FullStreamPart = Record<string, unknown>;

type MockStepFinish = {
  usage?: {
    inputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokens?: number;
    totalTokens?: number;
  };
  request?: { messages?: unknown[] };
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
  toolResults?: Array<{
    toolCallId: string;
    output?: unknown;
    result?: unknown;
    error?: unknown;
  }>;
  content?: Array<Record<string, unknown>>;
};

type MockStreamTextOptions = {
  fullStreamParts?: FullStreamPart[];
  /** If set, fullStream throws before yielding any parts (triggers textStream fallback). */
  fullStreamError?: Error;
  /** textStream deltas used when fullStream fails early. */
  textStreamParts?: string[];
  finishReason?: string;
  /** Invoke onStepFinish with one or more payloads when streamText is called. */
  stepFinish?: MockStepFinish | MockStepFinish[];
};

function createAsyncIterable<T>(items: T[], error?: Error): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      if (error) throw error;
      for (const item of items) {
        yield item;
      }
    },
  };
}

function mockStreamTextResult(options: MockStreamTextOptions = {}) {
  const finishReason = options.finishReason ?? 'stop';
  return {
    fullStream: createAsyncIterable(
      options.fullStreamParts ?? [],
      options.fullStreamError,
    ),
    textStream: createAsyncIterable(options.textStreamParts ?? []),
    finishReason: Promise.resolve(finishReason),
  };
}

async function collectStreamEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeStreamChatParams(
  overrides: Partial<StreamChatParams> = {},
): StreamChatParams {
  const registry = overrides.registry ?? new ToolRegistry();
  return {
    messages: overrides.messages ?? [makeUserMessage('Hello')],
    agent: overrides.agent ?? makeAgent({ allowed_tools: [] }),
    systemPrompt: overrides.systemPrompt ?? 'You are a helpful assistant.',
    context: overrides.context ?? { cwd: '/tmp/orchid-test' },
    config: overrides.config ?? defaults(),
    registry,
    mcpManager: overrides.mcpManager ?? null,
    sessionId: overrides.sessionId,
    projectRuntime: overrides.projectRuntime,
    agentScopeId: overrides.agentScopeId,
    abortSignal: overrides.abortSignal,
    modelInstance: overrides.modelInstance ?? ({
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'test-model',
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    } as StreamChatParams['modelInstance']),
  };
}

function setupStreamText(options: MockStreamTextOptions = {}) {
  aiSdkMocks.streamText.mockImplementation((params: {
    onStepFinish?: (step: MockStepFinish) => void | Promise<void>;
  }) => {
    if (options.stepFinish && params.onStepFinish) {
      const steps = Array.isArray(options.stepFinish)
        ? options.stepFinish
        : [options.stepFinish];
      for (const step of steps) {
        void params.onStepFinish(step);
      }
    }
    return mockStreamTextResult(options);
  });
}

describe('prefixProjectInstructionContext', () => {
  it('copies string and array user messages while preserving their source content', () => {
    const envelope = '<project_instructions>rules</project_instructions>';
    const stringMessages: ModelMessage[] = [{ role: 'user', content: 'string task' }];
    const arrayMessages: ModelMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'array task' }],
    }];

    const stringResult = prefixProjectInstructionContext(stringMessages, envelope);
    const arrayResult = prefixProjectInstructionContext(arrayMessages, envelope);

    expect(stringResult.injected).toBe(true);
    expect(stringResult.messages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('string task'),
    });
    expect(arrayResult.injected).toBe(true);
    expect(arrayResult.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining('project_instructions') },
        { type: 'text', text: 'array task' },
      ],
    });
    expect(stringMessages).toEqual([{ role: 'user', content: 'string task' }]);
    expect(arrayMessages).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'array task' }],
    }]);

    const mixed = prefixProjectInstructionContext([
      { role: 'user', content: 'older task' },
      { role: 'user', content: [{ type: 'text', text: 'latest array task' }] },
    ], envelope);
    expect(mixed.messages[0]).toEqual({ role: 'user', content: 'older task' });
    expect(mixed.messages[1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining('project_instructions') },
        { type: 'text', text: 'latest array task' },
      ],
    });
  });

  it('reports when no user/task provider message can receive root instructions', () => {
    const result = prefixProjectInstructionContext([
      { role: 'assistant', content: 'already responded' },
    ], '<project_instructions>rules</project_instructions>');

    expect(result.injected).toBe(false);
  });
});

describe('streamChat', () => {
  beforeEach(() => {
    aiSdkMocks.streamText.mockReset();
    aiSdkMocks.wrapLanguageModel.mockClear();
    aiSdkMocks.isStepCount.mockClear();
  });

  it('yields content events for text-delta parts (text and textDelta aliases)', async () => {
    setupStreamText({
      fullStreamParts: [
        { type: 'text-delta', text: 'Hello' },
        { type: 'text-delta', textDelta: ' world' },
        { type: 'text-delta', text: '' }, // ignored
      ],
      finishReason: 'stop',
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events.filter((e) => e.type === 'content')).toEqual([
      { type: 'content', text: 'Hello' },
      { type: 'content', text: ' world' },
    ]);
    expect(events.filter((event) => event.type === 'usage')).toEqual([]);
    expect(events[events.length - 1]).toEqual({ type: 'finish', finishReason: 'stop' });
  });

  it('adds root instructions only to each stream provider input and leaves source messages untouched', async () => {
    const firstWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-root-instructions-'));
    const secondWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-root-instructions-'));
    fs.writeFileSync(path.join(firstWorkspace, 'AGENTS.md'), 'first stream rule');
    fs.writeFileSync(path.join(secondWorkspace, 'AGENTS.md'), 'second stream rule');
    const firstMessages = [makeUserMessage('first task')];
    const secondMessages = [makeUserMessage('second task')];
    const runtime = (projectDir: string): ProjectRuntime => ({
      projectDir,
      config: defaults(),
      agents: new Map(),
      skills: new Map(),
      personalities: new Map(),
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      setupStreamText();
      await collectStreamEvents(streamChat(makeStreamChatParams({
        messages: firstMessages,
        context: { cwd: firstWorkspace },
        projectRuntime: runtime(firstWorkspace),
      })));
      await collectStreamEvents(streamChat(makeStreamChatParams({
        messages: secondMessages,
        context: { cwd: secondWorkspace },
        projectRuntime: runtime(secondWorkspace),
      })));

      const firstRequest = aiSdkMocks.streamText.mock.calls[0][0] as {
        system: string;
        messages: Array<{ role: string; content: string }>;
      };
      const secondRequest = aiSdkMocks.streamText.mock.calls[1][0] as typeof firstRequest;
      expect(firstRequest.messages.at(-1)?.content).toContain('first stream rule');
      expect(firstRequest.messages.at(-1)?.content).not.toContain('second stream rule');
      expect(secondRequest.messages.at(-1)?.content).toContain('second stream rule');
      expect(secondRequest.messages.at(-1)?.content).not.toContain('first stream rule');
      expect(firstRequest.system).not.toContain('first stream rule');
      expect(firstMessages[0].content).toBe('first task');
      expect(secondMessages[0].content).toBe('second task');
      expect(audit).toHaveBeenCalledWith(
        '[project-instructions] automatic workspace instruction read',
        expect.objectContaining({ toolCallId: 'root', selection: 'AGENTS.md' }),
      );
      expect(JSON.stringify(audit.mock.calls)).not.toContain('first stream rule');
      expect(JSON.stringify(audit.mock.calls)).not.toContain('<project_instructions>');
    } finally {
      audit.mockRestore();
      fs.rmSync(firstWorkspace, { recursive: true, force: true });
      fs.rmSync(secondWorkspace, { recursive: true, force: true });
    }
  });

  it('returns an explicit error instead of acknowledging undeliverable root instructions', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-root-instructions-'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'undeliverable root rule');
    try {
      setupStreamText();
      const events = await collectStreamEvents(streamChat(makeStreamChatParams({
        messages: [makeMessage({ role: MessageRole.ASSISTANT, content: 'no task message' })],
        context: { cwd: workspace },
        projectRuntime: {
          projectDir: workspace,
          config: defaults(),
          agents: new Map(),
          skills: new Map(),
          personalities: new Map(),
        },
      })));

      expect(events).toEqual([{
        type: 'error',
        title: 'Project instruction delivery unavailable',
        detail: expect.stringContaining('project_instruction_root_delivery_unavailable'),
      }]);
      expect(aiSdkMocks.streamText).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('maps tool-input-start/delta/available and tool-output-available', async () => {
    setupStreamText({
      fullStreamParts: [
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'read' },
        { type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"path"' },
        { type: 'tool-input-delta', toolCallId: 'tc-1', delta: ':"/a"}' },
        {
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'read',
          input: { path: '/a' },
        },
        {
          type: 'tool-output-available',
          toolCallId: 'tc-1',
          output: canonicalStreamOutput('file contents'),
        },
        { type: 'text-delta', text: 'Done' },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events.filter((e) => e.type !== 'usage' && e.type !== 'finish')).toEqual([
      { type: 'tool_call_start', toolCallId: 'tc-1', toolName: 'read' },
      { type: 'tool_call_delta', toolCallId: 'tc-1', argsDelta: '{"path"' },
      { type: 'tool_call_delta', toolCallId: 'tc-1', argsDelta: ':"/a"}' },
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read',
        args: JSON.stringify({ path: '/a' }),
      },
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tc-1',
        content: 'file contents',
        execution: canonicalStreamOutput('file contents'),
      }),
      { type: 'content', text: 'Done' },
    ]);
  });

  it('maps tool-output-error and canonical error tool-output-available as errors', async () => {
    setupStreamText({
      fullStreamParts: [
        {
          type: 'tool-output-error',
          toolCallId: 'tc-err',
          errorText: 'Tool boom',
        },
        // Explicit failure from the canonical tool execution payload.
        {
          type: 'tool-output-available',
          toolCallId: 'tc-soft',
          output: canonicalStreamOutput('Tool execution failed', 'error'),
        },
        {
          type: 'tool-output-available',
          toolCallId: 'tc-timeout',
          output: canonicalStreamOutput("Tool 'slow' timed out after 30 seconds", 'error'),
        },
        // Content that looks like an error remains a successful canonical result.
        {
          type: 'tool-output-available',
          toolCallId: 'tc-false-positive',
          output: canonicalStreamOutput('Error: is just text in a successful tool result'),
        },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));
    const results = events.filter((e) => e.type === 'tool_result');

    expect(results).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tc-err',
        content: expect.stringContaining('Tool boom'),
        execution: expect.objectContaining({ canonical: expect.objectContaining({ status: 'error' }) }),
      }),
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tc-soft',
        content: 'Tool execution failed',
        execution: canonicalStreamOutput('Tool execution failed', 'error'),
      }),
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tc-timeout',
        content: "Tool 'slow' timed out after 30 seconds",
        execution: canonicalStreamOutput("Tool 'slow' timed out after 30 seconds", 'error'),
      }),
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tc-false-positive',
        content: 'Error: is just text in a successful tool result',
        execution: canonicalStreamOutput('Error: is just text in a successful tool result'),
      }),
    ]);
  });

  it('maps reasoning-delta / reasoning to thinking events', async () => {
    setupStreamText({
      fullStreamParts: [
        { type: 'reasoning-delta', text: 'Step 1...' },
        { type: 'reasoning', delta: ' Step 2.' },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events.filter((e) => e.type === 'thinking')).toEqual([
      { type: 'thinking', text: 'Step 1...' },
      { type: 'thinking', text: ' Step 2.' },
    ]);
  });

  it('maps stream error parts and classifies known error titles', async () => {
    setupStreamText({
      fullStreamParts: [
        { type: 'error', error: new Error('rate limit exceeded (429)') },
        { type: 'error', errorText: 'request timed out waiting for response' },
        { type: 'error', error: new Error('401 unauthorized') },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));
    const errors = events.filter((e) => e.type === 'error');

    expect(errors).toEqual([
      {
        type: 'error',
        title: 'Rate Limit Exceeded',
        detail: 'rate limit exceeded (429)',
      },
      {
        type: 'error',
        title: 'Request Timed Out',
        detail: 'request timed out waiting for response',
      },
      {
        type: 'error',
        title: 'Authentication Failed',
        detail: '401 unauthorized',
      },
    ]);
  });

  it('supports canonical tool-call / tool-result part types', async () => {
    setupStreamText({
      fullStreamParts: [
        {
          type: 'tool-call',
          id: 'legacy-1',
          toolName: 'grep',
          args: { pattern: 'foo' },
        },
        {
          type: 'tool-result',
          id: 'legacy-1',
          result: canonicalStreamOutput(JSON.stringify({ matches: 2 })),
        },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'legacy-1',
        toolName: 'grep',
        args: JSON.stringify({ pattern: 'foo' }),
      },
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'legacy-1',
        content: JSON.stringify({ matches: 2 }),
        execution: canonicalStreamOutput(JSON.stringify({ matches: 2 })),
      }),
    ]);
  });

  it('maps tool-input-error to tool_call + failed tool_result', async () => {
    setupStreamText({
      fullStreamParts: [
        {
          type: 'tool-input-error',
          toolCallId: 'tc-bad',
          toolName: 'read',
          input: { path: 123 },
          errorText: 'Invalid tool input',
        },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'tc-bad',
        toolName: 'read',
        args: JSON.stringify({ path: 123 }),
      },
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tc-bad',
        content: expect.stringContaining('Invalid tool input'),
        execution: expect.objectContaining({ canonical: expect.objectContaining({ status: 'error' }) }),
      }),
    ]);
  });

  it('adapts a pre-execution SDK tool-error once across fullStream and step finish', async () => {
    const sdkError = 'Invalid tool input: path must be a string';
    const sdkPart = {
      type: 'tool-error',
      toolCallId: 'tc-sdk-error',
      toolName: 'read',
      input: { path: 123 },
      error: sdkError,
      dynamic: true,
    };
    setupStreamText({
      fullStreamParts: [
        {
          type: 'tool-call',
          toolCallId: 'tc-sdk-error',
          toolName: 'read',
          input: { path: 123 },
        },
        sdkPart,
      ],
      stepFinish: {
        toolCalls: [
          {
            toolCallId: 'tc-sdk-error',
            toolName: 'read',
            input: { path: 123 },
          },
        ],
        content: [sdkPart],
      },
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));
    const results = events.filter((event) => event.type === 'tool_result');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'tc-sdk-error',
      content: expect.stringContaining(sdkError),
      execution: {
        canonical: {
          family: 'generic',
          status: 'error',
          error: { code: 'sdk_tool_error', message: sdkError },
        },
        agentProjection: {
          content: expect.stringContaining(sdkError),
          completeness: 'complete',
        },
      },
    });
  });

  it('falls back to textStream when fullStream fails before any part', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupStreamText({
      fullStreamError: new Error('fullStream not supported'),
      textStreamParts: ['fallback', ' text'],
      finishReason: 'stop',
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events.filter((e) => e.type === 'content')).toEqual([
      { type: 'content', text: 'fallback' },
      { type: 'content', text: ' text' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'finish', finishReason: 'stop' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('fullStream failed, falling back to textStream'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('tracks usage from onStepFinish and yields finish reason', async () => {
    setupStreamText({
      fullStreamError: new Error('fullStream unavailable'),
      textStreamParts: ['ok'],
      finishReason: 'length',
      stepFinish: {
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent).toMatchObject({
      type: 'usage',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
        cached_tokens: 0,
        context: {
          input_tokens: 100,
          output_tokens: 40,
          used_tokens: 140,
        },
      },
    });
    expect(events[events.length - 1]).toEqual({ type: 'finish', finishReason: 'length' });
    // usage must come before finish
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const finishIdx = events.findIndex((e) => e.type === 'finish');
    expect(usageIdx).toBeLessThan(finishIdx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('max token limit'),
    );
    warnSpy.mockRestore();
  });

  it('does not duplicate usage when both fullStream and onStepFinish report a step', async () => {
    setupStreamText({
      stepFinish: {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
      fullStreamParts: [
        {
          type: 'start-step',
          request: { messages: [{ role: 'user', content: 'question' }] },
        },
        {
          type: 'finish-step',
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
  });

  it('yields fallback tool-step usage before the next model text', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    aiSdkMocks.streamText.mockImplementation((params: {
      onStepFinish?: (step: MockStepFinish) => void | Promise<void>;
    }) => ({
      fullStream: createAsyncIterable([], new Error('fullStream unavailable')),
      textStream: {
        async *[Symbol.asyncIterator]() {
          await params.onStepFinish?.({
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            toolCalls: [{ toolCallId: 'tc-fallback', toolName: 'read', input: {} }],
            toolResults: [{
              toolCallId: 'tc-fallback',
              output: canonicalStreamOutput('done'),
            }],
          });
          yield 'next step text';
          await params.onStepFinish?.({
            usage: { inputTokens: 180, outputTokens: 30 },
          });
        },
      },
      finishReason: Promise.resolve('stop'),
    }));

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));
    const firstUsageIndex = events.findIndex((event) => event.type === 'usage');
    const nextTextIndex = events.findIndex(
      (event) => event.type === 'content' && event.text === 'next step text',
    );

    expect(events.filter((event) => event.type === 'usage')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
      usage: { total_tokens: 210 },
    });
    expect(firstUsageIndex).toBeGreaterThanOrEqual(0);
    expect(firstUsageIndex).toBeLessThan(nextTextIndex);
    expect(events.slice(0, nextTextIndex).map((event) => event.type)).toEqual([
      'tool_call',
      'tool_result',
      'usage',
    ]);
    warnSpy.mockRestore();
  });

  it('yields usage after each completed model step', async () => {
    setupStreamText({
      fullStreamParts: [
        {
          type: 'start-step',
          request: { messages: [{ role: 'user', content: 'Inspect the project' }] },
          warnings: [],
        },
        { type: 'text-delta', text: 'I will inspect it.' },
        {
          type: 'finish-step',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 100,
            inputTokenDetails: { cacheReadTokens: 25 },
            outputTokens: 20,
            totalTokens: 120,
          },
        },
        {
          type: 'start-step',
          request: {
            messages: [
              { role: 'user', content: 'Inspect the project' },
              { role: 'assistant', content: 'I will inspect it.' },
            ],
          },
          warnings: [],
        },
        { type: 'text-delta', text: 'Inspection complete.' },
        {
          type: 'finish-step',
          finishReason: 'stop',
          usage: {
            inputTokens: 180,
            inputTokenDetails: { cacheReadTokens: 80 },
            outputTokens: 30,
            totalTokens: 210,
          },
        },
      ],
      finishReason: 'stop',
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));
    const usageEvents = events.filter((event) => event.type === 'usage');

    expect(usageEvents).toMatchObject([
      {
        type: 'usage',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cached_tokens: 25,
          context: { input_tokens: 100, output_tokens: 20, used_tokens: 120 },
        },
      },
      {
        type: 'usage',
        usage: {
          prompt_tokens: 180,
          completion_tokens: 30,
          total_tokens: 210,
          cached_tokens: 80,
          context: { input_tokens: 180, output_tokens: 30, used_tokens: 210 },
        },
      },
    ]);
    expect(events.indexOf(usageEvents[0]!)).toBeLessThan(
      events.findIndex(
        (event) => event.type === 'content' && event.text === 'Inspection complete.',
      ),
    );
    expect(events.indexOf(usageEvents[1]!)).toBeLessThan(
      events.findIndex((event) => event.type === 'finish'),
    );
    expect(aiSdkMocks.streamText).toHaveBeenCalledWith(expect.objectContaining({
      include: { requestMessages: true },
    }));
  });

  it('captures provider cache reads and the latest request context snapshot', async () => {
    setupStreamText({
      fullStreamError: new Error('fullStream unavailable'),
      textStreamParts: ['answer'],
      stepFinish: [
        {
          usage: {
            inputTokens: 100,
            inputTokenDetails: { cacheReadTokens: 35 },
            outputTokens: 20,
            totalTokens: 120,
          },
          request: {
            messages: [{ role: 'user', content: 'question' }],
          },
        },
        {
          usage: {
            inputTokens: 180,
            inputTokenDetails: { cacheReadTokens: 80 },
            outputTokens: 30,
            totalTokens: 210,
          },
          request: {
            messages: [
              { role: 'user', content: 'question' },
              { role: 'assistant', content: 'prior answer' },
            ],
          },
        },
      ],
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));
    const usageEvents = events.filter((event) => event.type === 'usage');

    expect(usageEvents).toMatchObject([
      {
        type: 'usage',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cached_tokens: 35,
          context: {
            input_tokens: 100,
            output_tokens: 20,
            used_tokens: 120,
          },
        },
      },
      {
        type: 'usage',
        usage: {
          prompt_tokens: 180,
          completion_tokens: 30,
          total_tokens: 210,
          cached_tokens: 80,
          context: {
            input_tokens: 180,
            output_tokens: 30,
            used_tokens: 210,
          },
        },
      },
    ]);

    const usageEvent = usageEvents.at(-1);
    if (usageEvent?.type !== 'usage' || !usageEvent.usage.context) {
      throw new Error('Expected a context snapshot');
    }
    const context = usageEvent.usage.context;
    expect(
      context.system_tokens +
        context.tools_tokens +
        context.tool_use_tokens +
        context.user_tokens +
        context.assistant_tokens,
    ).toBe(context.used_tokens);
    expect(context.user_tokens).toBeGreaterThan(0);
    expect(context.assistant_tokens).toBeGreaterThanOrEqual(30);
  });

  it('yields pending tool calls/results captured via onStepFinish', async () => {
    setupStreamText({
      fullStreamParts: [{ type: 'text-delta', text: 'after tools' }],
      stepFinish: {
        toolCalls: [
          { toolCallId: 'tc-step', toolName: 'echo', input: { text: 'hi' } },
        ],
        toolResults: [
          { toolCallId: 'tc-step', output: canonicalStreamOutput('hi') },
        ],
      },
    });

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    // onStepFinish fires before/during stream; pending items flush after chunks
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool_call',
          toolCallId: 'tc-step',
          toolName: 'echo',
          args: JSON.stringify({ text: 'hi' }),
        },
        expect.objectContaining({
          type: 'tool_result',
          toolCallId: 'tc-step',
          content: 'hi',
          execution: canonicalStreamOutput('hi'),
        }),
        { type: 'content', text: 'after tools' },
      ]),
    );
  });

  it('yields classified error when fullStream fails after parts began', async () => {
    // Once fullStream has yielded at least one part, further errors are not
    // retried via textStream — they surface through the outer catch.
    aiSdkMocks.streamText.mockImplementation(() => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'partial' };
          throw new Error('usage limit reached');
        },
      },
      textStream: createAsyncIterable(['should-not-appear']),
      finishReason: Promise.resolve('stop'),
    }));

    const events = await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(events).toEqual([
      { type: 'content', text: 'partial' },
      {
        type: 'error',
        title: 'Rate Limit Exceeded',
        detail: 'usage limit reached',
      },
    ]);
  });

  it('wires wrapLanguageModel and stopWhen isStepCount(maxSteps)', async () => {
    setupStreamText({ fullStreamParts: [] });

    await collectStreamEvents(streamChat(makeStreamChatParams()));

    expect(aiSdkMocks.wrapLanguageModel).toHaveBeenCalledOnce();
    expect(aiSdkMocks.isStepCount).toHaveBeenCalledWith(100);
    expect(aiSdkMocks.streamText).toHaveBeenCalledOnce();
    const call = aiSdkMocks.streamText.mock.calls[0][0] as {
      system: string;
      messages: unknown[];
      stopWhen: unknown;
      tools: unknown;
      maxRetries: number;
    };
    expect(call.system).toContain('You are a helpful assistant.');
    expect(call.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(call.stopWhen).toEqual({ type: 'step-count', count: 100 });
    expect(call.maxRetries).toBe(0);
    // no allowed tools → tools undefined
    expect(call.tools).toBeUndefined();
  });

  it('composes stopWhen with shouldStopEarly when a predicate is supplied', async () => {
    // The composed branch CALLS the step-limit condition, so mock isStepCount
    // to return a real function (the default-path test above uses a plain
    // object). mockImplementationOnce restores the default for later tests.
    const stepLimit = vi.fn(() => false);
    aiSdkMocks.isStepCount.mockImplementationOnce(() => stepLimit);
    setupStreamText({ fullStreamParts: [] });

    const shouldStopEarly = vi.fn(() => false);
    await collectStreamEvents(
      streamChat({ ...makeStreamChatParams(), shouldStopEarly }),
    );

    expect(aiSdkMocks.isStepCount).toHaveBeenCalledWith(100);
    const call = aiSdkMocks.streamText.mock.calls[0][0] as {
      stopWhen: (ctx: unknown) => boolean;
    };
    expect(typeof call.stopWhen).toBe('function');

    const ctx = { steps: [] };

    // Early stop requested → stops even though the step-count limit says no.
    shouldStopEarly.mockReturnValue(true);
    stepLimit.mockReturnValue(false);
    expect(call.stopWhen(ctx)).toBe(true);

    // No early stop → delegates to the step-count limit.
    shouldStopEarly.mockReturnValue(false);
    stepLimit.mockReturnValue(false);
    expect(call.stopWhen(ctx)).toBe(false);
    stepLimit.mockReturnValue(true);
    expect(call.stopWhen(ctx)).toBe(true);
  });

  it(
    'yields stream idle timeout when fullStream hangs with no content',
    async () => {
      aiSdkMocks.streamText.mockImplementation((params: {
        abortSignal?: AbortSignal;
      }) => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((_resolve, reject) => {
              const signal = params.abortSignal;
              if (!signal) return;
              if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            });
            yield { type: 'unreachable-after-abort' };
          },
        },
        textStream: createAsyncIterable<string>([]),
        finishReason: Promise.resolve('stop'),
      }));

      const cfg = {
        ...defaults(),
        llm_stream_idle_timeout: 0.05,
        llm_stream_retries: 0,
      };
      const events = await collectStreamEvents(
        streamChat(makeStreamChatParams({ config: cfg })),
      );
      expect(
        events.some((e) => e.type === 'error' && e.title === 'Stream idle timeout'),
      ).toBe(true);
    },
    10_000,
  );

  it(
    'does not idle-abort while a tool is in flight',
    async () => {
      aiSdkMocks.streamText.mockImplementation((params: {
        abortSignal?: AbortSignal;
      }) => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'tool-input-available',
              toolCallId: 'tc-1',
              toolName: 'wait_for_subagent',
              input: {},
            };
            // Hang longer than idle timeout during tool execution
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 120);
              const signal = params.abortSignal;
              if (signal?.aborted) {
                clearTimeout(t);
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(t);
                  reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            });
            yield {
              type: 'tool-output-available',
              toolCallId: 'tc-1',
              output: canonicalStreamOutput('done'),
            };
          },
        },
        textStream: createAsyncIterable<string>([]),
        finishReason: Promise.resolve('stop'),
      }));

      const cfg = {
        ...defaults(),
        llm_stream_idle_timeout: 0.05,
        llm_stream_retries: 0,
      };
      const events = await collectStreamEvents(
        streamChat(makeStreamChatParams({ config: cfg })),
      );
      expect(
        events.some((e) => e.type === 'error' && e.title === 'Stream idle timeout'),
      ).toBe(false);
      expect(events.some((e) => e.type === 'tool_call')).toBe(true);
      expect(events.some((e) => e.type === 'tool_result')).toBe(true);
      expect(events.some((e) => e.type === 'finish')).toBe(true);
    },
    10_000,
  );
});

describe('combineAbortSignals', () => {
  it('aborts when either signal aborts and dispose is safe', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal, dispose } = combineAbortSignals(a.signal, b.signal);
    expect(signal.aborted).toBe(false);
    b.abort();
    expect(signal.aborted).toBe(true);
    dispose();
  });
});

// P1-20: fullStream + onStepFinish must not double-yield tool events
// ---------------------------------------------------------------------------

describe('drainPendingToolEvents (P1-20 double-yield guard)', () => {
  it('skips pending tool calls/results already emitted from fullStream', () => {
    const pendingToolCalls = [
      { toolCallId: 'tc-1', toolName: 'read', args: '{"path":"a.ts"}' },
    ];
    const pendingToolResults = [
      { toolCallId: 'tc-1', content: 'file contents', execution: canonicalStreamOutput('file contents') },
    ];
    // Simulate fullStream already yielding tool_call + tool_result for tc-1
    const seenToolCallIds = new Set(['tc-1']);
    const seenToolResultIds = new Set(['tc-1']);

    const events = [...drainPendingToolEvents(
      pendingToolCalls,
      pendingToolResults,
      seenToolCallIds,
      seenToolResultIds,
    )];

    expect(events).toEqual([]);
    expect(pendingToolCalls).toHaveLength(0);
    expect(pendingToolResults).toHaveLength(0);
  });

  it('yields pending tools when fullStream did not emit them (textStream fallback)', () => {
    const pendingToolCalls = [
      { toolCallId: 'tc-1', toolName: 'read', args: '{"path":"a.ts"}' },
      { toolCallId: 'tc-2', toolName: 'grep', args: '{"pattern":"x"}' },
    ];
    const pendingToolResults = [
      { toolCallId: 'tc-1', content: 'ok', execution: canonicalStreamOutput('ok') },
      { toolCallId: 'tc-2', content: 'Error: boom', execution: canonicalStreamOutput('Error: boom', 'error') },
    ];
    const seenToolCallIds = new Set<string>();
    const seenToolResultIds = new Set<string>();

    const events = [...drainPendingToolEvents(
      pendingToolCalls,
      pendingToolResults,
      seenToolCallIds,
      seenToolResultIds,
    )];

    expect(events).toEqual([
      { type: 'tool_call', toolCallId: 'tc-1', toolName: 'read', args: '{"path":"a.ts"}' },
      { type: 'tool_call', toolCallId: 'tc-2', toolName: 'grep', args: '{"pattern":"x"}' },
      { type: 'tool_result', toolCallId: 'tc-1', content: 'ok', execution: canonicalStreamOutput('ok') },
      { type: 'tool_result', toolCallId: 'tc-2', content: 'Error: boom', execution: canonicalStreamOutput('Error: boom', 'error') },
    ]);
    expect(seenToolCallIds.has('tc-1')).toBe(true);
    expect(seenToolCallIds.has('tc-2')).toBe(true);
    expect(seenToolResultIds.has('tc-1')).toBe(true);
    expect(seenToolResultIds.has('tc-2')).toBe(true);
  });

  it('yields only tools not yet seen (partial overlap / safety net)', () => {
    const pendingToolCalls = [
      { toolCallId: 'tc-stream', toolName: 'read', args: '{}' },
      { toolCallId: 'tc-pending-only', toolName: 'write', args: '{}' },
    ];
    const pendingToolResults = [
      { toolCallId: 'tc-stream', content: 'from-stream-dup', execution: canonicalStreamOutput('from-stream-dup') },
      { toolCallId: 'tc-pending-only', content: 'from-pending', execution: canonicalStreamOutput('from-pending') },
    ];
    // fullStream already emitted tc-stream call+result
    const seenToolCallIds = new Set(['tc-stream']);
    const seenToolResultIds = new Set(['tc-stream']);

    const events = [...drainPendingToolEvents(
      pendingToolCalls,
      pendingToolResults,
      seenToolCallIds,
      seenToolResultIds,
    )];

    expect(events).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'tc-pending-only',
        toolName: 'write',
        args: '{}',
      },
      {
        type: 'tool_result',
        toolCallId: 'tc-pending-only',
        content: 'from-pending',
        execution: canonicalStreamOutput('from-pending'),
      },
    ]);
    // Duplicate drain must be a no-op
    const again = [...drainPendingToolEvents(
      pendingToolCalls,
      pendingToolResults,
      seenToolCallIds,
      seenToolResultIds,
    )];
    expect(again).toEqual([]);
  });

  it('does not double-yield if the same pending id is drained twice via re-push', () => {
    const pendingToolCalls = [
      { toolCallId: 'tc-1', toolName: 'read', args: '{}' },
    ];
    const pendingToolResults: Array<{ toolCallId: string; content: string; execution: ToolExecutionResult }> = [];
    const seenToolCallIds = new Set<string>();
    const seenToolResultIds = new Set<string>();

    const first = [...drainPendingToolEvents(
      pendingToolCalls,
      pendingToolResults,
      seenToolCallIds,
      seenToolResultIds,
    )];
    expect(first).toHaveLength(1);

    // Simulate a buggy second onStepFinish push of the same id
    pendingToolCalls.push({ toolCallId: 'tc-1', toolName: 'read', args: '{}' });
    const second = [...drainPendingToolEvents(
      pendingToolCalls,
      pendingToolResults,
      seenToolCallIds,
      seenToolResultIds,
    )];
    expect(second).toEqual([]);
  });
});
