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
import { parse as shellParse } from 'shell-quote';
import { z } from 'zod';
import { getConfig } from '../../config/loader';
import type { Config } from '../../config/schema';
import { getBackgroundStore, ENV_SUPPRESSION } from './background-store';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import { getToolConfig, resolveToolPath } from '../types';

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
 * Optional abortSignal rejects with Error('aborted') after the caller kills the process.
 */
async function readBounded(
  proc: ChildProcess,
  timeoutMs: number,
  maxBytes: number,
  abortSignal?: AbortSignal,
): Promise<{ stdout: Buffer; stderr: Buffer; truncated: boolean }> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('timeout')));
    }, timeoutMs);

    const onAbort = () => {
      finish(() => reject(new Error('aborted')));
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

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
      finish(() => {
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
    });

    proc.on('error', (err) => {
      finish(() => reject(err));
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
  options?: {
    sessionId?: string;
    agentScopeId?: string;
    config?: Pick<Config, 'command_timeout'>;
    abortSignal?: AbortSignal;
  },
): Promise<GenericBuiltInToolOutcome> {
  if (description === undefined) description = command;
  // Caller (handler) should pass an absolute cwd; '.' remains for direct unit tests.
  if (workingDirectory === undefined) workingDirectory = '.';
  if (shell === undefined) shell = true;
  if (background === undefined) background = false;
  if (interactive === undefined) interactive = false;

  // interactive requires background
  if (interactive && !background) {
    return genericBuiltInToolOutcome('execute_command', `Error: interactive=true is only supported with background=true`, 'error');
  }

  // shell=false is incompatible with background
  if (!shell && background) {
    return genericBuiltInToolOutcome('execute_command', `Error: shell=false is not supported with background=true`, 'error');
  }

  // -- background path -----------------------------------------------------
  if (background) {
    const store = getBackgroundStore();
    try {
      const procId = await store.spawn(command, {
        cwd: workingDirectory,
        interactive,
        description,
        sessionId: options?.sessionId ?? null,
        agentScopeId: options?.agentScopeId ?? 'main',
      });
      // Keep the command start facts structured so the renderer can present an
      // active background command without recovering metadata from a string.
      // The generic projector still emits a compact human-readable sentence
      // for the model; canonical/session persistence retains every field.
      return genericBuiltInToolOutcome(
        'execute_command',
        {
          commandId: procId,
          command,
          description,
          background: true,
          running: true,
        },
        'complete',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return genericBuiltInToolOutcome('execute_command', `Error: ${msg}`, 'error');
    }
  }

  // -- foreground path ------------------------------------------------------
  if (timeout === undefined) {
    timeout = options?.config?.command_timeout ?? getConfig().command_timeout;
  }
  const timeoutMs = timeout * 1000;

  const env = { ...process.env, ...ENV_SUPPRESSION };

  try {
    // When shell=false, parse command into args array to avoid shell interpretation
    let spawnCmd: string;
    let spawnArgs: string[];
    if (shell) {
      spawnCmd = '/bin/sh';
      spawnArgs = ['-c', command];
    } else {
      const parsed = shellParse(command);
      if (parsed.length === 0) {
        throw new Error('Empty command after parsing');
      }
      // shell-parse returns strings and possibly { op, ... } objects for globs
      spawnArgs = parsed.map((part) => {
        if (typeof part === 'string') return part;
        // For glob patterns, shell-quote returns objects — convert back to string
        if (typeof part === 'object' && part !== null && 'op' in part) {
          return String((part as { pattern?: string }).pattern ?? part);
        }
        return String(part);
      });
      spawnCmd = spawnArgs[0];
      spawnArgs = spawnArgs.slice(1);
    }

    const proc = spawn(spawnCmd, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.resolve(workingDirectory),
      detached: true,
      env,
    });

    // Outer tool-dispatch timeout aborts this signal — kill the live handle only
    // (never bare PID after delay; PID reuse risk).
    const abortSignal = options?.abortSignal;
    const onAbort = () => {
      if (proc.exitCode === null) {
        killProcessGroup(proc, 'SIGKILL');
      }
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      let bounded: { stdout: Buffer; stderr: Buffer; truncated: boolean };
      try {
        bounded = await readBounded(proc, timeoutMs, MAX_OUTPUT_BYTES, abortSignal);
      } catch (err) {
        // Inner command_timeout or outer abort — kill live handle if still running
        if (proc.exitCode === null) {
          killProcessGroup(proc, 'SIGKILL');
        }
        await waitForExit(proc);
        if (err instanceof Error && err.message === 'timeout') {
          return genericBuiltInToolOutcome('execute_command', `Error: ${description} timed out after ${timeout} seconds.`, 'error');
        }
        if (
          (err instanceof Error && err.message === 'aborted') ||
          abortSignal?.aborted
        ) {
          return genericBuiltInToolOutcome(
            'execute_command',
            `${description} was cancelled.`,
            'cancelled',
          );
        }
        throw err;
      }

      const { stdout, stderr, truncated } = bounded;

      // If truncated and still running, kill it
      if (truncated && proc.exitCode === null) {
        killProcessGroup(proc, 'SIGKILL');
        await waitForExit(proc);
      }

      await waitForExit(proc);

      const stdoutStr = stdout.length > 0 ? stdout.toString('utf-8').trim() : '';
      const stderrStr = stderr.length > 0 ? stderr.toString('utf-8').trim() : '';
      const exitCode = proc.exitCode ?? 0;
      return genericBuiltInToolOutcome(
        'execute_command',
        { stdout: stdoutStr, stderr: stderrStr, exitCode, truncated },
        exitCode !== 0 ? 'error' : 'complete',
        'tool_error',
        exitCode !== 0 ? `Command exited with code ${exitCode}` : undefined,
      );
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return genericBuiltInToolOutcome('execute_command', `Error: ${msg}`, 'error');
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
  ...genericToolResultMetadata,
  name: 'execute_command',
  description:
    'Execute a shell command and return its output. Use for running tests, git commands, ' +
    'build tools, linting, and other CLI operations. Prefer this over writing scripts — run commands directly.',
  inputSchema: executeCommandInputSchema,
  actionLabel: 'Running...',
  category: 'process',
};

export const executeCommandHandler: ToolHandler = async (input: unknown, ctx) => {
  const { command, description, working_directory, timeout, shell, background, interactive } =
    input as ExecuteCommandInput;
  // Default cwd is the frozen session workspace; explicit paths resolve relative to it.
  const resolvedCwd = working_directory
    ? resolveToolPath(ctx.cwd, working_directory)
    : ctx.cwd;
  return executeCommand(
    command,
    description,
    resolvedCwd,
    timeout,
    shell,
    background,
    interactive,
    {
      sessionId: ctx.sessionId,
      agentScopeId: ctx.agentScopeId ?? 'main',
      config: getToolConfig(ctx),
      abortSignal: ctx.abortSignal,
    },
  );
};
