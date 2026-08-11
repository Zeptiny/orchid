/**
 * Zod schemas for preload boundary validation of IPC events and critical
 * invoke results. Main still validates inbound payloads; preload drops/logs
 * malformed outbound events and rejects unexpected invoke shapes.
 */
import { z } from 'zod';
import {
  contextSnapshotSchema,
  THINKING_BLOB_MAX_LENGTH,
  THINKING_DISPLAY_TEXT_MAX_LENGTH,
  THINKING_ITEM_ID_MAX_LENGTH,
} from './message';
import { subagentStatusSchema } from './subagent';
import { STARTUP_STEP_DEFINITIONS, type StartupStepId } from './ipc-boundary';
import { toolCallSchema } from './tool';
import {
  canonicalToolResultSchema,
  terminalToolResultStatusSchema,
  toolExecutionResultSchema,
} from './tool-result';

// ── Startup ─────────────────────────────────────────────────────────────────

const startupStepIds = STARTUP_STEP_DEFINITIONS.map(({ id }) => id) as [
  StartupStepId,
  ...StartupStepId[],
];

const startupStepSchema = z.object({
  id: z.enum(startupStepIds),
  label: z.string(),
  state: z.enum(['pending', 'active', 'complete', 'skipped', 'warning', 'failed']),
  durationMs: z.number().nonnegative().nullable(),
});

export const startupSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  phase: z.enum(['starting', 'ready', 'degraded', 'failed']),
  steps: z.array(startupStepSchema).length(STARTUP_STEP_DEFINITIONS.length),
}).superRefine((snapshot, ctx) => {
  snapshot.steps.forEach((step, index) => {
    const expectedStep = STARTUP_STEP_DEFINITIONS[index];
    if (!expectedStep || step.id !== expectedStep.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'id'], message: 'Startup steps must preserve their fixed order' });
    }
    if (!expectedStep || step.label !== expectedStep.label) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'label'], message: 'Startup step labels must be fixed' });
    }
  });
});

export const startupContinueDegradedResultSchema = z.object({
  ok: z.boolean(),
  snapshot: startupSnapshotSchema,
});

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
  reasoning_tokens: z.number().nonnegative().optional(),
  context: contextSnapshotSchema.optional(),
});

/** Replay artifact shape; opaque provider blobs cross the boundary uninterpreted. */
export const thinkingReplayPayloadSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  kind: z.enum(['signed', 'redacted', 'encrypted', 'opaque', 'text']),
  blob: z.string().max(THINKING_BLOB_MAX_LENGTH).nullable(),
  displayText: z.string().max(THINKING_DISPLAY_TEXT_MAX_LENGTH).nullable(),
  itemId: z.string().max(THINKING_ITEM_ID_MAX_LENGTH).optional(),
  reasoningTokenCount: z.number().nonnegative().optional(),
}).strict();

/** Durable messages are terminal-history authority, so validate their full shape. */
const messageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  type: z.enum(['text', 'thinking', 'tool_call', 'tool_result', 'error']),
  tool_calls: z.array(toolCallSchema).nullable(),
  tool_call_id: z.string().nullable(),
  name: z.string().nullable(),
  thinking: z.string().nullable(),
  thinking_payload: thinkingReplayPayloadSchema.optional(),
  timestamp: z.string().datetime({ offset: true }),
  usage: usageSchema.nullable(),
  hidden: z.boolean(),
  excludeFromModel: z.boolean().optional(),
  tool_result: canonicalToolResultSchema.nullable(),
}).strict();

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
  messages: z.array(messageSchema),
  interrupted: z.boolean().optional(),
  usage: usageSchema.nullable().optional(),
});

export const chatErrorEventSchema = chatEventIdentitySchema.extend({
  type: z.literal('error'),
  error: z.string(),
  messages: z.array(messageSchema),
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

export const trustStateSchema = z.enum(['trusted', 'untrusted', 'changed']);

export const workspaceInfoSchema = z.object({
  cwd: z.string().nullable(),
  source: z.enum(['draft', 'session', 'default', 'unbound']),
  status: z.enum(['unbound', 'valid', 'missing']),
  // Optional so payloads from pre-trust producers still parse.
  trust: trustStateSchema.optional(),
});

export const sessionWorkspaceChangedEventSchema = z.object({
  workspace: workspaceInfoSchema,
});

// ── Trusted projects ────────────────────────────────────────────────────────

export const trustReportMcpServerSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['added', 'override']),
  command: z.string().optional(),
  url: z.string().optional(),
  args: z.array(z.string()).optional(),
  envKeys: z.array(z.string()).optional(),
});

export const trustReportPermissionSchema = z.object({
  tool: z.string().min(1),
  rule: z.string(),
  autoAllow: z.boolean(),
});

export const trustReportConfigOverrideSchema = z.object({
  key: z.string().min(1),
  projectValue: z.string(),
  homeValue: z.string(),
});

export const trustReportModelOverrideSchema = z.object({
  key: z.string().min(1),
  connectionId: z.string(),
  modelId: z.string(),
});

export const trustReportDefinitionSchema = z.object({
  kind: z.enum(['agent', 'skill', 'personality']),
  name: z.string().min(1),
  overridesHome: z.boolean(),
});

export const projectTrustReportSchema = z.object({
  projectDir: z.string().min(1),
  hasSurface: z.boolean(),
  mcpServers: z.array(trustReportMcpServerSchema),
  permissions: z.array(trustReportPermissionSchema),
  agentsMdOverrides: z.array(trustReportConfigOverrideSchema),
  modelOverrides: z.array(trustReportModelOverrideSchema),
  otherConfigOverrides: z.array(trustReportConfigOverrideSchema),
  definitions: z.array(trustReportDefinitionSchema),
  instructionFiles: z.array(z.string()),
});

export const projectTrustInfoSchema = z.object({
  projectDir: z.string().min(1),
  state: trustStateSchema,
  report: projectTrustReportSchema.nullable(),
});

export const projectTrustChangedEventSchema = z.object({
  projectDir: z.string().min(1),
  state: trustStateSchema,
});

export const trustedProjectEntrySchema = z.object({
  projectDir: z.string().min(1),
  trustedAt: z.string(),
  state: trustStateSchema,
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
  'untrusted_project',
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

export const bgCommandSnapshotRequestSchema = z
  .object({
    commandId: z.number().int().positive().optional(),
    toolCallId: z.string().min(1).optional(),
    lastN: z.number().int().positive().max(1000).optional(),
    sessionId: z.string().uuid().optional(),
    /**
     * When false, the handler returns `tail: ''` without touching the buffer
     * and keeps all other fields (running/exitCode/owner/etc). Default `true`
     * when omitted.
     */
    includeTail: z.boolean().optional(),
  })
  .refine(
    (data) => (data.commandId !== undefined) !== (data.toolCallId !== undefined),
    { message: 'Provide exactly one of commandId or toolCallId' },
  );

export const bgCommandOwnerSchema = z.enum(['AGENT', 'USER']);

export const bgCommandSnapshotResultSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    tail: z.string(),
    exitCode: z.number().nullable(),
    // New metadata fields are optional so old preloads that only expect
    // tail/exitCode remain wire-compatible; handlers still emit them.
    running: z.boolean().optional().default(true),
    interactive: z.boolean().optional().default(false),
    owner: bgCommandOwnerSchema.optional().default('AGENT'),
    command: z.string().optional().default(''),
    description: z.string().optional(),
    agentScopeId: z.string().optional().default('main'),
    createdAt: z.number().optional(),
  }),
  z.object({
    found: z.literal(false),
  }),
]);

export const bgCommandListItemSchema = z.object({
  id: z.number().int().positive(),
  command: z.string(),
  description: z.string(),
  interactive: z.boolean(),
  owner: bgCommandOwnerSchema,
  agentScopeId: z.string(),
  scopeName: z.string(),
  running: z.boolean(),
  exitCode: z.number().nullable(),
  createdAt: z.number(),
  lastOutputAt: z.number(),
});

export const bgCommandListResultSchema = z.array(bgCommandListItemSchema);

export const bgCommandSendInputResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['not_found', 'not_interactive', 'exited', 'write_failed']),
  }),
]);

export const bgCommandTerminateResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.literal('not_found') }),
]);

export const bgCommandReleaseInputResultSchema = z.object({
  ok: z.boolean(),
});

export const bgCommandChangedEventSchema = z.object({
  sessionId: z.string(),
});

export const configSaveResultSchema = z.object({
  status: z.string(),
});

export const sessionReasoningConfigResultSchema = z.object({
  levels: z.array(z.string()),
  default: z.union([z.string(), z.number()]).nullable(),
  override: z.union([z.string(), z.number()]).nullable(),
  supportsReasoning: z.boolean(),
});

export const serviceTierOptionViewSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  requiresStreaming: z.boolean().optional(),
});

export const sessionServiceTierConfigResultSchema = z.object({
  mechanism: z.enum(['request-parameter', 'model-name-variants']).nullable(),
  tiers: z.array(serviceTierOptionViewSchema),
  selected: z.string().nullable(),
  override: z.string().nullable(),
  effective: z.string().nullable(),
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
  state: subagentStatusSchema,
  segments: z.array(subagentLiveSegmentSchema), toolCalls: z.array(subagentToolSchema),
  usage: usageSchema.nullable(), result: z.string().nullable(), error: z.string().nullable(),
});
export const ipcSubagentRecordSchema = z.object({
  id: z.string(), agent_name: z.string(), agent_type: z.string(), agent_tier: z.string(),
  task: z.string(), status: subagentStatusSchema,
  chain_id: z.string(), start_time: z.string(), end_time: z.string().nullable(),
  result: z.string().nullable(), error: z.string().nullable(), parentChainIndex: z.number().int().nullable(),
  reasoning_effort: z.union([z.string(), z.number()]).optional(),
  closed: z.boolean().default(false),
  chain: z.unknown(),
});
export const subagentSnapshotSchema = z.object({
  sessionId: z.string().uuid(),
  sessionRevision: z.number().int().nonnegative(),
  records: z.array(ipcSubagentRecordSchema),
  live: z.array(subagentLiveProjectionSchema),
});

// ── Subagent live delta events ───────────────────────────────────────────────

const subagentDeltaBaseSchema = z.object({
  sessionId: z.string().uuid(),
  subagentId: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  sessionRevision: z.number().int().nonnegative(),
});
export const subagentSpawnedEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('spawned'), record: ipcSubagentRecordSchema, usage: usageSchema.nullable(),
});
export const subagentTextDeltaEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('text_delta'), segmentId: z.string(), append: z.string(),
});
export const subagentThinkingDeltaEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('thinking_delta'), segmentId: z.string(), append: z.string(),
});
export const subagentToolStartEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('tool_start'), segmentId: z.string(), toolCallId: z.string(),
  toolName: z.string(), status: z.enum(['generating', 'running']),
  args: z.string(), startedAt: z.string(),
});
export const subagentToolArgsDeltaEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('tool_args_delta'), toolCallId: z.string(), append: z.string(),
});
export const subagentToolResultEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('tool_result'), toolCallId: z.string(),
  status: terminalToolResultStatusSchema, content: z.string(),
  toolResult: canonicalToolResultSchema, finishedAt: z.string(),
});
export const subagentUsageEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('usage'), usage: usageSchema,
});
export const subagentTerminalEventSchema = subagentDeltaBaseSchema.extend({
  type: z.literal('terminal'), record: ipcSubagentRecordSchema,
  state: z.enum(['completed', 'failed', 'interrupted']), usage: usageSchema.nullable(),
});
export const subagentDeltaEventSchema = z.discriminatedUnion('type', [
  subagentSpawnedEventSchema,
  subagentTextDeltaEventSchema,
  subagentThinkingDeltaEventSchema,
  subagentToolStartEventSchema,
  subagentToolArgsDeltaEventSchema,
  subagentToolResultEventSchema,
  subagentUsageEventSchema,
  subagentTerminalEventSchema,
]);
/** Batched SUBAGENTS_EVENT payload — the unit of IPC delivery. */
export const subagentEventSchema = z.object({
  sessionId: z.string().uuid(),
  events: z.array(subagentDeltaEventSchema),
});
