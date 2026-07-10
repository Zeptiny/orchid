/**
 * SessionManager — high-level session lifecycle management.
 *
 * Ported from src/orchid/domain/session.py (SessionManager).
 *
 * Key behaviors (matching Python):
 * - create(): New session with UUID, auto-saved to disk
 * - switchTo(id): Load and set as active
 * - delete(id): Delete session file and caches
 * - rename(id, name): Update name, save
 * - changeModel(id, model): Update model, save
 * - saveActive(): Persist active session to disk
 * - load(id): Load session from disk
 * - listSaved(): List all saved sessions (mtime order, newest first)
 * - getActive(): Get current active session
 * - Auto-naming: After first exchange, if name starts with "Session ",
 *   call the generateTitle callback for a 3-6 word title
 *
 * SessionManager itself does not cancel subagents on switch. IPC layer
 * (session:load / forceAbortChat) cancels running subagents for multi-cwd
 * safety so a global SubagentManager cannot keep writing chains into the
 * newly active session. Background commands continue running.
 */
import { randomUUID } from 'node:crypto';
import type { Session } from '../../shared/types/session';
import type { Message } from '../../shared/types/message';
import { ChainStatus, type Chain } from '../../shared/types/chain';
import {
  canonicalizeProjectDirectory,
  inspectProjectDirectory,
} from '../project/path';
import { TodoStore } from '../tools/todo/store';
import {
  saveSession as storageSaveSession,
  loadSession as storageLoadSession,
  deleteSession as storageDeleteSession,
  listSavedSessions as storageListSavedSessions,
  type StorageOptions,
  type SessionSummary,
} from './storage';

// ---------------------------------------------------------------------------
// Create options
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  /**
   * Absolute working directory for the new session.
   * Caller-supplied only — never silently defaults to process.cwd().
   * `null` / omitted → unbound session.
   */
  cwd?: string | null;
}

// ---------------------------------------------------------------------------
// Auto-naming callback type
// ---------------------------------------------------------------------------

/**
 * Callback for generating session titles after the first exchange.
 *
 * The real implementation calls the seed-tier LLM with the first
 * user/assistant messages. Tests can provide a mock.
 *
 * Returns the generated title, or null if generation failed.
 */
export type GenerateTitleCallback = (session: Session) => Promise<string | null>;

// ---------------------------------------------------------------------------
// SessionManager options
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  /** Optional callback for auto-naming sessions after first exchange. */
  generateTitle?: GenerateTitleCallback;
  /** Optional storage path overrides (for testing). */
  storage?: StorageOptions;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private _active: Session | null = null;
  /** Live todo store for the active session (source of truth between saves). */
  private _activeTodoStore: TodoStore = new TodoStore();
  private _generateTitle: GenerateTitleCallback | null = null;
  private _storageOpts: StorageOptions | undefined;

  /**
   * Create a new SessionManager.
   *
   * @param options - Configuration options including auto-naming callback
   *   and storage path overrides for testing.
   */
  constructor(options?: SessionManagerOptions) {
    this._generateTitle = options?.generateTitle ?? null;
    this._storageOpts = options?.storage;
  }

  /** Get the currently active session, or null if none. */
  getActive(): Session | null {
    return this._active;
  }

  /**
   * Live TodoStore for the active session.
   *
   * Always returns a store (empty when no session is active) so tool handlers
   * can resolve without null checks. Mutations must call persistActiveTodos()
   * (or saveActive()) so the snapshot lands on the session file.
   */
  getActiveTodoStore(): TodoStore {
    return this._activeTodoStore;
  }

  /**
   * Snapshot the live todo store into the active session and save to disk.
   * No-op when there is no active session.
   */
  persistActiveTodos(): void {
    if (!this._active) {
      return;
    }
    this._active = {
      ...this._active,
      todoStore: this._activeTodoStore.toData(),
      updatedAt: new Date().toISOString(),
    };
    storageSaveSession(this._active, this._storageOpts);
  }

  /** Embed live todos into the active session object before any save. */
  private flushTodosIntoActive(): void {
    if (!this._active) {
      return;
    }
    this._active = {
      ...this._active,
      todoStore: this._activeTodoStore.toData(),
    };
  }

  /**
   * Clear the active session without deleting any files.
   *
   * Used for draft/new-chat mode: the UI has no active session until the
   * first message is sent (which calls create()).
   */
  clearActive(): void {
    this._active = null;
    this._activeTodoStore = new TodoStore();
  }

  /**
   * Create a new session with a UUID and default name.
   *
   * The session is immediately saved to disk and set as active.
   * Matches Python SessionManager.create().
   *
   * @param model - Model id for the session
   * @param options - Optional create options. `cwd` is caller-supplied only
   *   (absolute path or null); never silently defaults to process.cwd().
   */
  create(model: string, options?: CreateSessionOptions): Session {
    const now = new Date().toISOString();
    // Unbound by default; only set cwd when the caller explicitly provides one.
    // Valid absolute dirs are canonicalized; invalid non-null paths store as
    // null rather than inventing a fallback (caller should validate first).
    let cwd: string | null = null;
    if (options?.cwd != null && options.cwd !== '') {
      cwd = canonicalizeProjectDirectory(options.cwd);
    }
    const session: Session = {
      id: randomUUID(),
      name: `Session ${now.replace('T', ' ').replace(/\.\d+Z$/, '')}`,
      model,
      cwd,
      chains: [],
      activeChainId: null,
      createdAt: now,
      updatedAt: now,
      subagentChains: [],
      todoStore: { tasks: [] },
    };
    this._activeTodoStore = new TodoStore();
    this._active = session;
    storageSaveSession(session, this._storageOpts);
    return session;
  }

  /**
   * Load a session from disk and set it as active.
   *
   * Does not cancel subagents itself — callers (session:load IPC /
   * forceAbortChat) cancel running subagents before switching so the global
   * manager cannot attach prior-session chains to the new active session.
   * Returns null if the session file doesn't exist or fails to parse.
   *
   * Rebinds the live TodoStore from the session snapshot so tools and UI
   * share session-isolated state (Python ContextVar parity).
   */
  switchTo(id: string): Session | null {
    const session = storageLoadSession(id, this._storageOpts);
    if (!session) {
      return null;
    }
    this._activeTodoStore = TodoStore.fromData(session.todoStore ?? { tasks: [] });
    // Keep session.todoStore in sync with the hydrated live store.
    this._active = {
      ...session,
      todoStore: this._activeTodoStore.toData(),
    };
    return this._active;
  }

  /**
   * Delete a session from disk and clear active if it was active.
   *
   * Matches Python SessionManager.delete().
   */
  delete(id: string): boolean {
    const result = storageDeleteSession(id, this._storageOpts);
    if (this._active?.id === id) {
      this._active = null;
      this._activeTodoStore = new TodoStore();
    }
    return result;
  }

  /**
   * Rename a session. Updates in-memory and persists to disk.
   *
   * No-op if the session is not the active session.
   */
  rename(id: string, name: string): void {
    if (!this._active || this._active.id !== id) {
      return;
    }
    this.flushTodosIntoActive();
    this._active = { ...this._active, name, updatedAt: new Date().toISOString() };
    storageSaveSession(this._active, this._storageOpts);
  }

  /**
   * Change the model for a session. Updates in-memory and persists to disk.
   *
   * No-op if the session is not the active session.
   * Matches Python SessionManager.change_model().
   */
  changeModel(id: string, model: string): void {
    if (!this._active || this._active.id !== id) {
      return;
    }
    this.flushTodosIntoActive();
    this._active = { ...this._active, model, updatedAt: new Date().toISOString() };
    storageSaveSession(this._active, this._storageOpts);
  }

  /**
   * Change the working directory for the active session.
   *
   * Validates via project path helpers: path must be absolute, exist, be a
   * directory, and be readable/executable. Stores the canonical absolute path
   * (realpath when available). Rejects invalid paths without mutating prior cwd.
   *
   * @returns The updated session on success
   * @throws Error if the session is not active or the path is invalid
   */
  changeCwd(id: string, cwd: string): Session {
    if (!this._active || this._active.id !== id) {
      throw new Error(`Cannot change cwd: session ${id} is not active`);
    }
    const inspection = inspectProjectDirectory(cwd);
    if (inspection.status !== 'valid' || inspection.path == null) {
      const reason = inspection.reason ?? 'invalid project directory';
      throw new Error(`Cannot change cwd: ${reason}`);
    }
    this.flushTodosIntoActive();
    this._active = {
      ...this._active,
      cwd: inspection.path,
      updatedAt: new Date().toISOString(),
    };
    storageSaveSession(this._active, this._storageOpts);
    return this._active;
  }

  /**
   * Save the active session to disk.
   *
   * No-op if no active session.
   * Matches Python SessionManager.save_active().
   */
  saveActive(): void {
    if (!this._active) {
      return;
    }
    this.flushTodosIntoActive();
    storageSaveSession(this._active, this._storageOpts);
  }

  /**
   * Load a session from disk into memory (does NOT set as active).
   *
   * Use switchTo() to load and set as active.
   * Returns null if the session file doesn't exist or fails to parse.
   */
  load(id: string): Session | null {
    return storageLoadSession(id, this._storageOpts);
  }

  /**
   * List all saved sessions from disk, sorted by mtime (newest first).
   *
   * Matches Python SessionManager.list_saved().
   */
  listSaved(): SessionSummary[] {
    return storageListSavedSessions(this._storageOpts);
  }

  /**
   * Replace (or create) the active chain message list and persist.
   *
   * Used by chat IPC after each completed or interrupted turn so session
   * reload can replay user/assistant/tool messages.
   */
  syncActiveChain(params: {
    messages: readonly Message[];
    status?: ChainStatus;
    model?: string;
    agentName?: string;
    agentType?: string;
    agentTier?: string;
  }): Session | null {
    if (!this._active) {
      return null;
    }

    const now = new Date().toISOString();
    const status = params.status ?? ChainStatus.COMPLETED;
    const existing =
      this._active.chains.find((c) => c.id === this._active!.activeChainId) ??
      this._active.chains[this._active.chains.length - 1] ??
      null;

    const chain: Chain = existing
      ? {
          ...existing,
          messages: [...params.messages],
          status,
          model: params.model ?? existing.model ?? this._active.model,
          agentName: params.agentName ?? existing.agentName,
          agentType: params.agentType ?? existing.agentType,
          agentTier: params.agentTier ?? existing.agentTier,
        }
      : {
          id: randomUUID(),
          sessionId: this._active.id,
          messages: [...params.messages],
          status,
          model: params.model ?? this._active.model,
          agentName: params.agentName ?? 'general',
          agentType: params.agentType ?? 'subagent',
          agentTier: params.agentTier ?? 'bloom',
          subagentRecord: null,
        };

    const chains = existing
      ? this._active.chains.map((c) => (c.id === chain.id ? chain : c))
      : [...this._active.chains, chain];

    this._active = {
      ...this._active,
      chains,
      activeChainId: chain.id,
      todoStore: this._activeTodoStore.toData(),
      updatedAt: now,
    };
    storageSaveSession(this._active, this._storageOpts);
    return this._active;
  }

  /**
   * Replace subagent_chains on a session and persist.
   *
   * Used when subagents complete so chain-footer token usage and the
   * right-rail subagent list can reload real data from disk.
   *
   * @param subagentChains - Full replacement list for that session
   * @param sessionId - Owning session id. When omitted, uses the active
   *   session (legacy callers). When provided and not active, loads that
   *   session from disk, patches, and saves — so a debounced flush after a
   *   session switch still writes to the correct owner.
   */
  syncSubagentChains(
    subagentChains: Session['subagentChains'],
    sessionId?: string,
  ): Session | null {
    const targetId = sessionId ?? this._active?.id;
    if (!targetId) {
      return null;
    }

    const now = new Date().toISOString();
    const chains = [...subagentChains];

    if (this._active?.id === targetId) {
      this._active = {
        ...this._active,
        subagentChains: chains,
        todoStore: this._activeTodoStore.toData(),
        updatedAt: now,
      };
      storageSaveSession(this._active, this._storageOpts);
      return this._active;
    }

    // Non-active owner: patch on disk so a late flush cannot clobber the
    // newly active session with the previous session's subagent chains.
    const loaded = storageLoadSession(targetId, this._storageOpts);
    if (!loaded) {
      return null;
    }
    const updated: Session = {
      ...loaded,
      subagentChains: chains,
      updatedAt: now,
    };
    storageSaveSession(updated, this._storageOpts);
    return updated;
  }

  /**
   * Auto-name the active session after the first exchange.
   *
   * If the session name starts with "Session " (the default format),
   * calls the generateTitle callback to produce a descriptive 3-6 word
   * title. Saves the session if the name changes.
   *
   * This method is designed to be called after the first LLM exchange
   * completes. The actual LLM call is delegated to the callback.
   *
   * @param generateTitle - Optional callback override. If provided, takes
   *   precedence over the constructor-injected callback. Useful when the
   *   callback needs to capture per-invocation context (e.g. messages).
   * @returns The session (possibly with updated name), or null if no
   *   active session or naming not applicable.
   */
  async autoNameActive(generateTitle?: GenerateTitleCallback): Promise<Session | null> {
    const callback = generateTitle ?? this._generateTitle;
    if (!this._active) {
      return null;
    }
    if (!this._active.name.startsWith('Session ')) {
      return this._active;
    }
    if (!callback) {
      return this._active;
    }

    try {
      const title = await callback(this._active);
      if (title && title.length < 80) {
        this._active = { ...this._active, name: title, updatedAt: new Date().toISOString() };
        storageSaveSession(this._active, this._storageOpts);
      }
    } catch (err) {
      // Auto-naming failure is non-fatal (matching Python)
      console.debug('Auto-naming failed, keeping default name:', err);
    }

    return this._active;
  }
}
