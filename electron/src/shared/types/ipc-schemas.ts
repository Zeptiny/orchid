/**
 * Zod schemas for preload boundary validation of IPC events and critical
 * invoke results. Main still validates inbound payloads; preload drops/logs
 * malformed outbound events and rejects unexpected invoke shapes.
 */
import { z } from 'zod';
import { contextSnapshotSchema } from './message';

// ── Shared fragments ─────────────────────────────────────────────────────────

const chatEventIdentitySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

const usageSchema = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative(),
  cached_tokens: z.number().nonnegative(),
  context: contextSnapshotSchema.optional(),
});

// ── Chat events ──────────────────────────────────────────────────────────────

export const chatChunkEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('chunk'),
  data: z.string(),
});

export const chatThinkingEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('thinking'),
  data: z.string(),
});

export const chatStateEventSchema = chatEventIdentitySchema.extend({
  state: z.string(),
  response: z.string(),
  error: z.string().nullable(),
  interruptState: z.enum(['idle', 'confirmAgent', 'confirmSubagents']),
  cwd: z.string().nullable().optional(),
});

export const chatDoneEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('done'),
  response: z.string(),
  interrupted: z.boolean().optional(),
  usage: usageSchema.nullable().optional(),
});

export const chatErrorEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('error'),
  error: z.string(),
  title: z.string().optional(),
  kind: z.enum(['stream', 'rate-limit', 'auth', 'generic']).optional(),
});

export const chatUsageEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('usage'),
  usage: usageSchema,
});

export const chatToolCallStartEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('tool_call_start'),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
});

export const chatToolCallDeltaEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('tool_call_delta'),
  toolCallId: z.string().min(1),
  argsDelta: z.string(),
});

export const chatToolCallUpdateEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('tool_call_update'),
  toolCallId: z.string().min(1),
  toolName: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed']),
  args: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

// ── Session / workspace events ───────────────────────────────────────────────

/** Session objects are large; validate identity fields only. */
const sessionIdentitySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
  })
  .passthrough();

export const sessionRenamedEventSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
});

export const sessionCreatedEventSchema = z.object({
  session: sessionIdentitySchema,
  draftGeneration: z.number().optional(),
});

export const sessionWorkspaceChangedEventSchema = z.object({
  workspace: z.object({
    cwd: z.string().nullable(),
    source: z.enum(['draft', 'session', 'default', 'unbound']),
    status: z.enum(['unbound', 'valid', 'missing']),
  }),
});

export const sessionTodosChangedEventSchema = z.object({
  sessionId: z.string().nullable(),
});

export const sessionActivityChangedEventSchema = z.object({
  activity: z
    .object({
      sessionId: z.string().min(1),
      state: z.string(),
      updatedAt: z.number(),
    })
    .passthrough(),
});

export const workingSetChangedEventSchema = z.object({
  snapshot: z.object({
    openSessionIds: z.array(z.string()),
    focusedSessionId: z.string().nullable(),
    mruSessionIds: z.array(z.string()),
  }),
});

// ── Index progress ───────────────────────────────────────────────────────────

export const ragIndexProgressSchema = z
  .object({
    phase: z.string(),
  })
  .passthrough();

export const astIndexProgressSchema = z
  .object({
    phase: z.string(),
  })
  .passthrough();

// ── Updater events ───────────────────────────────────────────────────────────

export const updaterStateSchema = z.object({
  status: z.enum([
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'not-available',
    'error',
  ]),
  version: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  progress: z.number().nullable(),
  error: z.string().nullable(),
});

export const updaterProgressEventSchema = z.object({
  percent: z.number(),
  bytesPerSecond: z.number(),
  transferred: z.number(),
  total: z.number(),
});

export const updaterErrorEventSchema = z.object({
  error: z.string(),
});

// ── Critical invoke results ──────────────────────────────────────────────────

export const chatSendErrorKindSchema = z.enum([
  'session_not_found',
  'unbound_workspace',
  'provider_required',
  'session_busy',
  'runtime_hydration_failed',
  'provider_unavailable',
]);

export const chatSendResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('started'),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
  }),
  z.object({
    status: z.literal('error'),
    kind: chatSendErrorKindSchema,
    error: z.string(),
  }),
]);

export const toolExecuteResultSchema = z.object({
  content: z.string(),
  isError: z.boolean(),
});

export const bgCommandSnapshotResultSchema = z.object({
  tail: z.string(),
  exitCode: z.number().nullable(),
});

export const configSaveResultSchema = z.object({
  status: z.string(),
});

export const workspaceInfoSchema = z.object({
  cwd: z.string().nullable(),
  source: z.enum(['draft', 'session', 'default', 'unbound']),
  status: z.enum(['unbound', 'valid', 'missing']),
});

/** Loose session snapshot: identity + array containers, not full Message graph. */
export const chatSessionSnapshotSchema = z
  .object({
    sessionId: z.string().min(1),
    messages: z.array(z.unknown()),
    live: z
      .object({
        sessionId: z.string().min(1),
        turnId: z.string().min(1),
        sequence: z.number().int().nonnegative(),
        state: z.enum(['idle', 'streaming', 'error']),
      })
      .passthrough()
      .nullable(),
  })
  .nullable();
