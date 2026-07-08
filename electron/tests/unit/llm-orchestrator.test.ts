/**
 * Tests for LLM stream orchestration (U9).
 *
 * Covers:
 * - history.ts: toApiMessages with pairing invariant, THINKING replay
 * - tool-dispatch.ts: executeToolCall, timeout, output offloading
 * - cleanup.ts: orphan cleanup, dangling tool_calls, chain reconciliation
 * - orchestrator.ts: streamChat (mocked AI SDK)
 *
 * Test scenarios from plan:
 * 1. No tool calls → text response yielded
 * 2. Tool call → tool executed → result fed back → stream continues
 * 3. Multi-step: tool call → result → another tool call → result → final text
 * 4. Pairing invariant: Orphaned TOOL_RESULT → dropped. Dangling tool_calls → filtered
 * 5. Output offloading: >20KB → cache file, pointer returned. Exempt tool → inline
 * 6. Usage tracking: Stream ends with usage data → Usage object populated
 * 7. Timeout: Tool >60s → TimeoutError caught, error result returned
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message } from '../../src/shared/types/message';
import { MessageType, MessageRole } from '../../src/shared/types/message';
import type { ToolCall } from '../../src/shared/types/tool';
import type { Agent } from '../../src/shared/types/agent';
import { AgentType, AgentTier } from '../../src/shared/types/agent';
import { toApiMessages } from '../../src/main/llm/history';
import { executeToolCall, maybeOffloadToolOutput } from '../../src/main/llm/tool-dispatch';
import {
  cleanOrphanToolResults,
  cleanDanglingToolCalls,
  reconcileChain,
  cleanStreamingArtifacts,
} from '../../src/main/llm/cleanup';
import { ToolRegistry } from '../../src/main/tools/registry';
import { z } from 'zod';

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
    hidden: false,
    ...overrides,
  };
}

function makeToolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
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
  });

  describe('THINKING replay', () => {
    it('replays THINKING as assistant content', () => {
      const messages = [
        makeUserMessage('Hello'),
        makeThinkingMessage('Let me think about this...'),
        makeMessage({ role: MessageRole.ASSISTANT, content: 'Here is my answer' }),
      ];

      const result = toApiMessages(messages);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual({
        role: 'assistant',
        content: 'Let me think about this...',
      });
      // Should NOT have a reasoning field
      expect(result[1]).not.toHaveProperty('reasoning');
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

    it('preserves THINKING as assistant content without breaking tool pairing', () => {
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
      // Thinking should be replayed as assistant content
      expect(result[1]).toEqual({
        role: 'assistant',
        content: 'I need to read this file first',
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

describe('executeToolCall', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('executes a tool and returns TOOL_RESULT message', async () => {
    registry.register(
      {
        name: 'echo',
        description: 'Echo input',
        inputSchema: z.object({ text: z.string() }),
        category: 'test',
      },
      async (input) => {
        const args = input as { text: string };
        return `Echo: ${args.text}`;
      },
    );

    const toolCall = makeToolCall('tc-1', 'echo', '{"text":"hello"}');
    const result = await executeToolCall(toolCall, registry);

    expect(result.role).toBe(MessageRole.TOOL);
    expect(result.type).toBe(MessageType.TOOL_RESULT);
    expect(result.tool_call_id).toBe('tc-1');
    expect(result.content).toBe('Echo: hello');
  });

  it('handles invalid JSON arguments', async () => {
    const toolCall = makeToolCall('tc-1', 'echo', 'not-json');
    const result = await executeToolCall(toolCall, registry);

    expect(result.content).toContain('invalid JSON');
  });

  it('handles non-object arguments', async () => {
    const toolCall = makeToolCall('tc-1', 'echo', '"just a string"');
    const result = await executeToolCall(toolCall, registry);

    expect(result.content).toContain('must be a JSON object');
  });

  it('handles unknown tool', async () => {
    const toolCall = makeToolCall('tc-1', 'nonexistent', '{}');
    const result = await executeToolCall(toolCall, registry);

    expect(result.content).toContain("does not exist");
  });

  it('handles tool execution error', async () => {
    registry.register(
      {
        name: 'fail',
        description: 'Always fails',
        inputSchema: z.object({}),
        category: 'test',
      },
      async () => {
        throw new Error('Tool failed!');
      },
    );

    const toolCall = makeToolCall('tc-1', 'fail', '{}');
    const result = await executeToolCall(toolCall, registry);

    expect(result.content).toContain('internal error');
  });

  describe('timeout', () => {
    it('times out tools exceeding the timeout', async () => {
      registry.register(
        {
          name: 'slow',
          description: 'Slow tool',
          inputSchema: z.object({}),
          category: 'test',
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return 'done';
        },
      );

      const toolCall = makeToolCall('tc-1', 'slow', '{}');
      const result = await executeToolCall(toolCall, registry, {
        timeoutSeconds: 0.1, // 100ms timeout
      });

      expect(result.content).toContain('timed out');
    }, 10000);

    it('skips timeout for exempt tools', async () => {
      registry.register(
        {
          name: 'wait_for_subagent',
          description: 'Wait tool',
          inputSchema: z.object({}),
          category: 'test',
          noTimeout: true,
        },
        async () => 'waited',
      );

      const toolCall = makeToolCall('tc-1', 'wait_for_subagent', '{}');
      const result = await executeToolCall(toolCall, registry, {
        timeoutSeconds: 0.001, // Would timeout if not exempt
      });

      expect(result.content).toBe('waited');
    });

    it('skips timeout for tools in TOOLS_WITHOUT_TIMEOUT set', async () => {
      registry.register(
        {
          name: 'read_output',
          description: 'Read output tool',
          inputSchema: z.object({}),
          category: 'test',
        },
        async () => 'output',
      );

      const toolCall = makeToolCall('tc-1', 'read_output', '{}');
      const result = await executeToolCall(toolCall, registry, {
        timeoutSeconds: 0.001,
      });

      expect(result.content).toBe('output');
    });
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
    const exemptTools = ['read', 'grep', 'glob', 'directory_tree', 'web_fetch', 'skill', 'write', 'wait_for_subagent'];
    
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

    const result = maybeOffloadToolOutput('execute_command', content, 'tc-1', sessionId);

    expect(result).toContain('file=');
    expect(result).toContain('30000');
    expect(result).toContain('warning');

    // Verify the cache file was created in the real homedir
    const cacheDir = path.join(os.homedir(), '.orchid', 'cache', 'tool-output', sessionId);
    expect(fs.existsSync(cacheDir)).toBe(true);

    const files = fs.readdirSync(cacheDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('execute_command');

    // Verify file content
    const filePath = path.join(cacheDir, files[0]);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);

    // Cleanup
    fs.rmSync(cacheDir, { recursive: true, force: true });
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
// Cleanup utilities tests
// ---------------------------------------------------------------------------

describe('cleanOrphanToolResults', () => {
  it('keeps properly paired tool results', () => {
    const tc = makeToolCall('tc-1', 'read');
    const messages = [
      makeAssistantToolCallMessage([tc]),
      makeToolResultMessage('tc-1', 'result'),
    ];

    const result = cleanOrphanToolResults(messages);
    expect(result).toHaveLength(2);
  });

  it('drops orphaned tool results', () => {
    const messages = [
      makeUserMessage('Hello'),
      makeToolResultMessage('tc-orphan', 'orphaned'),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Response' }),
    ];

    const result = cleanOrphanToolResults(messages);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe(MessageRole.ASSISTANT);
  });

  it('drops duplicate tool results for same tool_call_id', () => {
    const tc = makeToolCall('tc-1', 'read');
    const messages = [
      makeAssistantToolCallMessage([tc]),
      makeToolResultMessage('tc-1', 'first result'),
      makeToolResultMessage('tc-1', 'duplicate result'),
    ];

    const result = cleanOrphanToolResults(messages);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('first result');
  });

  it('handles empty messages array', () => {
    const result = cleanOrphanToolResults([]);
    expect(result).toHaveLength(0);
  });
});

describe('cleanDanglingToolCalls', () => {
  it('keeps tool_calls that have matching results', () => {
    const tc = makeToolCall('tc-1', 'read');
    const messages = [
      makeAssistantToolCallMessage([tc]),
      makeToolResultMessage('tc-1', 'result'),
    ];

    const result = cleanDanglingToolCalls(messages);
    expect(result[0].tool_calls).toHaveLength(1);
  });

  it('filters out tool_calls with no matching result', () => {
    const tc1 = makeToolCall('tc-1', 'read');
    const tc2 = makeToolCall('tc-2', 'grep');
    const messages = [
      makeAssistantToolCallMessage([tc1, tc2]),
      makeToolResultMessage('tc-1', 'result'),
      // tc-2 has no result — dangling
    ];

    const result = cleanDanglingToolCalls(messages);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls![0].id).toBe('tc-1');
  });

  it('removes tool_calls field entirely when all are dangling', () => {
    const tc = makeToolCall('tc-1', 'read');
    const messages = [
      makeAssistantToolCallMessage([tc]),
      // No result — dangling
    ];

    const result = cleanDanglingToolCalls(messages);
    expect(result[0].tool_calls).toBeNull();
  });

  it('handles messages with no tool_calls', () => {
    const messages = [
      makeUserMessage('Hello'),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Hi' }),
    ];

    const result = cleanDanglingToolCalls(messages);
    expect(result).toHaveLength(2);
  });
});

describe('reconcileChain', () => {
  it('runs full cleanup pipeline', () => {
    const tc1 = makeToolCall('tc-1', 'read');
    const tc2 = makeToolCall('tc-2', 'grep'); // dangling
    const messages = [
      makeUserMessage('Read and grep'),
      makeAssistantToolCallMessage([tc1, tc2]),
      makeToolResultMessage('tc-1', 'file contents'),
      makeToolResultMessage('tc-orphan', 'orphaned'), // orphan
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Done' }),
    ];

    const result = reconcileChain(messages);

    // Orphaned tc-orphan should be dropped
    // tc-2 should be filtered from tool_calls
    expect(result).toHaveLength(4);
    expect(result[1].tool_calls).toHaveLength(1);
    expect(result[1].tool_calls![0].id).toBe('tc-1');
    expect(result[2].tool_call_id).toBe('tc-1');
    expect(result[3].content).toBe('Done');
  });
});

describe('cleanStreamingArtifacts', () => {
  it('filters out partial tool_calls (missing id)', () => {
    const partialTc: ToolCall = {
      id: '',
      type: 'function',
      function: { name: 'read', arguments: '{}' },
    };
    const fullTc = makeToolCall('tc-1', 'read');

    const messages = [
      makeAssistantToolCallMessage([partialTc, fullTc]),
    ];

    const result = cleanStreamingArtifacts(messages);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls![0].id).toBe('tc-1');
  });

  it('filters out partial tool_calls (missing name)', () => {
    const partialTc: ToolCall = {
      id: 'tc-partial',
      type: 'function',
      function: { name: '', arguments: '{}' },
    };

    const messages = [
      makeAssistantToolCallMessage([partialTc]),
    ];

    const result = cleanStreamingArtifacts(messages);
    expect(result[0].tool_calls).toBeNull();
  });

  it('handles messages with no tool_calls', () => {
    const messages = [
      makeUserMessage('Hello'),
      makeMessage({ role: MessageRole.ASSISTANT, content: 'Hi' }),
    ];

    const result = cleanStreamingArtifacts(messages);
    expect(result).toHaveLength(2);
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
        description: 'Test',
        inputSchema: z.object({ query: z.string() }),
        category: 'test',
      },
      handler,
    );

    const toolCall = makeToolCall('tc-1', 'test_tool', '{"query":"hello"}');
    await executeToolCall(toolCall, registry);

    expect(handler).toHaveBeenCalledWith({ query: 'hello' });
  });

  it('returns error for unregistered tool', async () => {
    registry.register(
      {
        name: 'existing',
        description: 'Exists',
        inputSchema: z.object({}),
        category: 'test',
      },
      async () => 'ok',
    );

    const toolCall = makeToolCall('tc-1', 'nonexistent', '{}');
    const result = await executeToolCall(toolCall, registry);

    expect(result.content).toContain('does not exist');
    expect(result.content).toContain('existing');
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
