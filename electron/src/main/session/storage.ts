/**
 * Session storage — low-level persistence for sessions.
 *
 * Ported from src/orchid/storage.py.
 *
 * Session directory: ~/.orchid/sessions/<uuid>.json
 * Cache directories: ~/.orchid/cache/tool-output/<session_id>/
 *                    ~/.orchid/cache/web-fetch/<session_id>/
 *
 * Atomic writes reuse atomicWriteJson from the config module
 * (temp + fsync + replace + chmod 600 + fsync parent dir).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session, SessionStorageDict } from '../../shared/types/session';
import { sessionToStorageDict, sessionFromStorageDict } from '../../shared/types/session';
import type { SessionSummary } from '../../shared/types/ipc-boundary';
import { atomicWriteJson } from '../config/loader';

export type { SessionSummary } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Paths — default (production) locations
// ---------------------------------------------------------------------------

export const SESSIONS_DIR = path.join(os.homedir(), '.orchid', 'sessions');
export const CACHE_DIR = path.join(os.homedir(), '.orchid', 'cache');
export const TOOL_OUTPUT_CACHE_DIR = path.join(CACHE_DIR, 'tool-output');
export const WEB_FETCH_CACHE_DIR = path.join(CACHE_DIR, 'web-fetch');

// ---------------------------------------------------------------------------
// Options for testable storage (overridable paths)
// ---------------------------------------------------------------------------

export interface StorageOptions {
  /** Override path to sessions directory. Defaults to `~/.orchid/sessions`. */
  sessionsDir?: string;
  /** Override path to tool-output cache directory. */
  toolOutputCacheDir?: string;
  /** Override path to web-fetch cache directory. */
  webFetchCacheDir?: string;
}

function resolveOptions(opts?: StorageOptions) {
  return {
    sessionsDir: opts?.sessionsDir ?? SESSIONS_DIR,
    toolOutputCacheDir: opts?.toolOutputCacheDir ?? TOOL_OUTPUT_CACHE_DIR,
    webFetchCacheDir: opts?.webFetchCacheDir ?? WEB_FETCH_CACHE_DIR,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** UUID v4 regex (case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a session ID is a safe UUID.
 *
 * Defense-in-depth: rejects path traversal characters (`..`, `/`, `\`)
 * even if the IPC layer already validates with `z.string().uuid()`.
 */
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure the sessions directory exists with mode 0o700. */
export function ensureSessionsDir(opts?: StorageOptions): string {
  const { sessionsDir } = resolveOptions(opts);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.chmodSync(sessionsDir, 0o700);
  return sessionsDir;
}

/**
 * Extract a simple string value for a JSON key from partial text.
 *
 * Works for flat top-level keys like "id", "name", "modelLabel" where the
 * value is a quoted string. Returns undefined if the key is not found
 * or value is null.
 *
 * Matches Python `storage.py:_extract_json_string`.
 */
function extractJsonString(text: string, key: string): string | undefined {
  const pattern = new RegExp(
    `${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
  );
  const match = pattern.exec(text);
  if (match?.[1] !== undefined) {
    try {
      // Use JSON.parse to properly handle escape sequences
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Extract a finite JSON number for a flat top-level key. */
function extractJsonNumber(text: string, key: string): number | undefined {
  const pattern = new RegExp(
    `${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\b`,
  );
  const match = pattern.exec(text);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Extract a nullable string field (e.g. "cwd") from partial JSON text.
 *
 * - quoted string → the decoded string
 * - explicit `null` → null
 * - key not found / unparseable → undefined (caller may full-parse)
 */
function extractJsonNullableString(text: string, key: string): string | null | undefined {
  const stringVal = extractJsonString(text, key);
  if (stringVal !== undefined) {
    return stringVal;
  }
  // Match `"key": null` (with optional whitespace)
  const nullPattern = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*null\\b`);
  if (nullPattern.test(text)) {
    return null;
  }
  return undefined;
}

/**
 * Parse cwd from a fully-parsed session storage object.
 * Missing / non-string → null (legacy / unbound).
 */
function cwdFromParsed(data: Record<string, unknown>): string | null {
  return typeof data.cwd === 'string' ? data.cwd : null;
}

/** True for version-1 (or predating versioned) session documents. */
function isLegacySessionVersion(version: unknown): boolean {
  return typeof version !== 'number' || version < 2;
}

/**
 * Return a display-only label without ever treating a string alias as a
 * connection-scoped executable selection. Version 1 `model` is historical
 * display data; version 2 reads only its explicit `modelLabel` field.
 */
function modelLabelFromParsed(data: Record<string, unknown>): string | null {
  if (isLegacySessionVersion(data.version)) {
    return typeof data.model === 'string' ? data.model : null;
  }
  return typeof data.modelLabel === 'string' ? data.modelLabel : null;
}

/**
 * Try to extract the length of the "chains" array from partial JSON text.
 * Returns the count if the complete array is found, undefined otherwise.
 */
function extractChainCount(text: string): number | undefined {
  // Find the "chains" key and capture everything until the closing ]
  const chainsPattern = /"chains"\s*:\s*([\s\S]*?\])/;
  const match = chainsPattern.exec(text);
  if (!match?.[1]) return undefined;
  const arrayContent = match[1]!;
  if (arrayContent.trim() === '[]') return 0;
  // Count top-level objects in the array by matching { ... } pairs.
  // Use a non-greedy match of balanced braces (works for flat objects).
  const objectPattern = /\{[^{}]*\}/g;
  const objects = arrayContent.match(objectPattern);
  return objects?.length;
}

// ---------------------------------------------------------------------------
// saveSession — atomic write
// ---------------------------------------------------------------------------

/**
 * Save a session to ~/.orchid/sessions/<uuid>.json atomically.
 *
 * Uses atomicWriteJson (temp + fsync + replace + chmod 600 + fsync parent dir).
 * Matches Python `storage.py:save_session`.
 */
export function saveSession(session: Session, opts?: StorageOptions): void {
  if (!isValidSessionId(session.id)) {
    throw new Error(`Refusing to save session with unsafe ID: ${session.id}`);
  }
  const { sessionsDir } = resolveOptions(opts);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.chmodSync(sessionsDir, 0o700);
  const filePath = path.join(sessionsDir, `${session.id}.json`);
  const dict = sessionToStorageDict(session);
  atomicWriteJson(filePath, dict);
}

// ---------------------------------------------------------------------------
// loadSession — read + parse + deserialize
// ---------------------------------------------------------------------------

/**
 * Load a session from disk by ID.
 *
 * Returns null if not found or if deserialization fails.
 * Matches Python `storage.py:load_session`.
 */
export function loadSession(sessionId: string, opts?: StorageOptions): Session | null {
  if (!isValidSessionId(sessionId)) {
    return null;
  }
  const { sessionsDir } = resolveOptions(opts);
  const filePath = path.join(sessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as SessionStorageDict;
    return sessionFromStorageDict(data);
  } catch (err) {
    // Log but don't throw — error isolation matching Python
    console.warn(`Failed to load session ${sessionId}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// listSavedSessions — partial read optimization
// ---------------------------------------------------------------------------

/**
 * Return metadata for all saved sessions sorted by most recent mtime.
 *
 * Uses a partial read strategy for top-level string metadata (first 2048
 * bytes, regex extract id/name/modelLabel/cwd). Falls back to full parse if the
 * partial read doesn't contain enough data.
 *
 * Matches Python `storage.py:list_saved_sessions`.
 */
export function listSavedSessions(opts?: StorageOptions): SessionSummary[] {
  const { sessionsDir } = resolveOptions(opts);

  // Ensure directory exists
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.chmodSync(sessionsDir, 0o700);

  const partialReadSize = 2048;

  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  // Sort by mtime descending
  const filesWithMtime = files
    .map((f) => {
      const filePath = path.join(sessionsDir, f);
      try {
        const stat = fs.statSync(filePath);
        return { file: f, mtime: stat.mtimeMs };
      } catch {
        return { file: f, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  const sessions: SessionSummary[] = [];

  for (const { file, mtime } of filesWithMtime) {
    const filePath = path.join(sessionsDir, file);
    try {
      // Try partial read first — metadata fields are at the top of the file
      const fd = fs.openSync(filePath, 'r');
      let head: string;
      try {
        const buf = Buffer.alloc(partialReadSize);
        const bytesRead = fs.readSync(fd, buf, 0, partialReadSize, 0);
        head = buf.toString('utf-8', 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }

      // Quick extraction via regex (avoids full JSON parse)
      const sessionId = extractJsonString(head, '"id"');
      const name = extractJsonString(head, '"name"');
      const version = extractJsonNumber(head, '"version"');
      const modelLabel = extractJsonNullableString(head, '"modelLabel"');
      const legacyModel = extractJsonString(head, '"model"');
      const cwdFromHead = extractJsonNullableString(head, '"cwd"');

      if (sessionId) {
        // Try to get chainCount from partial read first (avoids double-read)
        let chainCount = extractChainCount(head);
        let parsedName = name ?? 'Unnamed';
        let parsedModelLabel: string | null =
          modelLabel === undefined
            ? isLegacySessionVersion(version)
              ? (legacyModel ?? null)
              : null
            : modelLabel;
        // Missing cwd in head → treat as null for legacy; refine on full parse
        let parsedCwd: string | null = cwdFromHead === undefined ? null : cwdFromHead;

        if (chainCount === undefined) {
          // Chains array extends beyond partial read — full parse needed
          const raw = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(raw) as Record<string, unknown>;
          const chains = Array.isArray(data.chains) ? data.chains : [];
          chainCount = chains.length;
          // Also refine name/modelLabel/cwd from full parse if partial didn't get them
          if (!parsedName || parsedName === 'Unnamed') {
            parsedName = typeof data.name === 'string' ? data.name : 'Unnamed';
          }
          if (modelLabel === undefined && legacyModel === undefined) {
            parsedModelLabel = modelLabelFromParsed(data);
          }
          if (cwdFromHead === undefined) {
            parsedCwd = cwdFromParsed(data);
          }
        }

        sessions.push({
          id: sessionId,
          name: parsedName,
          modelLabel: parsedModelLabel,
          cwd: parsedCwd,
          chainCount,
          updatedAt: mtime,
        });
      } else {
        // Fallback: full parse
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const chains = Array.isArray(data.chains) ? data.chains : [];
        sessions.push({
          id: typeof data.id === 'string' ? data.id : '',
          name: typeof data.name === 'string' ? data.name : 'Unnamed',
          modelLabel: modelLabelFromParsed(data),
          cwd: cwdFromParsed(data),
          chainCount: chains.length,
          updatedAt: mtime,
        });
      }
    } catch (err) {
      // Skip corrupted session files (matching Python)
      console.warn(`Skipping corrupted session file ${file}:`, err);
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// deleteSession — remove file + caches
// ---------------------------------------------------------------------------

/**
 * Delete a session file and its associated caches from disk.
 *
 * Removes:
 * - ~/.orchid/sessions/<session_id>.json
 * - ~/.orchid/cache/tool-output/<session_id>/
 * - ~/.orchid/cache/web-fetch/<session_id>/
 *
 * Returns true if the session file was deleted.
 * Matches Python `storage.py:delete_session`.
 */
export function deleteSession(sessionId: string, opts?: StorageOptions): boolean {
  if (!isValidSessionId(sessionId)) {
    return false;
  }
  const { sessionsDir, toolOutputCacheDir, webFetchCacheDir } = resolveOptions(opts);
  const filePath = path.join(sessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  // Remove session file
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    console.warn(`Failed to delete session file ${sessionId}:`, err);
    return false;
  }

  // Clean up tool-output cache
  const toolOutputDir = path.join(toolOutputCacheDir, sessionId);
  try {
    if (fs.existsSync(toolOutputDir)) {
      fs.rmSync(toolOutputDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`Failed to clean tool-output cache for ${sessionId}:`, err);
  }

  // Clean up web-fetch cache
  const webFetchDir = path.join(webFetchCacheDir, sessionId);
  try {
    if (fs.existsSync(webFetchDir)) {
      fs.rmSync(webFetchDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`Failed to clean web-fetch cache for ${sessionId}:`, err);
  }

  return true;
}
