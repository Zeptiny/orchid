/**
 * IPC payload Zod schemas — shared by main-process handlers and tests.
 *
 * Keep these pure (zod + shared types only) so boundary tests can import
 * production schemas without loading Electron IPC modules.
 */
import { z } from 'zod';
import { modelSelectionSchema } from '../../shared/types/provider';
import { configSchema } from '../config/schema';

// ── Chat ─────────────────────────────────────────────────────────────────────

export const chatSendSchema = z.object({
  message: z.string().min(1, 'Message must be non-empty'),
  sessionId: z.string().uuid().optional(),
  /** Preferred model when lazy-creating a session from draft mode. */
  model: modelSelectionSchema.nullable().optional(),
  draftGeneration: z.number().int().nonnegative().optional(),
});

export const chatCancelSchema = z.object({
  sessionId: z.string().uuid().optional(),
});

export const chatSnapshotSchema = z.object({
  sessionId: z.string().uuid().optional(),
});

export const chatStopSchema = z.object({
  sessionId: z.string().uuid(),
});

export const subagentSnapshotSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Known top-level config keys — extracted from configSchema so the IPC
 * boundary rejects typos like `{ providres: ... }` that would silently no-op.
 */
const KNOWN_CONFIG_KEYS = new Set(Object.keys(configSchema.shape));

/**
 * Accept partial config updates, including `null` tombstones for deleting
 * nested map entries.
 *
 * Top-level keys are validated against known config schema keys so typos
 * are rejected at the boundary rather than silently ignored.
 *
 * Structure is validated after deep-merge via `configSchema.parse`.
 */
export const configSaveSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
}).strict().superRefine((data, ctx) => {
  for (const key of Object.keys(data.updates)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown config key: "${key}". Known keys: ${[...KNOWN_CONFIG_KEYS].sort().join(', ')}`,
        path: ['updates', key],
      });
    }
    if (key === 'providers') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Legacy provider aliases are no longer accepted in config:save. Use provider connections instead.',
        path: ['updates', key],
      });
    }
  }
});

// ── Session ──────────────────────────────────────────────────────────────────

export const sessionLoadSchema = z.object({
  id: z.string().uuid(),
  /** When false, peek from disk without activating or seeding chat history. */
  activate: z.boolean().optional().default(true),
});

export const sessionDeleteSchema = z.object({
  id: z.string().uuid(),
});

export const sessionRenameSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
});

export const sessionChangeModelSchema = z.object({
  id: z.string().uuid(),
  selection: modelSelectionSchema.nullable(),
  modelLabel: z.string().nullable().optional(),
});

export const sessionChangeCwdSchema = z.object({
  id: z.string().uuid(),
  cwd: z.string().min(1),
});

export const sessionSetWorkspaceSchema = z.object({
  cwd: z.string().min(1),
});

// ── Tool ─────────────────────────────────────────────────────────────────────

export const toolExecuteSchema = z.object({
  name: z.string().min(1),
  args: z.unknown(),
});

/**
 * Tools that the renderer may invoke directly via tool:execute.
 * Only read-only, non-destructive tools are permitted.
 */
export const RENDERER_ALLOWED_TOOLS = new Set([
  'read',
  'read_directory',
  'glob',
  'grep',
  'todo_list',
  'rag_search',
]);

// ── RAG / AST ────────────────────────────────────────────────────────────────

export const ragIndexSchema = z.object({
  force: z.boolean().optional().default(false),
});

export const astIndexSchema = z.object({
  force: z.boolean().optional().default(false),
});
