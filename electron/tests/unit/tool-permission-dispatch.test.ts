import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { sessionPermissionOverrides } from '../../src/main/ipc/permission';
import * as toolDispatch from '../../src/main/llm/tool-dispatch';
import { approvalStore } from '../../src/main/permissions/approval-store';
import { ToolRegistry } from '../../src/main/tools/registry';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';

const executeToolCall = toolDispatch.executeToolCall;

function historyApi() {
  return toolDispatch as typeof toolDispatch & {
    clearToolCallHistoryForAgentScope: (sessionId: string, agentScopeId: string) => void;
    clearToolCallHistoryForSession: (sessionId: string) => void;
    getRecentToolCallHistory: (
      sessionId: string,
      agentScopeId: string | undefined,
      limit: number,
    ) => Array<{ name: string; argsSummary: string }>;
  };
}

describe('ask-when-flagged tool dispatch', () => {
  const sessionId = 'permission-dispatch-session';
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    sessionPermissionOverrides.set(sessionId, 'ask-when-flagged');
  });

  it('falls back to human approval when decide-for-me dependencies are unavailable', async () => {
    sessionPermissionOverrides.set(sessionId, 'decide-for-me');
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'fetched' },
    }));
    registry.register(
      {
        name: 'web_fetch',
        description: 'Fetch a URL',
        inputSchema: z.object({ url: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'network',
        riskClass: 'network',
      },
      handler,
    );
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'approved' });

    const result = await executeToolCall(
      { id: 'fallback-call', name: 'web_fetch', args: { url: 'https://example.test' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId },
    );

    expect(result.canonical.status).toBe('complete');
    expect(approval).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    sessionPermissionOverrides.delete(sessionId);
    sessionPermissionOverrides.delete(`${sessionId}-other`);
    const api = historyApi();
    if (typeof api.clearToolCallHistoryForSession === 'function') {
      api.clearToolCallHistoryForSession(sessionId);
      api.clearToolCallHistoryForSession(`${sessionId}-other`);
    }
    approvalStore.cleanupAll();
    vi.restoreAllMocks();
  });

  it('keeps bounded newest history isolated by session and agent scope', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'done' },
    }));
    registry.register(
      {
        name: 'web_fetch',
        description: 'Fetch a URL',
        inputSchema: z.object({ url: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'network',
        riskClass: 'network',
      },
      handler,
    );
    const otherSessionId = `${sessionId}-other`;
    sessionPermissionOverrides.set(sessionId, 'allow');
    sessionPermissionOverrides.set(otherSessionId, 'allow');

    await executeToolCall(
      { id: 'old', name: 'web_fetch', args: { url: 'https://old.example' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId, agentScopeId: 'main' },
    );
    await executeToolCall(
      { id: 'other', name: 'web_fetch', args: { url: 'https://other.example' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId: otherSessionId, agentScopeId: 'main' },
    );
    await executeToolCall(
      { id: 'subagent', name: 'web_fetch', args: { url: 'https://sub.example' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId, agentScopeId: 'subagent-1' },
    );
    await executeToolCall(
      { id: 'new', name: 'web_fetch', args: { url: 'https://new.example' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId, agentScopeId: 'main' },
    );

    expect(historyApi().getRecentToolCallHistory(sessionId, 'main', 1)).toEqual([
      { name: 'web_fetch', argsSummary: 'url=https://new.example' },
    ]);
    expect(historyApi().getRecentToolCallHistory(sessionId, 'main', 0)).toEqual([]);
    expect(historyApi().getRecentToolCallHistory(sessionId, 'main', 10)).toEqual([
      { name: 'web_fetch', argsSummary: 'url=https://old.example' },
      { name: 'web_fetch', argsSummary: 'url=https://new.example' },
    ]);
    historyApi().clearToolCallHistoryForSession(sessionId);
    expect(historyApi().getRecentToolCallHistory(sessionId, 'main', 10)).toEqual([]);
    expect(historyApi().getRecentToolCallHistory(sessionId, 'subagent-1', 10)).toEqual([]);
    expect(historyApi().getRecentToolCallHistory(otherSessionId, 'main', 10)).toEqual([
      { name: 'web_fetch', argsSummary: 'url=https://other.example' },
    ]);
  });

  it('clears only a terminal agent scope while preserving sibling and session histories', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'done' },
    }));
    registry.register(
      {
        name: 'web_fetch',
        description: 'Fetch a URL',
        inputSchema: z.object({ url: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'network',
        riskClass: 'network',
      },
      handler,
    );
    const otherSessionId = `${sessionId}-other`;
    sessionPermissionOverrides.set(sessionId, 'allow');
    sessionPermissionOverrides.set(otherSessionId, 'allow');

    for (const [id, ownerSessionId, agentScopeId] of [
      ['main', sessionId, 'main'],
      ['terminal', sessionId, 'subagent-terminal'],
      ['sibling', sessionId, 'subagent-sibling'],
      ['other-session', otherSessionId, 'subagent-terminal'],
    ] as const) {
      await executeToolCall(
        { id, name: 'web_fetch', args: { url: `https://${id}.example` } },
        registry,
        {
          cwd: '/tmp/orchid-permission-dispatch',
          sessionId: ownerSessionId,
          agentScopeId,
        },
      );
    }

    historyApi().clearToolCallHistoryForAgentScope(sessionId, 'subagent-terminal');

    expect(historyApi().getRecentToolCallHistory(sessionId, 'subagent-terminal', 10)).toEqual([]);
    expect(historyApi().getRecentToolCallHistory(sessionId, 'main', 10)).toHaveLength(1);
    expect(historyApi().getRecentToolCallHistory(sessionId, 'subagent-sibling', 10)).toHaveLength(1);
    expect(historyApi().getRecentToolCallHistory(
      otherSessionId,
      'subagent-terminal',
      10,
    )).toHaveLength(1);
  });

  it('does not expose the current pending call as prior evaluator history', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'done' },
    }));
    registry.register(
      {
        name: 'web_fetch',
        description: 'Fetch a URL',
        inputSchema: z.object({ url: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'network',
        riskClass: 'network',
      },
      handler,
    );
    sessionPermissionOverrides.set(sessionId, 'allow');
    await executeToolCall(
      { id: 'prior', name: 'web_fetch', args: { url: 'https://prior.example' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId, agentScopeId: 'main' },
    );

    sessionPermissionOverrides.set(sessionId, 'ask');
    let historyWhilePending: Array<{ name: string; argsSummary: string }> = [];
    vi.spyOn(approvalStore, 'create').mockImplementation(async () => {
      historyWhilePending = historyApi().getRecentToolCallHistory(sessionId, 'main', 10);
      return { decision: 'approved' };
    });
    await executeToolCall(
      { id: 'current', name: 'web_fetch', args: { url: 'https://current.example' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId, agentScopeId: 'main' },
    );

    expect(historyWhilePending).toEqual([
      { name: 'web_fetch', argsSummary: 'url=https://prior.example' },
    ]);
  });

  it('applies an ask session override to ask_question', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'answered' },
    }));
    registry.register(
      {
        name: 'ask_question',
        description: 'Ask the user a question',
        inputSchema: z.object({ questions: z.array(z.unknown()) }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'ask_question',
        riskClass: 'read-only',
      },
      handler,
    );
    sessionPermissionOverrides.set(sessionId, 'ask');
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'denied' });

    const result = await executeToolCall(
      {
        id: 'ask-question-call',
        name: 'ask_question',
        args: { questions: [] },
      },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId },
    );

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('Permission denied');
    expect(approval).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes a known non-file tool when no detector flags it', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'fetched' },
    }));
    registry.register(
      {
        name: 'web_fetch',
        description: 'Fetch a URL',
        inputSchema: z.object({ url: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'network',
        riskClass: 'network',
      },
      handler,
    );
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'denied' });

    const result = await executeToolCall(
      { id: 'web-call', name: 'web_fetch', args: { url: 'https://example.test' } },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId },
    );

    expect(result.canonical.status).toBe('complete');
    expect(handler).toHaveBeenCalledOnce();
    expect(approval).not.toHaveBeenCalled();
  });

  it('continues to require approval for MCP tools', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'remote result' },
    }));
    registry.register(
      {
        name: 'mcp::github::list_issues',
        description: 'List issues',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'mcp',
        riskClass: 'mcp',
      },
      handler,
    );
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'denied' });

    const result = await executeToolCall(
      { id: 'mcp-call', name: 'mcp::github::list_issues', args: {} },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId },
    );

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('Permission denied');
    expect(handler).not.toHaveBeenCalled();
    expect(approval).toHaveBeenCalledOnce();
  });

  it('executes an unflagged execute_command call', async () => {
    const name = 'execute_command';
    const args = { command: 'rm -rf /tmp/cache' };
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'safe command ran' },
    }));
    registry.register(
      {
        name,
        description: 'Execute safe input',
        inputSchema: z.object({ command: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'process',
        riskClass: 'execution',
      },
      handler,
    );
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'denied' });

    const result = await executeToolCall(
      { id: `${name}-safe`, name, args },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId },
    );

    expect(result.canonical.status).toBe('complete');
    expect(handler).toHaveBeenCalledOnce();
    expect(approval).not.toHaveBeenCalled();
  });

  it('requires approval for every send_input chunk even when benign chunks compose a destructive command', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'input sent' },
    }));
    registry.register(
      {
        name: 'send_input',
        description: 'Write stateful PTY input',
        inputSchema: z.object({ text: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'process',
        riskClass: 'execution',
      },
      handler,
    );
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'approved' });

    for (const [index, text] of ['rm -', 'rf /\n'].entries()) {
      const result = await executeToolCall(
        { id: `send-input-${index}`, name: 'send_input', args: { text } },
        registry,
        { cwd: '/tmp/orchid-permission-dispatch', sessionId },
      );
      expect(result.canonical.status).toBe('complete');
    }

    expect(approval).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('requires approval for a flagged compound command', async () => {
    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'command ran' },
    }));
    registry.register(
      {
        name: 'execute_command',
        description: 'Execute a command',
        inputSchema: z.object({ command: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'process',
        riskClass: 'execution',
      },
      handler,
    );
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'denied' });

    const result = await executeToolCall(
      {
        id: 'destructive-command',
        name: 'execute_command',
        args: { command: 'rm -rf /tmp/cache && rm -rf /' },
      },
      registry,
      { cwd: '/tmp/orchid-permission-dispatch', sessionId },
    );

    expect(result.canonical.status).toBe('error');
    expect(handler).not.toHaveBeenCalled();
    expect(approval).toHaveBeenCalledOnce();
  });

  it('executes an inside file target but prompts for a symlinked outside target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-permission-dispatch-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside.txt');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(workspace, 'outside-link'));

    const handler = vi.fn(async () => ({
      status: 'complete' as const,
      data: { value: 'read' },
    }));
    registry.register(
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: z.object({ file_path: z.string() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'filesystem',
        riskClass: 'read-only',
      },
      handler,
    );
    const approval = vi
      .spyOn(approvalStore, 'create')
      .mockResolvedValue({ decision: 'denied' });

    try {
      const insideResult = await executeToolCall(
        { id: 'inside-read', name: 'read', args: { file_path: 'inside.txt' } },
        registry,
        { cwd: workspace, sessionId },
      );
      const outsideResult = await executeToolCall(
        { id: 'outside-read', name: 'read', args: { file_path: 'outside-link' } },
        registry,
        { cwd: workspace, sessionId },
      );

      expect(insideResult.canonical.status).toBe('complete');
      expect(outsideResult.canonical.status).toBe('error');
      expect(handler).toHaveBeenCalledOnce();
      expect(approval).toHaveBeenCalledOnce();
      expect(approval).toHaveBeenCalledWith(
        'outside-read',
        sessionId,
        'read',
        'read-only',
        { file_path: 'outside-link' },
        workspace,
        'outside',
        undefined,
        undefined,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
