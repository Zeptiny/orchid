import { describe, expect, it } from 'vitest';
import {
  buildToolTitle,
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
        summary: 'Waited for 2 subagent(s)',
        subagents,
      }),
    ).toBe('Received results from “review auth flow” and “run integration tests”');
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
});
