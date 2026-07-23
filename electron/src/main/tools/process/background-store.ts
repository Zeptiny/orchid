/**
 * BackgroundProcessStore — lifecycle, head-tail buffer, LRU cap, termination.
 *
 * Process-singleton store that holds all background commands, their buffers,
 * ownership state, and metadata. Reached via getBackgroundStore().
 *
 * Ported from Python `src/orchid/tools/background_store.py`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { sleep } from '../../utils/async';
import { HeadTailBuffer } from './head-tail-buffer';
import { getConfig } from '../../config/loader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTECT_COUNT = 8; // most-recent entries protected from LRU eviction

const ENV_SUPPRESSION: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
};

const PTY_ENV_SUPPRESSION: Record<string, string> = {
  NO_COLOR: '1',
  TERM: process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color',
  PAGER: 'cat',
};

// ---------------------------------------------------------------------------
// PTY support (required native module)
// ---------------------------------------------------------------------------

type IPty = {
  pid: number;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (e: { exitCode: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  kill: (signal?: string) => void;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ptyModule = require('node-pty') as { spawn: (file: string, args: string[], opts: Record<string, unknown>) => IPty };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessEntry {
  id: number;
  command: string;
  process: ChildProcess | IPty;
  buffer: HeadTailBuffer;
  owner: 'AGENT' | 'USER';
  lastOutputAt: number;
  lastUserInputAt: number;
  exitCode: number | null;
  createdAt: number;
  interactive: boolean;
  sessionId: string | null;
  agentScopeId: string;
  description: string;
}

// ---------------------------------------------------------------------------
// BackgroundProcessStore
// ---------------------------------------------------------------------------

export class BackgroundProcessStore {
  private _entries = new Map<number, ProcessEntry>();
  private _nextId = 1;

  // -- spawn ---------------------------------------------------------------

  async spawn(
    command: string,
    options: {
      cwd?: string;
      interactive?: boolean;
      sessionId?: string | null;
      agentScopeId?: string;
      description?: string;
    } = {},
  ): Promise<number> {
    const {
      cwd = '.',
      interactive = false,
      sessionId = null,
      agentScopeId = 'main',
      description = '',
    } = options;

    const procId = this._nextId++;
    const buf = new HeadTailBuffer();
    const now = Date.now();

    let proc: ChildProcess | IPty;

    if (interactive) {
      const env = { ...process.env, ...PTY_ENV_SUPPRESSION };
      const ptyProc = ptyModule.spawn(
        process.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh'),
        ['-c', command],
        {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: path.resolve(cwd),
          env,
        },
      );

      // Drain PTY output into buffer
      const dataDisposable = ptyProc.onData((data: string) => {
        buf.append(Buffer.from(data, 'utf-8'));
        entry.lastOutputAt = Date.now();
      });
      const exitDisposable = ptyProc.onExit((e: { exitCode: number }) => {
        entry.exitCode = e.exitCode;
        dataDisposable.dispose();
        exitDisposable.dispose();
      });

      proc = ptyProc;
    } else {
      const env = { ...process.env, ...ENV_SUPPRESSION };
      const childProc = spawn('/bin/sh', ['-c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.resolve(cwd),
        detached: true, // creates a new process group
        env,
      });

      // Drain stdout + stderr into buffer
      if (childProc.stdout) {
        childProc.stdout.on('data', (chunk: Buffer) => {
          buf.append(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          entry.lastOutputAt = Date.now();
        });
      }
      if (childProc.stderr) {
        childProc.stderr.on('data', (chunk: Buffer) => {
          buf.append(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          entry.lastOutputAt = Date.now();
        });
      }

      childProc.on('exit', (code) => {
        entry.exitCode = code ?? -1;
      });
      childProc.on('error', () => {
        if (entry.exitCode === null) entry.exitCode = -1;
      });

      proc = childProc;
    }

    const entry: ProcessEntry = {
      id: procId,
      command,
      process: proc,
      buffer: buf,
      owner: 'AGENT',
      lastOutputAt: now,
      lastUserInputAt: now,
      exitCode: null,
      createdAt: now,
      interactive,
      sessionId,
      agentScopeId,
      description,
    };
    this._entries.set(procId, entry);

    this.pruneIfNeeded();

    return procId;
  }

  // -- query ---------------------------------------------------------------

  get(procId: number): ProcessEntry | undefined {
    return this._entries.get(procId);
  }

  getVisible(procId: number, sessionId?: string | null, agentScopeId?: string): ProcessEntry | undefined {
    const entry = this._entries.get(procId);
    if (!entry) return undefined;
    if (!this.isVisible(entry, sessionId, agentScopeId)) return undefined;
    return entry;
  }

  list(): ProcessEntry[] {
    return Array.from(this._entries.values());
  }

  isVisible(entry: ProcessEntry, sessionId?: string | null, agentScopeId?: string): boolean {
    return entry.sessionId === (sessionId ?? null) && entry.agentScopeId === (agentScopeId ?? 'main');
  }

  snapshot(procId: number, lastN?: number): { tail: string; exitCode: number | null } | undefined {
    const entry = this._entries.get(procId);
    if (!entry) return undefined;
    return { tail: entry.buffer.getTail(lastN), exitCode: entry.exitCode };
  }

  snapshotVisible(
    procId: number,
    lastN?: number,
    sessionId?: string | null,
    agentScopeId?: string,
  ): { tail: string; exitCode: number | null } | undefined {
    const entry = this.getVisible(procId, sessionId, agentScopeId);
    if (!entry) return undefined;
    return { tail: entry.buffer.getTail(lastN), exitCode: entry.exitCode };
  }

  /**
   * Session-owned snapshot for UI IPC: any agentScopeId within the session
   * (main or subagent). Does not require agentScopeId === 'main'.
   */
  snapshotForSession(
    procId: number,
    lastN: number | undefined,
    sessionId: string,
  ): { tail: string; exitCode: number | null } | undefined {
    const entry = this._entries.get(procId);
    if (!entry || entry.sessionId !== sessionId) return undefined;
    return { tail: entry.buffer.getTail(lastN), exitCode: entry.exitCode };
  }

  // -- input ---------------------------------------------------------------

  async send(procId: number, text: string): Promise<boolean> {
    const entry = this._entries.get(procId);
    if (!entry || !entry.interactive) return false;
    if (entry.exitCode !== null) return false;
    const proc = entry.process as IPty;
    try {
      proc.write(text);
      return true;
    } catch {
      return false;
    }
  }

  // -- ownership -----------------------------------------------------------

  takeOwnership(procId: number): boolean {
    const entry = this._entries.get(procId);
    if (!entry) return false;
    entry.owner = 'USER';
    entry.lastUserInputAt = Date.now();
    return true;
  }

  releaseOwnership(procId: number): boolean {
    const entry = this._entries.get(procId);
    if (!entry) return false;
    entry.owner = 'AGENT';
    return true;
  }

  checkIdleOwnership(idleTimeoutMs: number): void {
    const now = Date.now();
    for (const entry of this._entries.values()) {
      if (entry.owner === 'USER' && now - entry.lastUserInputAt > idleTimeoutMs) {
        entry.owner = 'AGENT';
      }
    }
  }

  // -- progress waiting ----------------------------------------------------

  async wait_for_progress(procId: number, waitMs: number): Promise<void> {
    const entry = this._entries.get(procId);
    if (!entry) return;

    const deadline = Date.now() + waitMs;
    const lastSeen = entry.lastOutputAt;
    const pollInterval = 50; // 50ms

    while (Date.now() < deadline) {
      // Entry evicted by LRU?
      if (!this._entries.has(procId)) return;
      // Process exited?
      if (entry.exitCode !== null) return;
      // New output arrived?
      if (entry.lastOutputAt > lastSeen) {
        // Give a moment for exit code to be set (output EOF → exit race)
        for (let i = 0; i < 6; i++) {
          // up to ~300ms
          if (entry.exitCode !== null) return;
          await sleep(50);
        }
        return;
      }
      await sleep(pollInterval);
    }
  }

  // -- termination ---------------------------------------------------------

  terminate(procId: number): void {
    const entry = this._entries.get(procId);
    if (!entry) return;
    if (entry.exitCode !== null) return;

    if (entry.interactive) {
      const pty = entry.process as IPty;
      try {
        pty.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          pty.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2000);
    } else {
      const proc = entry.process as ChildProcess;
      const pid = proc.pid;
      if (pid) {
        try {
          // Kill the entire process group (negative PID)
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            proc.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }, 2000);
      }
    }
  }

  terminateAll(): void {
    for (const procId of this._entries.keys()) {
      this.terminate(procId);
    }
  }

  terminateSession(sessionId: string): void {
    for (const [procId, entry] of this._entries) {
      if (entry.sessionId === sessionId) {
        this.terminate(procId);
      }
    }
  }

  // -- LRU eviction --------------------------------------------------------

  pruneIfNeeded(): void {
    const maxEntries = getConfig().max_background_processes;
    if (this._entries.size <= maxEntries) return;

    // Sort by createdAt (oldest first), protect the newest N
    const sortedIds = Array.from(this._entries.entries())
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .map(([id]) => id);

    const evictable = sortedIds.length > PROTECT_COUNT
      ? sortedIds.slice(0, -PROTECT_COUNT)
      : [];

    while (this._entries.size > maxEntries && evictable.length > 0) {
      const victimId = evictable.shift()!;
      this._terminateAndRemove(victimId);
    }
  }

  private _terminateAndRemove(procId: number): void {
    const entry = this._entries.get(procId);
    if (!entry) return;
    this._entries.delete(procId);

    // Force-kill the process if still running
    if (entry.exitCode === null) {
      if (entry.interactive) {
        const pty = entry.process as IPty;
        try {
          pty.kill('SIGKILL');
        } catch {
          // ignore
        }
      } else {
        const proc = entry.process as ChildProcess;
        if (proc.pid) {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }
      }
    }
  }

  // -- cleanup -------------------------------------------------------------

  clear(): void {
    this.terminateAll();
    this._entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _currentStore: BackgroundProcessStore | null = null;

export function getBackgroundStore(): BackgroundProcessStore {
  if (_currentStore === null) {
    _currentStore = new BackgroundProcessStore();
  }
  return _currentStore;
}

export function setBackgroundStore(store: BackgroundProcessStore): void {
  _currentStore = store;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { ENV_SUPPRESSION, PTY_ENV_SUPPRESSION };
