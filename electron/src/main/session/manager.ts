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
 * - load(id): Load session from disk or return its live in-memory copy
 * - listSaved(): List all saved sessions (mtime order, newest first)
 * - getActive(): Get current active session
 * - Auto-naming: After first exchange, if name starts with "Session ",
 *   call the generateTitle callback for a 3-6 word title
 *
 * SessionManager itself does not cancel work on switch. Selecting a session
 * is view navigation only: chat actors, subagents, and background commands
 * stay addressed by their own session id. Callers that must stop work use
 * forceAbortSession / forceStopSession / chat:cancel explicitly.
 */
import { randomUUID } from 'node:crypto';
import type { Session } from '../../shared/types/session';
import type { ModelSelection } from '../../shared/types/provider';
import type { Message } from '../../shared/types/message';
import { ChainStatus, type Chain } from '../../shared/types/chain';
import type { PermissionMode } from '../../shared/types/permission';
import {
  canonicalizeProjectDirectory,
  inspectProjectDirectory,
} from '../project/path';
import { TodoStore } from '../tools/todo/store';
import {
  appendActiveChain as storageAppendActiveChain,
  finishChain as storageFinishChain,
  saveSession as storageSaveSession,
  loadSession as storageLoadSession,
  deleteSession as storageDeleteSession,
  listSavedSessions as storageListSavedSessions,
  updateChain as storageUpdateChain,
  updateSessionFields as storageUpdateSessionFields,
  type SessionFieldsUpdate,
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
  /** Legacy owner used by existing single-window callers and parity tests. */
  private static readonly DEFAULT_OWNER = '__default__';
  /** One authoritative in-memory runtime per loaded session. */
  private _sessions = new Map<string, Session>();
  /** Mutable todo stores are owned by session id, never by the selected window. */
  private _todoStores = new Map<string, TodoStore>();
  /** Selection is view state: each window/owner may point at a different session. */
  private _selectedByOwner = new Map<string, string>();
  /** Empty compatibility store returned when the default owner has no selection. */
  private _emptyTodoStore: TodoStore = new TodoStore();
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

  private ownerKey(ownerId?: string): string {
    return ownerId ?? SessionManager.DEFAULT_OWNER;
  }

  /** Load a session into the shared runtime cache without selecting it. */
  private ensureSession(id: string): Session | null {
    const cached = this._sessions.get(id);
    if (cached) return cached;

    const loaded = storageLoadSession(id, this._storageOpts);
    if (!loaded) return null;
    const todos = TodoStore.fromData(loaded.todoStore ?? { tasks: [] });
    const session = { ...loaded, todoStore: todos.toData() };
    this._sessions.set(id, session);
    this._todoStores.set(id, todos);
    return session;
  }

  private replaceSession(session: Session): Session {
    this._sessions.set(session.id, session);
    return session;
  }

  private persistSessionFields(
    session: Session,
    update: Omit<SessionFieldsUpdate, 'updatedAt'>,
  ): Session {
    const persisted = storageUpdateSessionFields(
      session.id,
      { ...update, updatedAt: session.updatedAt },
      this._storageOpts,
    );
    if (!persisted) {
      storageSaveSession(session, this._storageOpts);
    }
    return this.replaceSession(session);
  }

  private selectedSessionId(ownerId?: string): string | null {
    return this._selectedByOwner.get(this.ownerKey(ownerId)) ?? null;
  }

  private isSelectedByAnyOwner(sessionId: string): boolean {
    for (const selectedId of this._selectedByOwner.values()) {
      if (selectedId === sessionId) return true;
    }
    return false;
  }

  /** Get the session selected by an owner/window, or null if none. */
  getActive(ownerId?: string): Session | null {
    const id = this.selectedSessionId(ownerId);
    return id ? this.ensureSession(id) : null;
  }

  /** Get an explicit session runtime without changing any window selection. */
  getSession(id: string): Session | null {
    return this.ensureSession(id);
  }

  /**
   * Live TodoStore for the active session.
   *
   * Always returns a store (empty when no session is active) so tool handlers
   * can resolve without null checks. Mutations must call persistActiveTodos()
   * so the snapshot lands on the session file.
   */
  getActiveTodoStore(ownerId?: string): TodoStore {
    const sessionId = this.selectedSessionId(ownerId);
    return sessionId ? this.getTodoStore(sessionId) : this._emptyTodoStore;
  }

  /** Resolve the mutable todo store owned by an explicit session. */
  getTodoStore(sessionId: string): TodoStore {
    this.ensureSession(sessionId);
    let store = this._todoStores.get(sessionId);
    if (!store) {
      store = new TodoStore();
      this._todoStores.set(sessionId, store);
    }
    return store;
  }

  /**
   * Snapshot the live todo store into the active session and save to disk.
   * No-op when there is no active session.
   */
  persistActiveTodos(ownerId?: string): void {
    const sessionId = this.selectedSessionId(ownerId);
    if (sessionId) this.persistTodos(sessionId);
  }

  /** Persist the todo store belonging to an explicit session. */
  persistTodos(sessionId: string): void {
    const session = this.ensureSession(sessionId);
    if (!session) return;
    const updated = {
      ...session,
      todoStore: this.getTodoStore(sessionId).toData(),
      updatedAt: new Date().toISOString(),
    };
    this.persistSessionFields(updated, { todoStore: updated.todoStore });
  }

  /** Embed a session's live todos into its in-memory snapshot before a save. */
  private flushTodos(sessionId: string): Session | null {
    const session = this.ensureSession(sessionId);
    if (!session) return null;
    return this.replaceSession({
      ...session,
      todoStore: this.getTodoStore(sessionId).toData(),
    });
  }

  /**
   * Clear the active session without deleting any files.
   *
   * Used for draft/new-chat mode: the UI has no active session until the
   * first message is sent (which calls create()).
   */
  clearActive(ownerId?: string): void {
    this._selectedByOwner.delete(this.ownerKey(ownerId));
    if (ownerId === undefined) this._emptyTodoStore = new TodoStore();
  }

  /**
   * Create a new session with a UUID and default name.
   *
   * The session is immediately saved to disk and set as active.
   * Matches Python SessionManager.create().
   *
   * @param selection - Connection-scoped model selection for the session
   * @param options - Optional create options. `cwd` is caller-supplied only
   *   (absolute path or null); never silently defaults to process.cwd().
   */
  create(
    selection: ModelSelection | null,
    options?: CreateSessionOptions,
    ownerId?: string,
    modelLabel: string | null = selection?.modelId ?? null,
  ): Session {
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
      selection,
      modelLabel,
      cwd,
      chains: [],
      activeChainId: null,
      createdAt: now,
      updatedAt: now,
      subagentChains: [],
      todoStore: { tasks: [] },
      reasoningEffortOverride: null,
      permissionMode: null,
    };
    this._sessions.set(session.id, session);
    this._todoStores.set(session.id, new TodoStore());
    this._selectedByOwner.set(this.ownerKey(ownerId), session.id);
    storageSaveSession(session, this._storageOpts);
    return session;
  }

  /**
   * Load a session from disk (or reuse the in-memory copy) and set it as the
   * selected session for the owner. Does not cancel concurrent work.
   *
   * When another owner already has this session selected, reuses the live
   * in-memory session and TodoStore so a mid-turn re-select does not wipe
   * live todos. Otherwise reloads from disk.
   * Returns null if the session file doesn't exist or fails to parse.
   */
  switchTo(id: string, ownerId?: string): Session | null {
    const owner = this.ownerKey(ownerId);
    let session: Session | null;
    if (this._sessions.has(id)) {
      session = this.ensureSession(id);
    } else {
      const loaded = storageLoadSession(id, this._storageOpts);
      if (!loaded) return null;
      const todos = TodoStore.fromData(loaded.todoStore ?? { tasks: [] });
      session = { ...loaded, todoStore: todos.toData() };
      this._sessions.set(id, session);
      this._todoStores.set(id, todos);
    }
    if (!session) return null;
    this._selectedByOwner.set(owner, id);
    return session;
  }

  /**
   * Delete a session from disk and clear active if it was active.
   *
   * Matches Python SessionManager.delete().
   */
  delete(id: string): boolean {
    const result = storageDeleteSession(id, this._storageOpts);
    this._sessions.delete(id);
    this._todoStores.delete(id);
    for (const [owner, selectedId] of this._selectedByOwner) {
      if (selectedId === id) this._selectedByOwner.delete(owner);
    }
    return result;
  }

  /**
   * Rename a session. Updates in-memory and persists to disk.
   *
   * No-op if the session is not the active session.
   */
  rename(id: string, name: string): void {
    if (!this.isSelectedByAnyOwner(id)) return;
    const session = this.flushTodos(id);
    if (!session) return;
    const updated = { ...session, name, updatedAt: new Date().toISOString() };
    this.persistSessionFields(updated, {
      name: updated.name,
      todoStore: updated.todoStore,
    });
  }

  /**
   * Change the connection-scoped selection for a session. Updates in-memory and persists to disk.
   *
   * No-op if the session is not the active session.
   * Matches Python SessionManager.change_model().
   */
  changeModel(
    id: string,
    selection: ModelSelection | null,
    modelLabel: string | null = selection?.modelId ?? null,
  ): void {
    if (!this.isSelectedByAnyOwner(id)) return;
    const session = this.flushTodos(id);
    if (!session) return;
    const updated = {
      ...session,
      selection,
      modelLabel,
      reasoningEffortOverride: null,
      updatedAt: new Date().toISOString(),
    };
    this.persistSessionFields(updated, {
      selection: updated.selection,
      modelLabel: updated.modelLabel,
      reasoningEffortOverride: updated.reasoningEffortOverride,
      todoStore: updated.todoStore,
    });
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
    if (!this.isSelectedByAnyOwner(id)) {
      throw new Error(`Cannot change cwd: session ${id} is not active`);
    }
    const session = this.ensureSession(id);
    if (!session) throw new Error(`Cannot change cwd: session ${id} was not found`);
    const inspection = inspectProjectDirectory(cwd);
    if (inspection.status !== 'valid' || inspection.path == null) {
      const reason = inspection.reason ?? 'invalid project directory';
      throw new Error(`Cannot change cwd: ${reason}`);
    }
    const withTodos = this.flushTodos(id) ?? session;
    const updated = {
      ...withTodos,
      cwd: inspection.path,
      updatedAt: new Date().toISOString(),
    };
    this.persistSessionFields(updated, {
      cwd: updated.cwd,
      todoStore: updated.todoStore,
    });
    return updated;
  }

  /**
   * Set or clear the reasoning effort override for a session.
   * Persists to disk immediately.
   */
  setReasoningEffortOverride(id: string, effort: string | number | null): void {
    if (!this.isSelectedByAnyOwner(id)) return;
    const session = this.flushTodos(id);
    if (!session) return;
    const updated = {
      ...session,
      reasoningEffortOverride: effort,
      updatedAt: new Date().toISOString(),
    };
    this.persistSessionFields(updated, {
      reasoningEffortOverride: updated.reasoningEffortOverride,
      todoStore: updated.todoStore,
    });
  }

  /**
   * Set or clear the per-session permission-mode override.
   * Persists to disk immediately so the choice survives restarts.
   */
  setPermissionMode(id: string, mode: PermissionMode | null): void {
    if (!this.isSelectedByAnyOwner(id)) return;
    const session = this.flushTodos(id);
    if (!session) return;
    const updated = {
      ...session,
      permissionMode: mode,
      updatedAt: new Date().toISOString(),
    };
    this.persistSessionFields(updated, {
      permissionMode: updated.permissionMode,
      todoStore: updated.todoStore,
    });
  }

  /**
   * Load a session without setting it as active.
   *
   * A session already loaded by this process is authoritative: returning its
   * in-memory copy preserves live chain and subagent states. Otherwise, read
   * from disk without caching or changing selection.
   * Returns null if the session file doesn't exist or fails to parse.
   */
  load(id: string): Session | null {
    return this._sessions.get(id) ?? storageLoadSession(id, this._storageOpts);
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
   * Resolve the chain currently open for writes.
   * Prefer activeChainId when it points at an ACTIVE chain; else first ACTIVE.
   */
  private findActiveChain(sessionId?: string): Chain | null {
    const targetId = sessionId ?? this.selectedSessionId();
    const session = targetId ? this.ensureSession(targetId) : null;
    if (!session) return null;
    const activeId = session.activeChainId;
    if (activeId) {
      const byId = session.chains.find(
        (c) => c.id === activeId && c.status === ChainStatus.ACTIVE,
      );
      if (byId) return byId;
    }
    return (
      session.chains.find((c) => c.status === ChainStatus.ACTIVE) ?? null
    );
  }

  /**
   * Start a new chain for the next user turn (Python `_start_chain`).
   *
   * Append-only: previous ACTIVE chain (if any) is frozen as INTERRUPTED so
   * multi-chain never rewrites older turns. Sets `activeChainId` to the new
   * chain so subagent spawn can attribute `parent_chain_index`.
   */
  startChain(params?: {
    selection?: ModelSelection | null;
    modelLabel?: string | null;
    agentName?: string;
    agentType?: string;
    agentTier?: string;
    messages?: readonly Message[];
  }, sessionId?: string): Chain | null {
    const targetId = sessionId ?? this.selectedSessionId();
    const session = targetId ? this.ensureSession(targetId) : null;
    if (!session) return null;

    const now = new Date().toISOString();
    // Freeze any leftover ACTIVE chain before opening a new one.
    const interruptedChainIds: string[] = [];
    let chains = session.chains.map((c) => {
      if (c.status !== ChainStatus.ACTIVE) return c;
      interruptedChainIds.push(c.id);
      return {
        ...c,
        status: ChainStatus.INTERRUPTED,
        endTime: c.endTime ?? now,
      };
    });

    const hasSelection = params != null && Object.hasOwn(params, 'selection');
    const hasModelLabel = params != null && Object.hasOwn(params, 'modelLabel');
    const selection = hasSelection ? params?.selection ?? null : session.selection;
    const modelLabel = hasModelLabel
      ? params?.modelLabel ?? null
      : session.modelLabel;
    const chain: Chain = {
      id: randomUUID(),
      sessionId: session.id,
      messages: params?.messages ? [...params.messages] : [],
      status: ChainStatus.ACTIVE,
      selection,
      modelLabel,
      agentName: params?.agentName ?? 'general',
      agentType: params?.agentType ?? 'subagent',
      agentTier: params?.agentTier ?? 'bloom',
      subagentRecord: null,
      startTime: now,
      endTime: null,
    };
    chains = [...chains, chain];

    const updated = {
      ...session,
      chains,
      activeChainId: chain.id,
      todoStore: this.getTodoStore(session.id).toData(),
      updatedAt: now,
    };
    const persisted = storageAppendActiveChain(
      chain,
      interruptedChainIds,
      now,
      updated.todoStore,
      this._storageOpts,
    );
    if (!persisted) {
      storageSaveSession(updated, this._storageOpts);
    }
    this.replaceSession(updated);
    return chain;
  }

  /**
   * Replace messages on the current ACTIVE chain only (turn-local write).
   * Does not create chains and does not finish the chain.
   */
  updateActiveChainMessages(
    messages: readonly Message[],
    sessionId?: string,
  ): Session | null {
    const targetId = sessionId ?? this.selectedSessionId();
    const session = targetId ? this.ensureSession(targetId) : null;
    if (!session) return null;

    const existing = this.findActiveChain(session.id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const chain: Chain = {
      ...existing,
      messages: [...messages],
    };
    const chains = session.chains.map((c) =>
      c.id === chain.id ? chain : c,
    );

    const updated = {
      ...session,
      chains,
      activeChainId: chain.id,
      todoStore: this.getTodoStore(session.id).toData(),
      updatedAt: now,
    };
    const persisted = storageUpdateChain(chain, now, this._storageOpts);
    if (!persisted) {
      storageSaveSession(updated, this._storageOpts);
    }
    this.replaceSession(updated);
    return updated;
  }

  /**
   * Freeze the active chain with a terminal status (Python `_freeze_chain`).
   * Clears `activeChainId` so the next turn must call `startChain`.
   */
  finishActiveChain(
    status: ChainStatus = ChainStatus.COMPLETED,
    sessionId?: string,
  ): Session | null {
    const targetId = sessionId ?? this.selectedSessionId();
    const session = targetId ? this.ensureSession(targetId) : null;
    if (!session) return null;

    const terminal =
      status === ChainStatus.ACTIVE ? ChainStatus.COMPLETED : status;
    const existing = this.findActiveChain(session.id);

    if (!existing) {
      return session;
    }

    const now = new Date().toISOString();
    const chain: Chain = {
      ...existing,
      status: terminal,
      endTime: now,
    };
    const chains = session.chains.map((c) =>
      c.id === chain.id ? chain : c,
    );

    const updated = {
      ...session,
      chains,
      activeChainId: null,
      todoStore: this.getTodoStore(session.id).toData(),
      updatedAt: now,
    };
    const persisted = storageFinishChain(
      chain,
      now,
      updated.todoStore,
      this._storageOpts,
    );
    if (!persisted) {
      storageSaveSession(updated, this._storageOpts);
    }
    this.replaceSession(updated);
    return updated;
  }

  /**
   * Persist a completed/interrupted turn onto the active multi-chain session.
   *
   * Prefer `startChain` at send-time + this at finalize. If no ACTIVE chain
   * exists (legacy / force-abort edge), creates and freezes one chain for the
   * turn messages only — never rewrites prior chains with full history.
   */
  persistTurn(params: {
    messages: readonly Message[];
    status?: ChainStatus;
    selection?: ModelSelection | null;
    modelLabel?: string | null;
    agentName?: string;
    agentType?: string;
    agentTier?: string;
  }, sessionId?: string): Session | null {
    const targetId = sessionId ?? this.selectedSessionId();
    let session = targetId ? this.ensureSession(targetId) : null;
    if (!session) return null;

    const status = params.status ?? ChainStatus.COMPLETED;
    const active = this.findActiveChain(session.id);

    if (!active) {
      this.startChain({
        ...(params.selection !== undefined ? { selection: params.selection } : {}),
        ...(params.modelLabel !== undefined ? { modelLabel: params.modelLabel } : {}),
        agentName: params.agentName,
        agentType: params.agentType,
        agentTier: params.agentTier,
        messages: params.messages,
      }, session.id);
      session = this.ensureSession(session.id);
    } else {
      if (
        params.selection !== undefined ||
        params.modelLabel !== undefined ||
        params.agentName ||
        params.agentType ||
        params.agentTier
      ) {
        const activeId = active.id;
        const now = new Date().toISOString();
        session = this.replaceSession({
          ...session,
          chains: session.chains.map((c) =>
            c.id === activeId
              ? {
                  ...c,
                  selection:
                    params.selection !== undefined
                      ? params.selection
                      : c.selection,
                  modelLabel:
                    params.modelLabel !== undefined
                      ? params.modelLabel
                      : c.modelLabel,
                  agentName: params.agentName ?? c.agentName,
                  agentType: params.agentType ?? c.agentType,
                  agentTier: params.agentTier ?? c.agentTier,
                }
              : c,
          ),
          updatedAt: now,
        });
      }
      this.updateActiveChainMessages(params.messages, session.id);
      session = this.ensureSession(session.id);
    }

    if (status === ChainStatus.ACTIVE) {
      return session;
    }
    return this.finishActiveChain(status, targetId ?? undefined);
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
    const targetId = sessionId ?? this.selectedSessionId();
    if (!targetId) {
      return null;
    }

    const now = new Date().toISOString();
    const chains = [...subagentChains];

    const cached = this._sessions.get(targetId);
    if (cached) {
      const updated = {
        ...cached,
        subagentChains: chains,
        todoStore: this.getTodoStore(targetId).toData(),
        updatedAt: now,
      };
      this.persistSessionFields(updated, {
        subagentChains: updated.subagentChains,
        todoStore: updated.todoStore,
      });
      return updated;
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
    const persisted = storageUpdateSessionFields(
      updated.id,
      { subagentChains: updated.subagentChains, updatedAt: updated.updatedAt },
      this._storageOpts,
    );
    if (!persisted) {
      storageSaveSession(updated, this._storageOpts);
    }
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
  async autoNameActive(
    generateTitle?: GenerateTitleCallback,
    ownerId?: string,
  ): Promise<Session | null> {
    const sessionId = this.selectedSessionId(ownerId);
    return sessionId ? this.autoName(sessionId, generateTitle) : null;
  }

  /** Auto-name an explicitly addressed session without consulting selection. */
  async autoName(
    sessionId: string,
    generateTitle?: GenerateTitleCallback,
  ): Promise<Session | null> {
    const callback = generateTitle ?? this._generateTitle;
    const session = this.ensureSession(sessionId);
    if (!session) return null;
    if (!session.name.startsWith('Session ')) return session;
    if (!callback) {
      return session;
    }

    try {
      const title = await callback(session);
      const current = this.ensureSession(sessionId);
      if (!current || current.name !== session.name) return current;
      if (title && title.length < 80) {
        const updated = {
          ...current,
          name: title,
          updatedAt: new Date().toISOString(),
        };
        this.persistSessionFields(updated, { name: updated.name });
        return updated;
      }
    } catch (err) {
      // Auto-naming failure is non-fatal (matching Python)
      console.warn('Auto-naming failed, keeping default name:', err);
    }

    return this.ensureSession(sessionId);
  }
}
