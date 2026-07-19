/**
 * Tests for execute_command with shell=false support.
 *
 * Covers: shell=false happy path, quoted args, shell=false + background rejection,
 * command not found error handling.
 */
import { describe, it, expect } from 'vitest';
import { executeCommand } from '../../src/main/tools/process/execute-command';

function resultText(result: Awaited<ReturnType<typeof executeCommand>>): string {
  const candidate = result as unknown as { data?: { value?: unknown }; canonical?: { data?: { value?: unknown } }; content?: unknown };
  const value = candidate.data?.value ?? candidate.canonical?.data?.value ?? candidate.content;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function resultStatus(result: Awaited<ReturnType<typeof executeCommand>>): string {
  const candidate = result as unknown as { status?: string; canonical?: { status?: string }; isError?: boolean };
  return candidate.status ?? candidate.canonical?.status ?? (candidate.isError ? 'error' : 'complete');
}

describe('execute_command shell=false', () => {
  it('should run echo hello and return stdout with exit code 0', async () => {
    const result = await executeCommand(
      'echo hello',
      undefined,
      undefined,
      undefined,
      false, // shell=false
    );

    expect(resultStatus(result)).toBe('complete');
    expect(resultText(result)).toContain('hello');
  });

  it('should preserve quoted arguments', async () => {
    const result = await executeCommand(
      'echo "hello world"',
      undefined,
      undefined,
      undefined,
      false, // shell=false
    );

    expect(resultStatus(result)).toBe('complete');
    expect(resultText(result)).toContain('hello world');
  });

  it('should return error when shell=false with background=true', async () => {
    const result = await executeCommand(
      'echo hello',
      undefined,
      undefined,
      undefined,
      false, // shell=false
      true,  // background=true
    );

    expect(resultStatus(result)).toBe('error');
    expect(resultText(result)).toContain('not supported');
    expect(resultText(result)).toContain('shell=false');
    expect(resultText(result)).toContain('background=true');
  });

  it('should return error for command not found with shell=false', async () => {
    const result = await executeCommand(
      'nonexistent_command_xyz',
      undefined,
      undefined,
      undefined,
      false, // shell=false
    );

    expect(resultStatus(result)).toBe('error');
    // spawn with shell=false will throw ENOENT or similar
    expect(resultText(result)).toContain('Error');
  });
});
