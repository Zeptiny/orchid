/**
 * Tests for execute_command with shell=false support.
 *
 * Covers: shell=false happy path, quoted args, shell=false + background rejection,
 * command not found error handling.
 */
import { describe, it, expect } from 'vitest';
import { executeCommand } from '../../src/main/tools/process/execute-command';

describe('execute_command shell=false', () => {
  it('should run echo hello and return stdout with exit code 0', async () => {
    const result = await executeCommand(
      'echo hello',
      undefined,
      undefined,
      undefined,
      false, // shell=false
    );

    expect(result.display).toContain('exit code: 0');
    expect(result.content).toContain('hello');
  });

  it('should preserve quoted arguments', async () => {
    const result = await executeCommand(
      'echo "hello world"',
      undefined,
      undefined,
      undefined,
      false, // shell=false
    );

    expect(result.display).toContain('exit code: 0');
    expect(result.content).toContain('hello world');
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

    expect(result.display).toContain('incompatible');
    expect(result.content).toContain('shell=false');
    expect(result.content).toContain('background=true');
  });

  it('should return error for command not found with shell=false', async () => {
    const result = await executeCommand(
      'nonexistent_command_xyz',
      undefined,
      undefined,
      undefined,
      false, // shell=false
    );

    expect(result.display).toContain('error');
    // spawn with shell=false will throw ENOENT or similar
    expect(result.content).toContain('Error');
  });
});
