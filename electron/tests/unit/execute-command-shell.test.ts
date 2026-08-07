/**
 * Tests for execute_command with shell=false support.
 *
 * Covers: shell=false happy path, quoted args, shell=false + background rejection,
 * command not found error handling, live-mirror wiring invariants.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeCommand } from '../../src/main/tools/process/execute-command';
import {
  ForegroundLiveRegistry,
  setForegroundLiveRegistry,
} from '../../src/main/tools/process/foreground-live';

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
    const result = await executeCommand({
      command: 'echo hello',
      shell: false,
    });

    expect(resultStatus(result)).toBe('complete');
    expect(resultText(result)).toContain('hello');
  });

  it('should preserve quoted arguments', async () => {
    const result = await executeCommand({
      command: 'echo "hello world"',
      shell: false,
    });

    expect(resultStatus(result)).toBe('complete');
    expect(resultText(result)).toContain('hello world');
  });

  it('should return error when shell=false with background=true', async () => {
    const result = await executeCommand({
      command: 'echo hello',
      shell: false,
      background: true,
    });

    expect(resultStatus(result)).toBe('error');
    expect(resultText(result)).toContain('not supported');
    expect(resultText(result)).toContain('shell=false');
    expect(resultText(result)).toContain('background=true');
  });

  it('should return error for command not found with shell=false', async () => {
    const result = await executeCommand({
      command: 'nonexistent_command_xyz',
      shell: false,
    });

    expect(resultStatus(result)).toBe('error');
    // spawn with shell=false will throw ENOENT or similar
    expect(resultText(result)).toContain('Error');
  });
});

describe('execute_command live mirror wiring', () => {
  let registry: ForegroundLiveRegistry;

  beforeEach(() => {
    registry = new ForegroundLiveRegistry({ graceMs: 500 });
    setForegroundLiveRegistry(registry);
  });

  afterEach(() => {
    registry.clear();
  });

  it('returns identical outcomes with and without mirroring', async () => {
    const mirrored = await executeCommand({
      command: 'echo same-out; echo same-err >&2',
      toolCallId: 'tc-shell-mirror',
    });
    const plain = await executeCommand({
      command: 'echo same-out; echo same-err >&2',
    });

    expect(resultStatus(mirrored)).toBe('complete');
    expect(mirrored).toEqual(plain);
  });

  it('registers nothing when toolCallId is absent', async () => {
    const result = await executeCommand({ command: 'echo untracked' });

    expect(resultStatus(result)).toBe('complete');
    expect(registry.size).toBe(0);
  });

  it('mirrors shell=false output without changing the outcome', async () => {
    const withMirror = await executeCommand({
      command: 'echo "shell false mirrored"',
      shell: false,
      toolCallId: 'tc-shell-false',
    });
    const withoutMirror = await executeCommand({
      command: 'echo "shell false mirrored"',
      shell: false,
    });

    expect(resultStatus(withMirror)).toBe('complete');
    expect(resultText(withMirror)).toContain('shell false mirrored');
    expect(withMirror).toEqual(withoutMirror);
    expect(registry.snapshot('tc-shell-false')?.tail).toContain('shell false mirrored');
    expect(registry.snapshot('tc-shell-false')?.exitCode).toBe(0);
  });

  it('finalizes the live entry for shell=false spawn failures', async () => {
    const result = await executeCommand({
      command: 'nonexistent_command_xyz',
      shell: false,
      toolCallId: 'tc-shell-false-error',
    });

    expect(resultStatus(result)).toBe('error');
    const exitCode = registry.snapshot('tc-shell-false-error')?.exitCode;
    expect(typeof exitCode === 'number' && exitCode < 0).toBe(true);
  });
});
