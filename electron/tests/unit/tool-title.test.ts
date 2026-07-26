import { describe, expect, it } from 'vitest';
import {
  buildToolTitle,
  toolTitleRunningText,
  toolTitleText,
  type SubagentTitleRecord,
} from '../../src/renderer/utils/tool-title';

function titleText(input: Parameters<typeof buildToolTitle>[0]): string {
  return toolTitleText(buildToolTitle(input));
}

describe('tool widget titles', () => {
  it('uses a description while preserving the full command in generating titles', () => {
    const title = buildToolTitle({
      toolName: 'execute_command',
      status: 'generating',
      args: '',
      partialArgs: '{"command":"npm test -- --run tests/integration/renderer-style-contract.test.ts",',
    });

    expect(toolTitleText(title)).toBe('Preparing to run $ npm test -- --run tests/integration/renderer-style-contract.test.ts');
  });

  it('shows the description and full command while execute_command is running', () => {
    const title = buildToolTitle({
      toolName: 'execute_command',
      status: 'running',
      args: JSON.stringify({
        command: 'npm test -- --run tests/integration/renderer-style-contract.test.ts',
        description: 'renderer tests',
      }),
      partialArgs: '',
    });

    expect(toolTitleText(title)).toBe(
      'Running renderer tests · $ npm test -- --run tests/integration/renderer-style-contract.test.ts',
    );
  });

  it('uses the assigned subagent names for wait_for_subagent', () => {
    const subagents: SubagentTitleRecord[] = [
      { id: 'subagent-1', agent_name: 'review auth flow', agent_type: 'reviewer' },
      { id: 'subagent-2', agent_name: 'run integration tests', agent_type: 'tester' },
    ];

    expect(
      titleText({
        toolName: 'wait_for_subagent',
        status: 'running',
        args: JSON.stringify({ subagent_ids: ['subagent-1', 'subagent-2'] }),
        partialArgs: '',
        subagents,
      }),
    ).toBe('Waiting for “review auth flow” and “run integration tests”');

    expect(
      titleText({
        toolName: 'wait_for_subagent',
        status: 'completed',
        args: JSON.stringify({ subagent_ids: ['subagent-1', 'subagent-2'] }),
        partialArgs: '',
        result: '<subagents><subagent name="review auth flow" /><subagent name="run integration tests" /></subagents>',
        subagents,
      }),
    ).toBe('Received results from “review auth flow” and “run integration tests”');
  });

  it('keeps every awaited subagent in the expanded running detail', () => {
    const subagents: SubagentTitleRecord[] = [
      { id: 'subagent-1', agent_name: 'review auth flow', agent_type: 'reviewer' },
      { id: 'subagent-2', agent_name: 'run integration tests', agent_type: 'tester' },
      { id: 'subagent-3', agent_name: 'check API contract', agent_type: 'reviewer' },
      { id: 'subagent-4', agent_name: 'inspect performance', agent_type: 'reviewer' },
    ];
    const title = buildToolTitle({
      toolName: 'wait_for_subagent',
      status: 'running',
      args: JSON.stringify({ subagent_ids: subagents.map((agent) => agent.id) }),
      partialArgs: '',
      subagents,
    });

    expect(toolTitleText(title)).toBe('Waiting for “review auth flow”, “run integration tests”, and 2 more');
    expect(toolTitleRunningText(title)).toBe(
      'Waiting for “review auth flow”, “run integration tests”, “check API contract”, and “inspect performance”',
    );
  });

  it('uses human-readable generating titles for delegation and file tools', () => {
    expect(
      titleText({
        toolName: 'delegate_to_subagent',
        status: 'generating',
        args: '',
        partialArgs: '{"name":"review auth flow",',
      }),
    ).toBe('Preparing to delegate “review auth flow”');

    expect(
      titleText({
        toolName: 'read',
        status: 'running',
        args: JSON.stringify({ file_path: 'src/renderer/Chat.tsx' }),
        partialArgs: '',
      }),
    ).toBe('Reading src/renderer/Chat.tsx');
  });

  it('keeps the action in terminal file and search titles', () => {
    expect(titleText({
      toolName: 'read',
      status: 'completed',
      args: JSON.stringify({ file_path: 'src/renderer/Chat.tsx' }),
      partialArgs: '',
      toolResult: {
        schemaVersion: 1,
        family: 'file-content',
        status: 'complete',
        completeness: 'complete',
        data: {
          path: 'src/renderer/Chat.tsx',
          lines: [{ number: 12, content: 'export function Chat() {' }],
          requestedRange: { start: 12, end: 24 },
          returnedRange: { start: 12, end: 24 },
          totalLineCount: 80,
        },
      },
    })).toBe('Read src/renderer/Chat.tsx lines 12-24');

    expect(titleText({
      toolName: 'read',
      status: 'completed',
      args: JSON.stringify({ file_path: 'src/renderer/Chat.tsx' }),
      partialArgs: '',
    })).toBe('Read src/renderer/Chat.tsx');

    expect(titleText({
      toolName: 'grep',
      status: 'completed',
      args: JSON.stringify({ pattern: 'ToolResultShell' }),
      partialArgs: '',
    })).toBe('Found matches for ToolResultShell');
  });

  it('falls back to a humanized tool name when no specific arguments are available', () => {
    expect(
      titleText({
        toolName: 'custom_tool_name',
        status: 'generating',
        args: '',
        partialArgs: '',
      }),
    ).toBe('Preparing custom tool name');
  });

  it('uses lifecycle titles for apply_patch', () => {
    expect(titleText({
      toolName: 'apply_patch',
      status: 'generating',
      args: '',
      partialArgs: '{"patch":"*** Begin Patch",',
    })).toBe('Preparing to apply patch');

    expect(titleText({
      toolName: 'apply_patch',
      status: 'running',
      args: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch' }),
      partialArgs: '',
    })).toBe('Applying patch');

    expect(titleText({
      toolName: 'apply_patch',
      status: 'completed',
      args: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch' }),
      partialArgs: '',
    })).toBe('Applied patch');

    expect(titleText({
      toolName: 'apply_patch',
      status: 'failed',
      args: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch' }),
      partialArgs: '',
    })).toBe('Couldn’t apply patch');
  });

  it('distinguishes rename previews from rename application', () => {
    expect(titleText({
      toolName: 'plan_symbol_rename',
      status: 'running',
      args: JSON.stringify({ old_name: 'before', new_name: 'after' }),
      partialArgs: '',
    })).toBe('Previewing rename before to after');
    expect(titleText({
      toolName: 'plan_symbol_rename',
      status: 'completed',
      args: JSON.stringify({ old_name: 'before', new_name: 'after' }),
      partialArgs: '',
    })).toBe('Previewed rename before to after');
  });
});
