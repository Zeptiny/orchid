// @vitest-environment jsdom
/**
 * SubagentTranscript sessionId wiring (F6): the live command widget rendered
 * from a subagent's persisted chain must poll with the owning session derived
 * from `record.chain.sessionId` — never the window's active session.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentTranscript } from '../../src/renderer/components/SubagentTranscript';
import { resetToolResultExpansionState } from '../../src/renderer/components/ToolResults/ToolResultShell';
import { MessageRole, MessageType, type Message } from '../../src/shared/types/message';
import type { Chain } from '../../src/shared/types/chain';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import type { BgCommandSnapshotFound } from '../../src/shared/types/ipc';

const message = (overrides: Partial<Message>): Message => ({
  id: 'message', role: MessageRole.ASSISTANT, content: 'text', type: MessageType.TEXT,
  tool_calls: null, tool_call_id: null, name: null, thinking: null,
  timestamp: '2026-08-04T00:00:00.000Z', usage: null, hidden: false,
  tool_result: null,
  ...overrides,
});

function backgroundCommandRecord(sessionId: string): SubagentRecord {
  const canonical = createCanonicalToolResult('generic', {
    status: 'complete',
    data: {
      value: {
        commandId: 42,
        command: 'npm run dev',
        description: 'dev server',
        background: true,
        running: true,
        createdAt: 1000,
      },
    },
  });
  const chain: Chain = {
    id: 'chain-1',
    sessionId,
    status: 'completed',
    messages: [
      message({
        id: 'call',
        type: MessageType.TOOL_CALL,
        content: '',
        tool_call_id: 'tool-bg-1',
        name: 'execute_command',
        tool_calls: [{
          id: 'tool-bg-1',
          type: 'function',
          function: {
            name: 'execute_command',
            arguments: JSON.stringify({ command: 'npm run dev', background: true }),
          },
        }],
      }),
      message({
        id: 'result',
        role: MessageRole.TOOL,
        type: MessageType.TOOL_RESULT,
        content: 'started',
        tool_call_id: 'tool-bg-1',
        name: 'execute_command',
        tool_result: canonical,
      }),
    ],
    selection: null,
    modelLabel: null,
    agentName: 'worker',
    agentType: 'worker',
    agentTier: 'bloom',
    startTime: null,
    endTime: null,
    subagentRecord: null,
  };
  return {
    id: 'sub-1',
    agent_name: 'worker',
    agent_type: 'worker',
    agent_tier: 'bloom',
    task: 'start the dev server',
    status: 'completed',
    chain_id: 'chain-1',
    start_time: '2026-08-04T00:00:00.000Z',
    end_time: '2026-08-04T00:00:05.000Z',
    result: null,
    error: null,
    parentChainIndex: null,
    closed: false,
    chain,
  };
}

describe('SubagentTranscript live-command session wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetToolResultExpansionState();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetToolResultExpansionState();
  });

  it('polls the background snapshot with the owning session from the persisted chain', async () => {
    const running: BgCommandSnapshotFound = {
      found: true,
      tail: 'ready\n',
      exitCode: null,
      running: true,
      interactive: false,
      owner: 'AGENT',
      command: 'npm run dev',
      description: 'dev server',
      agentScopeId: 'sub-1',
      createdAt: 1000,
    };
    const snapshot = vi.fn().mockResolvedValue(running);
    window.orchid = { bgCmd: { snapshot } } as never;

    const { container } = render(
      <SubagentTranscript record={backgroundCommandRecord('session-1')} />,
    );

    // Expand the tool shell so the live widget body mounts.
    fireEvent.click(container.querySelector('.orchid-tool-block-title') as HTMLElement);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('.orchid-live-command')).toBeTruthy();
    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: 42, sessionId: 'session-1' }),
    );
  });
});
