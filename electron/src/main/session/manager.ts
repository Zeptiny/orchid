/**
 * SessionManager — high-level session lifecycle management.
 *
 * Ported from src/orchid/domain/session.py (SessionManager).
 *
 * Key behaviors (matching Python):
 * - create(): New session with UUID, auto-saved to disk
 * - switchTo(id): Load and set as active (running subagents NOT cancelled)
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
 * Session switching does NOT cancel running subagents (matching Python).
 * Background commands continue running.
 */
import { randomUUID } from 'node:crypto';
import type { Session } from '../../shared/types/session';
import {
  saveSession as storageSaveSession,
  loadSession as storageLoadSession,
  deleteSession as storageDeleteSession,
  listSavedSessions as storageListSavedSessions,
  type StorageOptions,
  type SessionSummary,
} from './storage';

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
   * Create a new session with a UUID and default name.
   *
   * The session is immediately saved to disk and set as active.
   * Matches Python SessionManager.create().
   */
  create(model: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      name: `Session ${now.replace('T', ' ').replace(/\.\d+Z$/, '')}`,
      model,
      chains: [],
      activeChainId: null,
      createdAt: now,
      updatedAt: now,
      subagentChains: [],
      todoStore: { tasks: [] },
    };
    this._active = session;
    storageSaveSession(session, this._storageOpts);
    return session;
  }

  /**
   * Load a session from disk and set it as active.
   *
   * Running subagents are NOT cancelled (matching Python).
   * Returns null if the session file doesn't exist or fails to parse.
   */
  switchTo(id: string): Session | null {
    const session = storageLoadSession(id, this._storageOpts);
    if (!session) {
      return null;
    }
    this._active = session;
    return session;
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
    this._active = { ...this._active, model, updatedAt: new Date().toISOString() };
    storageSaveSession(this._active, this._storageOpts);
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
