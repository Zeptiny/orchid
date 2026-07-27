/**
 * Zod schemas for preload boundary validation of IPC events and critical
 * invoke results. Main still validates inbound payloads; preload drops/logs
 * malformed outbound events and rejects unexpected invoke shapes.
 */
import { z } from 'zod';
import { contextSnapshotSchema } from './message';
import {
  canonicalToolResultSchema,
  terminalToolResultStatusSchema,
  toolExecutionResultSchema,
} from './tool-result';

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
  segmentId: z.string().min(1),
});

export const chatThinkingEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('thinking'),
  data: z.string(),
  segmentId: z.string().min(1),
});

export const chatStateEventSchema = chatEventIdentitySchema.extend({
  state: z.string(),
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

const chatToolCallUpdateBaseSchema = chatEventIdentitySchema.extend({
  type: z.literal('tool_call_update'),
  toolCallId: z.string().min(1),
  toolName: z.string().optional(),
  args: z.string().optional(),
});
export const chatToolCallUpdateEventSchema = z.discriminatedUnion('status', [
  chatToolCallUpdateBaseSchema.extend({
    status: z.literal('running'),
    content: z.never().optional(),
    toolResult: z.never().optional(),
  }),
  chatToolCallUpdateBaseSchema.extend({
    status: terminalToolResultStatusSchema,
    content: z.string(),
    toolResult: canonicalToolResultSchema,
  }),
]).superRefine((value, ctx) => {
  if (
    value.status !== 'running' &&
    value.status !== value.toolResult.status
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['toolResult', 'status'],
      message: 'Tool update status must match canonical result status',
    });
  }
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

export const toolExecuteResultSchema = toolExecutionResultSchema;

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

export const sessionReasoningConfigResultSchema = z.object({
  levels: z.array(z.string()),
  default: z.union([z.string(), z.number()]).nullable(),
  override: z.union([z.string(), z.number()]).nullable(),
  supportsReasoning: z.boolean(),
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

const subagentLiveSegmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), id: z.string(), content: z.string() }),
  z.object({ kind: z.literal('thinking'), id: z.string(), content: z.string() }),
  z.object({ kind: z.literal('tool'), id: z.string(), toolCallId: z.string() }),
]);
const subagentToolSchema = z.object({
  toolCallId: z.string(), toolName: z.string(),
  status: z.union([z.enum(['generating', 'running']), terminalToolResultStatusSchema]),
  partialArgs: z.string(), args: z.string(), content: z.string().nullable(),
  toolResult: canonicalToolResultSchema.nullable(),
  startedAt: z.string(), finishedAt: z.string().nullable(),
}).superRefine((value, ctx) => {
  const isLifecycle = value.status === 'generating' || value.status === 'running';
  if (isLifecycle && value.toolResult !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolResult'], message: 'Running tools cannot have terminal facts' });
  }
  if (!isLifecycle && (value.toolResult === null || value.content === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolResult'], message: 'Terminal tools require canonical facts and exact content' });
  }
  if (!isLifecycle && value.toolResult?.status !== value.status) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Snapshot status must match canonical result status' });
  }
});
export const subagentLiveProjectionSchema = z.object({
  sessionId: z.string().nullable(), subagentId: z.string(), runId: z.string(),
  sequence: z.number().int().nonnegative(),
  state: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted']),
  segments: z.array(subagentLiveSegmentSchema), toolCalls: z.array(subagentToolSchema),
  usage: usageSchema.nullable(), result: z.string().nullable(), error: z.string().nullable(),
});
export const subagentRecordSchema = z.object({
  id: z.string(), agent_name: z.string(), agent_type: z.string(), agent_tier: z.string(),
  task: z.string(), status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted']),
  chain_id: z.string(), start_time: z.string(), end_time: z.string().nullable(),
  result: z.string().nullable(), error: z.string().nullable(), parentChainIndex: z.number().int().nullable(),
  reasoning_effort: z.union([z.string(), z.number()]).optional(),
  chain: z.unknown(),
});
export const subagentSnapshotSchema = z.object({
  sessionId: z.string().uuid(), records: z.array(subagentRecordSchema),
  live: z.array(subagentLiveProjectionSchema),
});
export const subagentEventSchema = z.object({
  sessionId: z.string().uuid(), subagentId: z.string(), runId: z.string(),
  sequence: z.number().int().positive(), type: z.literal('projection'),
  projection: subagentLiveProjectionSchema,
  record: subagentRecordSchema.optional(),
});
