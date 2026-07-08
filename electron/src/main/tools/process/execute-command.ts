/**
 * execute_command tool — run a shell command and return output.
 *
 * Foreground: child process with NO_COLOR=1 TERM=dumb, stdout+stderr up to
 * 1 MiB cap, SIGTERM→SIGKILL on timeout.
 *
 * Background: delegates to BackgroundProcessStore.
 * interactive=true forces background with PTY.
 *
 * Ported from Python `src/orchid/tools/exec.py`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';
import { getConfig } from '../../config/loader';
import { getBackgroundStore, ENV_SUPPRESSION } from './background-store';
import type { ToolDefinition, ToolHandler } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1 MiB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read stdout + stderr from a child process with bounded size and timeout.
 * Returns [stdout_bytes, stderr_bytes, truncated].
 */
async function readBounded(
  proc: ChildProcess,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ stdout: Buffer; stderr: Buffer; truncated: boolean }> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeoutMs);

    const onData = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (totalBytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - totalBytes;
      const trimmed = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      if (stream === 'stdout') {
        stdoutChunks.push(trimmed);
      } else {
        stderrChunks.push(trimmed);
      }
      totalBytes += trimmed.length;
      if (totalBytes >= maxBytes) {
        truncated = true;
      }
    };

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => onData('stdout', chunk));
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => onData('stderr', chunk));
    }

    proc.on('close', () => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);

      // Ensure total doesn't exceed maxBytes (trim stderr first)
      const total = stdout.length + stderr.length;
      if (total > maxBytes) {
        const overflow = total - maxBytes;
        if (stderr.length >= overflow) {
          resolve({
            stdout,
            stderr: stderr.subarray(0, stderr.length - overflow),
            truncated: true,
          });
        } else {
          const rem = overflow - stderr.length;
          resolve({
            stdout: stdout.subarray(0, stdout.length - rem),
            stderr: Buffer.alloc(0),
            truncated: true,
          });
        }
      } else {
        resolve({ stdout, stderr, truncated });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const executeCommandInputSchema = z.object({
  command: z.string().describe('The command to execute (e.g., "ls -la", "python script.py", "git status")'),
  description: z.string().optional().describe('A brief description of what the command does (for display purposes)'),
  working_directory: z.string().optional().describe('The working directory to run the command in (default: current directory)'),
  timeout: z.number().int().positive().optional().describe('Timeout in seconds for the command execution (default: 30)'),
  shell: z.boolean().optional().describe('Whether to run the command through the shell (default: true)'),
  background: z.boolean().optional().describe('When true, run the command in the background and return immediately with a process id'),
  interactive: z.boolean().optional().describe('When true with background=true, allocate a PTY and enable writable stdin for interactive commands'),
});

export type ExecuteCommandInput = z.infer<typeof executeCommandInputSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeCommand(
  command: string,
  description?: string,
  workingDirectory?: string,
  timeout?: number,
  shell?: boolean,
  background?: boolean,
  interactive?: boolean,
): Promise<{ display: string; content: string }> {
  if (description === undefined) description = command;
  if (workingDirectory === undefined) workingDirectory = '.';
  if (shell === undefined) shell = true;
  if (background === undefined) background = false;
  if (interactive === undefined) interactive = false;

  // interactive requires background
  if (interactive && !background) {
    return {
      display: 'interactive=true requires background=true',
      content: `Error: interactive=true is only supported with background=true`,
    };
  }

  // -- background path -----------------------------------------------------
  if (background) {
    const store = getBackgroundStore();
    try {
      const procId = await store.spawn(command, {
        cwd: workingDirectory,
        interactive,
        description,
      });
      return {
        display: `$ ${command} (id: ${procId}, background)`,
        content: `Background command started with id ${procId}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        display: 'Failed to start background command',
        content: `Error: ${msg}`,
      };
    }
  }

  // -- foreground path ------------------------------------------------------
  if (timeout === undefined) {
    timeout = getConfig().command_timeout;
  }
  const timeoutMs = timeout * 1000;

  const env = { ...process.env, ...ENV_SUPPRESSION };

  try {
    const proc = spawn('/bin/sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.resolve(workingDirectory),
      detached: true,
      env,
    });

    try {
      const { stdout, stderr, truncated } = await readBounded(proc, timeoutMs, MAX_OUTPUT_BYTES);

      // If truncated and still running, kill it
      if (truncated && proc.exitCode === null) {
        killProcessGroup(proc, 'SIGKILL');
        await waitForExit(proc);
      }

      await waitForExit(proc);

      const stdoutStr = stdout.length > 0 ? stdout.toString('utf-8').trim() : '';
      const stderrStr = stderr.length > 0 ? stderr.toString('utf-8').trim() : '';

      const parts: string[] = [];
      if (stdoutStr) parts.push(`STDOUT:\n${stdoutStr}`);
      if (stderrStr) parts.push(`STDERR:\n${stderrStr}`);
      if (truncated) parts.push('(output truncated)');

      return {
        display: `$ ${description} (exit code: ${proc.exitCode})`,
        content: parts.join('\n\n') || '(no output)',
      };
    } catch (err) {
      // Timeout
      if (err instanceof Error && err.message === 'timeout') {
        killProcessGroup(proc, 'SIGKILL');
        await waitForExit(proc);
        return {
          display: `$ ${description} - Timed out after ${timeout} seconds`,
          content: `Error: ${description} timed out after ${timeout} seconds.`,
        };
      }
      throw err;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      display: `$ ${description} - Execution error`,
      content: `Error: ${msg}`,
    };
  }
}

function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const executeCommandToolDefinition: ToolDefinition = {
  name: 'execute_command',
  description:
    'Execute a shell command and return its output. Use for running tests, git commands, ' +
    'build tools, linting, and other CLI operations. Prefer this over writing scripts — run commands directly.',
  inputSchema: executeCommandInputSchema,
  actionLabel: 'Running...',
  category: 'process',
};

export const executeCommandHandler: ToolHandler = async (input: unknown) => {
  const { command, description, working_directory, timeout, shell, background, interactive } =
    input as ExecuteCommandInput;
  return executeCommand(
    command,
    description,
    working_directory,
    timeout,
    shell,
    background,
    interactive,
  );
};
