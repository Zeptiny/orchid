/**
 * Host protocol — the typed wire contract shared by the Electron client and
 * the headless `orchid-agent` daemon (issue #112, plan 2026-08-23-001).
 *
 * Frames are newline-delimited JSON (see ./framing.ts) carrying one of three
 * envelope kinds: request, response, or event. Method params/results and
 * event payloads REUSE the existing IPC zod schemas wherever the shapes are
 * identical so the IPC surface and the protocol cannot drift; schemas defined
 * here exist only where the IPC boundary has none yet.
 *
 * Local-only channel families (machines, analytics, updater, startup) never
 * route to a host and are therefore absent from these registries.
 */
import { z } from 'zod';
import { AgentTier, AgentType } from '../types/agent';
import { PERMISSION_MODE_VALUES, RiskClass, ToolScope } from '../types/permission';
import {
  connectionHealthSchema,
  modelSelectionSchema,
  providerAuthMethodSchema,
  providerLifecycleSchema,
  providerProtocolSchema,
  reasoningModelConfigSchema,
} from '../types/provider';
import {
  cacheTtlOptionSchema,
  currencyUnitSchema,
  pricingContextTierSchema,
  pricingRateFieldsSchema,
  providerQuotaSchema,
} from '../types/provider-facets';
import {
  astIndexProgressSchema,
  bgCommandChangedEventSchema,
  bgCommandListResultSchema,
  bgCommandReleaseInputResultSchema,
  bgCommandSendInputResultSchema,
  bgCommandSnapshotRequestSchema,
  bgCommandSnapshotResultSchema,
  bgCommandTerminateResultSchema,
  chatChunkEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
  chatSendResultSchema,
  chatSessionSnapshotSchema,
  chatStateEventSchema,
  chatThinkingEventSchema,
  chatToolCallDeltaEventSchema,
  chatToolCallStartEventSchema,
  chatToolCallUpdateEventSchema,
  chatUsageEventSchema,
  compactionProgressEventSchema,
  configSaveResultSchema,
  indexAutoRefreshEventSchema,
  projectTrustChangedEventSchema,
  projectTrustInfoSchema,
  ragIndexProgressSchema,
  serviceTierOptionViewSchema,
  sessionActivityChangedEventSchema,
  sessionCompactionEventSchema,
  sessionCreatedEventSchema,
  sessionDeleteResultSchema,
  sessionDeletedEventSchema,
  sessionHistoryPageResultSchema,
  sessionRenamedEventSchema,
  sessionTodosChangedEventSchema,
  sessionUpdatedEventSchema,
  sessionWorkspaceChangedEventSchema,
  subagentDetailResultSchema,
  subagentEventSchema,
  subagentSnapshotSchema as subagentSnapshotResultSchema,
  toolExecuteResultSchema,
  trustedProjectEntrySchema,
  workingSetChangedEventSchema,
  workingSetSnapshotSchema,
  workspaceInfoSchema,
} from '../types/ipc-schemas';
import {
  askQuestionAnswerSchema,
  askQuestionCancelSchema,
  astIndexSchema,
  chatCancelSchema,
  chatCompactSchema,
  chatQueueNextSchema,
  chatSendSchema,
  chatSnapshotSchema,
  chatStopSchema,
  configReadProjectSchema,
  configSaveProjectSchema,
  configSaveSchema,
  projectTrustGetSchema,
  projectTrustSetSchema,
  ragIndexSchema,
  sessionChangeCwdSchema,
  sessionChangeModelSchema,
  sessionDeleteSchema,
  sessionHistoryPageSchema,
  sessionLoadSchema,
  sessionOpenSchema,
  sessionRenameSchema,
  sessionSetReasoningEffortSchema,
  sessionSetServiceTierSchema,
  sessionSetWorkspaceSchema,
  subagentDetailSchema as subagentDetailParamsSchema,
  subagentSnapshotSchema as subagentSnapshotParamsSchema,
  toolExecuteSchema,
} from '../../main/ipc/payload-schemas';
import { configSchema } from '../../main/config/schema';

/** Protocol revision. Peers must agree exactly (equal-version handshake). */
export const PROTOCOL_VERSION = 1;

// ── Envelope ──────────────────────────────────────────────────────────────────

/** Client-assigned correlation id linking a response back to its request. */
export type HostRequestId = string | number;

const requestIdSchema = z.union([z.string().min(1), z.number().int().nonnegative()]);

/** Error leg of a response envelope; `code` is one of HOST_ERROR_CODES. */
export const hostErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  data: z.unknown().optional(),
}).strict();

export type HostErrorPayload = z.infer<typeof hostErrorPayloadSchema>;

export const hostRequestSchema = z.object({
  id: requestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();

export const hostResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    id: requestIdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    id: requestIdSchema,
    ok: z.literal(false),
    error: hostErrorPayloadSchema,
  }).strict(),
]);

export const hostEventSchema = z.object({
  ev: z.string().min(1),
  params: z.unknown().optional(),
  seq: z.number().int().nonnegative(),
}).strict();

export const hostMessageSchema = z.union([
  hostRequestSchema,
  hostResponseSchema,
  hostEventSchema,
]);

export interface HostRequest<TParams = unknown> {
  readonly id: HostRequestId;
  readonly method: string;
  readonly params: TParams;
}

export type HostResponse<TResult = unknown> =
  | { readonly id: HostRequestId; readonly ok: true; readonly result: TResult }
  | { readonly id: HostRequestId; readonly ok: false; readonly error: HostErrorPayload };

export interface HostEvent<TParams = unknown> {
  readonly ev: string;
  readonly params: TParams;
  /** Per-connection monotonic sequence; gaps drive reconnect resync. */
  readonly seq: number;
}

export function isHostRequest(value: unknown): value is HostRequest {
  return hostRequestSchema.safeParse(value).success;
}

export function isHostResponse(value: unknown): value is HostResponse {
  return hostResponseSchema.safeParse(value).success;
}

export function isHostEvent(value: unknown): value is HostEvent {
  return hostEventSchema.safeParse(value).success;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** Typed protocol error codes carried on the response error leg. */
export const HOST_ERROR_CODES = {
  /** Handshake advertised a different PROTOCOL_VERSION. */
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  /** No entry for the requested method in HOST_METHODS. */
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  /** Method params failed the registry's params schema. */
  INVALID_PARAMS: 'INVALID_PARAMS',
  /** Handler threw; message carries the sanitized detail. */
  INTERNAL: 'INTERNAL',
  /** Channel family is host-routed but the capability is absent (e.g. vault writes on a remote). */
  UNSUPPORTED_ON_HOST: 'UNSUPPORTED_ON_HOST',
  /** Method arrived before a successful `host.hello` handshake (U4). */
  HANDSHAKE_REQUIRED: 'HANDSHAKE_REQUIRED',
  /** Transport lost the host before a response arrived. */
  HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
  /** No response within the request deadline. */
  TIMEOUT: 'TIMEOUT',
} as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[keyof typeof HOST_ERROR_CODES];

/**
 * Field under which an in-process server carries the *original* thrown value
 * on the response error leg so a co-located client can rethrow it verbatim
 * (error identity preservation — see main/host/transport-inprocess.ts).
 *
 * The field is attached NON-enumerably, so wire transports that JSON-encode
 * the error payload never serialize it (and can never trip on a circular
 * thrown value); only in-process readers observe it.
 */
export const HOST_ORIGINAL_ERROR_KEY = '__orchidOriginalError';

/** Carry the original thrown value on an error payload without serializing it. */
export function attachHostOriginalError(
  payload: HostErrorPayload,
  error: unknown,
): HostErrorPayload {
  Object.defineProperty(payload, HOST_ORIGINAL_ERROR_KEY, {
    value: error,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return payload;
}

/**
 * Read the original thrown value carried on an error payload, if any.
 *
 * Only real `Error` instances are accepted: the in-process path attaches the
 * thrown value by reference, while a JSON-deserialized payload (the wire) can
 * only ever carry a plain object under this key — including one a hostile peer
 * smuggled in verbatim. Anything that is not an `Error` is dropped so the
 * client falls through to constructing a typed {@link HostProtocolError}
 * instead of rejecting with an arbitrary non-Error value.
 */
export function takeHostOriginalError(payload: HostErrorPayload): Error | undefined {
  if (payload == null || typeof payload !== 'object') return undefined;
  const carried = (payload as Record<string, unknown>)[HOST_ORIGINAL_ERROR_KEY];
  return carried instanceof Error ? carried : undefined;
}

/** Error throwable by both sides; serializes onto the response error leg. */
export class HostProtocolError extends Error {
  readonly code: HostErrorCode;
  readonly data?: unknown;

  constructor(code: HostErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'HostProtocolError';
    this.code = code;
    this.data = data;
  }

  toPayload(): HostErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

// ── Handshake ─────────────────────────────────────────────────────────────────

/** The one method every server answers before any other: version + capabilities. */
export const HOST_HELLO_METHOD = 'host.hello';

export const hostHelloParamsSchema = z.object({
  protocolVersion: z.number().int().nonnegative(),
  clientId: z.string().min(1).optional(),
}).strict();

export const hostHelloResultSchema = z.object({
  protocolVersion: z.number().int().nonnegative(),
  serverVersion: z.string().optional(),
  capabilities: z.array(z.string()),
}).strict();

export type HostHelloParams = z.infer<typeof hostHelloParamsSchema>;
export type HostHelloResult = z.infer<typeof hostHelloResultSchema>;

/**
 * Version policy (plan U2): equal versions pass, anything else is a typed
 * PROTOCOL_MISMATCH. Both peers run this against the other's advertised value.
 */
export function assertProtocolVersionMatches(expected: number, offered: number): void {
  if (expected !== offered) {
    throw new HostProtocolError(
      HOST_ERROR_CODES.PROTOCOL_MISMATCH,
      `Protocol version mismatch: expected ${expected}, peer offered ${offered}`,
      { expected, offered },
    );
  }
}

// ── Capabilities ──────────────────────────────────────────────────────────────

/**
 * Capabilities a server may declare in the `host.hello` result. Clients branch
 * on these (absent ⇒ typed UNSUPPORTED_ON_HOST instead of sending the method).
 */
export const HOST_CAPABILITIES = {
  /** Home/project config writes are honored (config.save, config.save_project). */
  CONFIG_WRITE: 'config.write',
  /** Provider connections/models/status are readable (providers.* reads). */
  PROVIDERS_READ: 'providers.read',
  /** Credential writes work (providers create/update/submit_api_key/disconnect/delete). */
  PROVIDERS_VAULT_WRITES: 'providers.vault-writes',
  /** definition.reveal resolves host-local file paths. */
  DEFINITIONS_REVEAL: 'definitions.reveal',
  /** session.pick_project_dir can open a host-native directory dialog. */
  SESSION_PICK_PROJECT_DIR: 'session.pick_project_dir',
} as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[keyof typeof HOST_CAPABILITIES];

// ── Channel ↔ method mapping ──────────────────────────────────────────────────

/**
 * IPC channel names map to protocol methods mechanically: every ':' becomes
 * '.'. Example: 'chat:send' ↔ 'chat.send', 'session:working_set_get' ↔
 * 'session.working_set_get'. Host-internal methods ('host.hello') have no IPC
 * channel counterpart.
 */
export function channelToMethod(channel: string): string {
  return channel.replaceAll(':', '.');
}

/** Inverse of channelToMethod: the first '.' becomes ':' (family separator). */
export function methodToChannel(method: string): string {
  const dot = method.indexOf('.');
  return dot === -1 ? method : `${method.slice(0, dot)}:${method.slice(dot + 1)}`;
}

// ── Locally defined params schemas (no IPC boundary schema exists yet) ────────

/** Params for methods whose IPC handler takes no payload. */
const noParams = z.void();

const workingSetIdParamsSchema = z.object({ id: z.string().uuid() });

const workingSetSetFocusParamsSchema = z.object({ id: z.string().uuid().nullable() });

const sessionMarkSeenParamsSchema = z.object({ id: z.string().uuid() });

const bgCommandListParamsSchema = z.object({
  sessionId: z.string().uuid().optional(),
});

/**
 * Mirrors the bgcmd:send_input handler schema (main/ipc/chat.ts), including
 * the SEND_INPUT_MAX_TEXT_LENGTH stdin cap (8192) it enforces.
 */
const bgCommandSendInputParamsSchema = z.object({
  commandId: z.number().int().positive(),
  text: z.string().max(8192),
  sessionId: z.string().uuid().optional(),
});

/** Shared shape for bgcmd:terminate and bgcmd:release_input. */
const bgCommandControlParamsSchema = z.object({
  commandId: z.number().int().positive(),
  sessionId: z.string().uuid().optional(),
});

const permissionModeWireSchema = z.enum(PERMISSION_MODE_VALUES);

const riskClassWireSchema = z.enum(Object.values(RiskClass) as [RiskClass, ...RiskClass[]]);

const toolScopeWireSchema = z.enum([ToolScope.INSIDE, ToolScope.OUTSIDE]);

/**
 * `AskQuestionAskedEvent` (shared/types/ipc.ts) — no IPC boundary schema
 * exists yet, so the protocol owns this one.
 */
export const askQuestionAskedEventSchema = z.object({
  sessionId: z.string().uuid(),
  toolCallId: z.string().uuid(),
  questions: z.array(z.object({
    type: z.enum(['single', 'multi']),
    title: z.string(),
    description: z.string().optional(),
    options: z.array(z.object({
      label: z.string(),
      description: z.string().optional(),
    })),
  })),
});

/** `AskQuestionSettledEvent` (shared/types/ipc.ts) — protocol-owned schema. */
export const askQuestionSettledEventSchema = z.object({
  sessionId: z.string().uuid(),
  toolCallId: z.string().uuid(),
  result: z.enum(['answered', 'cancelled']),
});

/**
 * `PermissionApprovalRequestedEvent` (shared/types/ipc.ts) — no IPC boundary
 * schema exists yet, so the protocol owns this one. Doubles as the snapshot
 * approval entry (identical shape).
 */
export const permissionApprovalRequestedEventSchema = z.object({
  toolCallId: z.string().min(1),
  sessionId: z.string().uuid(),
  toolName: z.string().min(1),
  riskClass: riskClassWireSchema,
  args: z.unknown(),
  cwd: z.string(),
  scope: toolScopeWireSchema.optional(),
});

/** `PermissionApprovalSettledEvent` (shared/types/ipc.ts) — protocol-owned schema. */
export const permissionApprovalSettledEventSchema = z.object({
  sessionId: z.string().uuid(),
  toolCallId: z.string().min(1),
  result: z.object({
    decision: z.enum(['approved', 'denied']),
    reason: z.string().optional(),
  }),
});

// ── Reconnect resync (U10) ────────────────────────────────────────────────────

/** Params for `host.pending_state` — pending approvals/questions, optionally scoped. */
export const hostPendingStateParamsSchema = z.object({
  sessionId: z.string().uuid().optional(),
}).strict();

/**
 * Result of `host.pending_state`: every pending approval/question for the
 * scope (owner fields stripped) as the byte-identical event payloads a live
 * delivery produces, so a reconnecting client can re-broadcast them through
 * the same renderer paths without inventing new messages.
 */
export const hostPendingStateResultSchema = z.object({
  approvals: z.array(permissionApprovalRequestedEventSchema),
  questions: z.array(askQuestionAskedEventSchema),
}).strict();

export type HostPendingStateParams = z.infer<typeof hostPendingStateParamsSchema>;
export type HostPendingStateResult = z.infer<typeof hostPendingStateResultSchema>;

/** Mirrors the permission:approval_answer handler schema (main/ipc/permission.ts). */
const permissionApprovalAnswerParamsSchema = z.object({
  toolCallId: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  reason: z.string().optional(),
});

/** Mirrors the permission:set_session_mode handler schema. */
const permissionSetSessionModeParamsSchema = z.object({
  mode: permissionModeWireSchema.nullable(),
  expectedSessionId: z.string().min(1).nullable(),
});

/** Mirrors the permission:get_session_mode handler schema. */
const permissionGetSessionModeParamsSchema = z.object({
  expectedSessionId: z.string().min(1).nullable(),
});

/** `DefinitionScope` (shared/types/definitions.ts). */
const definitionScopeSchema = z.enum(['global', 'project']);

const definitionNameSchema = z.string().min(1).max(128);

/** Mirrors the skill:save handler schema (main/ipc/definitions.ts). */
const skillSaveParamsSchema = z.object({
  scope: definitionScopeSchema,
  name: definitionNameSchema,
  description: z.string().min(1),
  requires: z.array(z.string()).optional(),
  content: z.string(),
  previousName: z.string().optional(),
});

/** Mirrors the agent:save handler schema. */
const agentSaveParamsSchema = z.object({
  scope: definitionScopeSchema,
  name: definitionNameSchema,
  type: z.enum([AgentType.INTERNAL, AgentType.SUBAGENT]),
  tier: z.enum([
    AgentTier.SEED,
    AgentTier.SPROUT,
    AgentTier.BLOOM,
    AgentTier.CROWN,
  ]),
  description: z.string().min(1),
  system_prompt: z.string(),
  allowed_tools: z.array(z.string()).min(1),
  allowed_skills: z.array(z.string()),
  previousName: z.string().optional(),
});

/** Mirrors the personality:save handler schema. */
const personalitySaveParamsSchema = z.object({
  scope: definitionScopeSchema,
  name: definitionNameSchema,
  content: z.string().min(1),
  previousName: z.string().optional(),
});

/** Mirrors the shared_prompt:save handler schema. */
const sharedPromptSaveParamsSchema = z.object({
  scope: definitionScopeSchema,
  slot: z.enum(['all-agents', 'subagents']),
  content: z.string(),
});

/** Mirrors the shared_prompt:delete handler schema. */
const sharedPromptDeleteParamsSchema = z.object({
  scope: definitionScopeSchema,
  slot: z.enum(['all-agents', 'subagents']),
});

/** Mirrors the agent/skill/personality:delete handler schema. */
const definitionDeleteParamsSchema = z.object({
  scope: definitionScopeSchema,
  name: definitionNameSchema,
});

/** Mirrors the definition:reveal handler schema. */
const definitionRevealParamsSchema = z.object({
  path: z.string().min(1),
});

/** Mirrors the providers connection-id handler schema (main/ipc/providers.ts). */
const providerConnectionIdParamsSchema = z.object({
  connectionId: z.string().uuid(),
}).strict();

/** Mirrors the providers:disconnect/delete confirmation shape. */
const providerDisconnectParamsSchema = providerConnectionIdParamsSchema
  .extend({ confirm: z.literal(true) })
  .strict();

/**
 * Mirrors the providers:model_list handler schema (main/ipc/provider-models.ts):
 * `connectionId` is optional — an absent id lists options across connections.
 * (U5 additive fix: the original draft required it, which would have rejected
 * the renderer's "no connection selected" listing.)
 */
const providerModelListParamsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  includeDisabled: z.boolean().optional(),
}).strict().optional();

/** Mirrors the providers:status_refresh handler schema. */
const providerStatusRefreshParamsSchema = z.object({
  providerId: z.string().trim().min(1),
  connectionId: z.string().uuid().optional(),
}).strict();

// ── Locally defined result schemas (no IPC boundary schema exists yet) ────────

const okResultSchema = z.object({ ok: z.boolean() }).strict();

const voidResult = z.void();

/**
 * `ChatCompactResult` (shared/types/ipc.ts) — result of a user-initiated
 * /compact on an idle session.
 */
const chatCompactResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('compacted'), sessionId: z.string().min(1) }).strict(),
  z.object({ status: z.literal('busy'), sessionId: z.string().min(1) }).strict(),
  z.object({
    status: z.literal('nothing_to_compact'),
    sessionId: z.string().min(1),
    detail: z.string().optional(),
  }).strict(),
  z.object({ status: z.literal('error'), error: z.string() }).strict(),
]);

/** `SessionSummary` (shared/types/ipc-boundary.ts). */
const sessionSummaryResultSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  modelLabel: z.string().nullable(),
  cwd: z.string().nullable(),
  chainCount: z.number().int().nonnegative(),
  updatedAt: z.number(),
}).strict();

/**
 * Loose by design: `Session` (shared/types/session.ts) has no zod schema and
 * its durable graph (chains/messages/subagents) is parsed leniently on load;
 * only identity fields are pinned here, mirroring the sessionIdentitySchema
 * precedent in shared/types/ipc-schemas.ts.
 */
const sessionResultSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
}).passthrough();

/**
 * Loose by design: `ChatSnapshot` (shared/types/ipc.ts) has no zod schema;
 * identity fields mirror the live object nested in chatSessionSnapshotSchema.
 */
const chatSnapshotResultSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  state: z.enum(['idle', 'streaming', 'error']),
}).passthrough();

/**
 * `SessionOpenResult` (shared/types/ipc.ts). `messages` is loose
 * (`Message[]` has no exported schema; chatSessionSnapshotSchema treats the
 * same array as unknown) and `live` reuses the loose ChatSnapshot envelope.
 */
const sessionOpenResultSchema = z.object({
  session: sessionResultSchema.nullable(),
  messages: z.array(z.unknown()),
  live: chatSnapshotResultSchema.nullable(),
  workspace: workspaceInfoSchema,
  lastChainError: z.object({
    detail: z.string(),
    title: z.string().nullable().optional(),
  }).nullable().optional(),
}).strict();

/** `SessionActivity` (shared/types/ipc-boundary.ts). */
const sessionActivityResultSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().nullable(),
  state: z.enum(['idle', 'working', 'waiting', 'needs_attention']),
  phase: z.enum(['agent', 'tool', 'subagent', 'command']).nullable(),
  detail: z.string().nullable(),
  startedAt: z.number().nullable(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  unread: z.boolean(),
  backgroundProcessCount: z.number().int().nonnegative(),
  canCancel: z.boolean(),
}).strict();

const askQuestionSnapshotResultSchema = z.object({
  questions: z.array(askQuestionAskedEventSchema),
});

const permissionSnapshotResultSchema = z.object({
  approvals: z.array(permissionApprovalRequestedEventSchema),
}).strict();

/** `PermissionSessionModeMutationResult` (shared/types/ipc.ts). */
const permissionSessionModeMutationResultSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string().nullable(),
}).strict();

/** `PermissionSessionModeResult` (shared/types/ipc.ts). */
const permissionSessionModeResultSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string().nullable(),
  mode: permissionModeWireSchema.nullable(),
}).strict();

/** `ManagedSkill` (shared/types/definitions.ts). */
const managedSkillResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  requires: z.array(z.string()),
  content: z.string(),
  resources: z.array(z.object({
    path: z.string(),
    description: z.string(),
  }).strict()),
  scope: definitionScopeSchema,
  path: z.string(),
  overriddenByProject: z.boolean(),
}).strict();

/** `ManagedAgent` (shared/types/definitions.ts). */
const managedAgentResultSchema = z.object({
  name: z.string(),
  type: z.enum([AgentType.INTERNAL, AgentType.SUBAGENT]),
  tier: z.enum([
    AgentTier.SEED,
    AgentTier.SPROUT,
    AgentTier.BLOOM,
    AgentTier.CROWN,
  ]),
  description: z.string(),
  system_prompt: z.string(),
  allowed_tools: z.array(z.string()),
  allowed_skills: z.array(z.string()),
  reasoning_effort: z.union([z.string(), z.number()]).optional(),
  scope: definitionScopeSchema,
  path: z.string(),
  overriddenByProject: z.boolean(),
}).strict();

/** `ManagedPersonality` (shared/types/definitions.ts). */
const managedPersonalityResultSchema = z.object({
  name: z.string(),
  content: z.string(),
  scope: definitionScopeSchema,
  path: z.string(),
  overriddenByProject: z.boolean(),
}).strict();

/** `ManagedSharedPrompt` (shared/types/definitions.ts). */
const managedSharedPromptResultSchema = z.object({
  slot: z.enum(['all-agents', 'subagents']),
  content: z.string(),
  scope: definitionScopeSchema,
  path: z.string(),
  overriddenByProject: z.boolean(),
}).strict();

/** `DefinitionsListResult` (shared/types/definitions.ts). */
const definitionsListResultSchema = z.object({
  projectDir: z.string().nullable(),
  skills: z.array(managedSkillResultSchema),
  agents: z.array(managedAgentResultSchema),
  personalities: z.array(managedPersonalityResultSchema),
  sharedPrompts: z.array(managedSharedPromptResultSchema),
  availableTools: z.array(z.string()),
  availableSkills: z.array(z.string()),
}).strict();

/** `MCPServerStatus` (shared/types/ipc-boundary.ts). */
const mcpServerStatusResultSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['starting', 'connected', 'failed', 'unavailable']),
  toolCount: z.number().int().nonnegative(),
  tools: z.array(z.string()),
  error: z.string().nullable(),
}).strict();

/** `RAGStatusResponse` (shared/types/ipc-boundary.ts). */
const ragStatusResultSchema = z.object({
  totalChunks: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  lastIndexed: z.string().nullable(),
  lastIndexDuration: z.number().nullable(),
  lastAutoRefresh: z.string().nullable(),
  watcher: z.object({ watching: z.boolean() }).strict().optional(),
}).strict();

/** `RAGIndexResult` (shared/types/ipc-boundary.ts). */
const ragIndexResultSchema = z.object({
  filesScanned: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  filesDeleted: z.number().int().nonnegative(),
  chunksCreated: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  durationSeconds: z.number().nonnegative(),
}).strict();

/** `ASTStoreStatus` (shared/types/ipc-boundary.ts). */
const astStatusResultSchema = z.object({
  totalFiles: z.number().int().nonnegative(),
  totalSymbols: z.number().int().nonnegative(),
  lastIndexed: z.string().nullable(),
  lastIndexDuration: z.number().nullable(),
  lastAutoRefresh: z.string().nullable(),
}).strict();

/** `ASTIndexResult` (shared/types/ipc-boundary.ts). */
const astIndexResultSchema = z.object({
  filesScanned: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  filesDeleted: z.number().int().nonnegative(),
  symbolsExtracted: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  durationSeconds: z.number().nonnegative(),
}).strict();

/** `ProjectConfigReadResult` (shared/types/ipc.ts). */
const projectConfigReadResultSchema = z.object({
  projectDir: z.string().min(1),
  overrides: z.record(z.unknown()),
}).strict();

/** `ProviderModelPricingView` (shared/types/ipc.ts), composing facet schemas. */
const providerModelPricingViewSchema = z.object({
  currency: z.string(),
  currencyUnit: currencyUnitSchema.optional(),
  effectiveAt: z.string(),
  rates: pricingRateFieldsSchema,
  contextTiers: z.array(pricingContextTierSchema).optional(),
}).strict();

/** `ProviderModelView` (shared/types/ipc.ts) — renderer-safe model metadata. */
const providerModelViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  protocol: providerProtocolSchema,
  lifecycle: providerLifecycleSchema.nullable(),
  source: z.enum(['catalog', 'provider', 'user']),
  capabilities: z.object({
    inputModalities: z.array(z.string()),
    outputModalities: z.array(z.string()),
    tools: z.boolean(),
    reasoning: z.boolean(),
  }).nullable(),
  limits: z.object({
    contextTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
  }).nullable(),
  pricing: providerModelPricingViewSchema.optional(),
}).strict();

/** `ProviderDefinitionView` (shared/types/ipc.ts) — one catalog preset. */
const providerDefinitionViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  supportedAuthMethods: z.array(providerAuthMethodSchema),
  supportedProtocols: z.array(providerProtocolSchema),
  allowsCustomModels: z.boolean(),
  lifecycle: providerLifecycleSchema.nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  supportsDiscovery: z.boolean(),
  supportsQuota: z.boolean(),
  models: z.array(providerModelViewSchema),
}).strict();

/** `ProviderConnectionView` (shared/types/ipc.ts) — redacted connection view. */
const providerConnectionViewSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string(),
  providerDisplayName: z.string().nullable(),
  name: z.string(),
  protocol: providerProtocolSchema,
  authMethod: providerAuthMethodSchema,
  credentialKind: z.enum(['stored', 'environment', 'none']),
  environmentVariable: z.string().nullable(),
  modelIds: z.array(z.string()),
  customModels: z.array(providerModelViewSchema),
  health: connectionHealthSchema,
  activeTurnCount: z.number().int().nonnegative(),
  endpoint: z.string().nullable(),
  allowInsecureHttp: z.boolean(),
  reasoningConfig: z.record(z.string(), reasoningModelConfigSchema).optional(),
  pricingOverrides: z.record(z.string(), pricingRateFieldsSchema).optional(),
  tierSelections: z.record(z.string(), z.string()).optional(),
  cacheTtlOptions: z.array(cacheTtlOptionSchema).optional(),
  cacheTtl: z.string().nullable().optional(),
}).strict();

/** `ProviderStatusView` (shared/types/ipc.ts) — timestamped redacted status. */
const providerStatusViewSchema = z.object({
  providerId: z.string().min(1),
  connectionId: z.string().optional(),
  observedAt: z.string(),
  providerUpdatedAt: z.string().nullable(),
  availability: z.enum(['available', 'unavailable', 'unknown']),
  stale: z.boolean(),
  data: z.record(z.unknown()),
  quota: providerQuotaSchema.nullable().optional(),
  error: z.object({
    kind: z.enum(['network', 'unauthorized', 'rate-limited', 'schema', 'unknown']),
    message: z.string(),
    statusCode: z.number().optional(),
    retryAfterAt: z.string().optional(),
  }).nullable(),
}).strict();

/** `ProviderOverview` (shared/types/ipc.ts) — providers:list result. */
const providerOverviewResultSchema = z.object({
  definitions: z.array(providerDefinitionViewSchema),
  connections: z.array(providerConnectionViewSchema),
  statuses: z.array(providerStatusViewSchema),
  secureStorage: z.object({
    available: z.boolean(),
    backend: z.string().nullable(),
    reason: z.enum(['unavailable', 'basic_text', 'error']).nullable(),
  }).strict(),
}).strict();

/** `ProviderMutationResult` (shared/types/ipc.ts). */
const providerMutationResultSchema = z.object({
  connection: providerConnectionViewSchema,
  message: z.string().nullable(),
}).strict();

/** `ProviderModelOption` (shared/types/ipc.ts). */
const providerModelOptionResultSchema = z.object({
  selection: modelSelectionSchema,
  connectionName: z.string(),
  providerId: z.string(),
  providerDisplayName: z.string().nullable(),
  model: providerModelViewSchema,
  enabled: z.boolean(),
  customized: z.boolean(),
  discoveredAt: z.string().nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  embeddingSupported: z.boolean().optional(),
  pricingOverrides: pricingRateFieldsSchema.optional(),
  tierOptions: z.object({
    mechanism: z.enum(['request-parameter', 'model-name-variants']),
    tiers: z.array(serviceTierOptionViewSchema),
    selected: z.string().nullable(),
  }).optional(),
}).strict();

/** `ProviderDiscoverModelsResult` (shared/types/ipc.ts). */
const providerDiscoverModelsResultSchema = z.object({
  connection: providerConnectionViewSchema,
  status: z.enum(['ok', 'unsupported', 'no-credential', 'failed']),
  discoveredModelCount: z.number().int().nonnegative(),
  addedModelIds: z.array(z.string()),
  message: z.string().nullable(),
}).strict();

/** `ProviderDeleteConnectionResult` (shared/types/ipc.ts); config reuses configSchema. */
const providerDeleteConnectionResultSchema = z.object({
  connectionId: z.string().uuid(),
  message: z.string(),
  config: configSchema,
  clearedConfigReferences: z.object({
    defaultModel: z.boolean(),
    tierModels: z.array(z.string()),
    ragEmbeddingModel: z.boolean(),
  }).strict(),
}).strict();

// ── Method registry ───────────────────────────────────────────────────────────

/** One method registry entry: the params and result schemas for a method. */
export interface HostMethodSpec {
  readonly params: z.ZodTypeAny;
  readonly result: z.ZodTypeAny;
}

/**
 * Every host-routed method, keyed by its stable wire name (IPC channel with
 * ':' replaced by '.'). Local-only families (machines/analytics/updater/
 * startup) and v1-local provider vault writes (create/update/submit_api_key/
 * discover_draft_models) are absent by construction.
 */
export const HOST_METHODS = {
  'host.hello': { params: hostHelloParamsSchema, result: hostHelloResultSchema },
  /**
   * Reconnect resync (U10): every pending approval/question, owner-stripped to
   * the live event payloads. Host-internal (no IPC channel counterpart).
   */
  'host.pending_state': {
    params: hostPendingStateParamsSchema,
    result: hostPendingStateResultSchema,
  },

  'chat.send': { params: chatSendSchema, result: chatSendResultSchema },
  'chat.cancel': { params: chatCancelSchema, result: configSaveResultSchema },
  'chat.queue_next': { params: chatQueueNextSchema, result: voidResult },
  'chat.stop': { params: chatStopSchema, result: configSaveResultSchema },
  'chat.snapshot': { params: chatSnapshotSchema, result: chatSessionSnapshotSchema },
  'chat.compact': { params: chatCompactSchema, result: chatCompactResultSchema },

  'subagents.snapshot': { params: subagentSnapshotParamsSchema, result: subagentSnapshotResultSchema },
  'subagents.detail': { params: subagentDetailParamsSchema, result: subagentDetailResultSchema },

  'session.list': { params: noParams, result: z.array(sessionSummaryResultSchema) },
  'session.load': { params: sessionLoadSchema, result: sessionResultSchema.nullable() },
  'session.open': { params: sessionOpenSchema, result: sessionOpenResultSchema },
  'session.history_page': { params: sessionHistoryPageSchema, result: sessionHistoryPageResultSchema },
  'session.create': { params: noParams, result: sessionResultSchema },
  'session.clear_active': { params: noParams, result: configSaveResultSchema },
  'session.delete': { params: sessionDeleteSchema, result: sessionDeleteResultSchema },
  'session.rename': { params: sessionRenameSchema, result: configSaveResultSchema },
  'session.change_model': { params: sessionChangeModelSchema, result: configSaveResultSchema },
  'session.get_workspace': { params: noParams, result: workspaceInfoSchema },
  'session.set_workspace': { params: sessionSetWorkspaceSchema, result: workspaceInfoSchema },
  /** Native host dialog; gated by the 'session.pick_project_dir' capability. */
  'session.pick_project_dir': { params: noParams, result: workspaceInfoSchema },
  'session.change_cwd': { params: sessionChangeCwdSchema, result: sessionResultSchema.nullable() },
  'session.set_reasoning_effort': { params: sessionSetReasoningEffortSchema, result: configSaveResultSchema },
  'session.set_service_tier': { params: sessionSetServiceTierSchema, result: configSaveResultSchema },

  'session.working_set_get': { params: noParams, result: workingSetSnapshotSchema },
  'session.working_set_open_or_focus': { params: workingSetIdParamsSchema, result: workingSetSnapshotSchema },
  'session.working_set_close': { params: workingSetIdParamsSchema, result: workingSetSnapshotSchema },
  'session.working_set_remove': { params: workingSetIdParamsSchema, result: workingSetSnapshotSchema },
  'session.working_set_set_focus': { params: workingSetSetFocusParamsSchema, result: workingSetSnapshotSchema },

  'session.activity_list': { params: noParams, result: z.array(sessionActivityResultSchema) },
  'session.activity_mark_seen': { params: sessionMarkSeenParamsSchema, result: sessionActivityResultSchema.nullable() },

  'bgcmd.snapshot': { params: bgCommandSnapshotRequestSchema, result: bgCommandSnapshotResultSchema },
  'bgcmd.list': { params: bgCommandListParamsSchema, result: bgCommandListResultSchema },
  'bgcmd.send_input': { params: bgCommandSendInputParamsSchema, result: bgCommandSendInputResultSchema },
  'bgcmd.terminate': { params: bgCommandControlParamsSchema, result: bgCommandTerminateResultSchema },
  'bgcmd.release_input': { params: bgCommandControlParamsSchema, result: bgCommandReleaseInputResultSchema },

  'ask_question.snapshot': { params: noParams, result: askQuestionSnapshotResultSchema },
  'ask_question.answer': { params: askQuestionAnswerSchema, result: okResultSchema },
  'ask_question.cancel': { params: askQuestionCancelSchema, result: okResultSchema },

  'permission.snapshot': { params: noParams, result: permissionSnapshotResultSchema },
  'permission.approval_answer': { params: permissionApprovalAnswerParamsSchema, result: okResultSchema },
  'permission.set_session_mode': {
    params: permissionSetSessionModeParamsSchema,
    result: permissionSessionModeMutationResultSchema,
  },
  'permission.get_session_mode': {
    params: permissionGetSessionModeParamsSchema,
    result: permissionSessionModeResultSchema,
  },

  'project.trust_get': { params: projectTrustGetSchema, result: projectTrustInfoSchema },
  'project.trust_set': { params: projectTrustSetSchema, result: projectTrustInfoSchema },
  'project.trust_list': { params: noParams, result: z.array(trustedProjectEntrySchema) },

  'definitions.list': { params: noParams, result: definitionsListResultSchema },
  'agent.save': { params: agentSaveParamsSchema, result: managedAgentResultSchema },
  'agent.delete': { params: definitionDeleteParamsSchema, result: configSaveResultSchema },
  'skill.save': { params: skillSaveParamsSchema, result: managedSkillResultSchema },
  'skill.delete': { params: definitionDeleteParamsSchema, result: configSaveResultSchema },
  'personality.save': { params: personalitySaveParamsSchema, result: managedPersonalityResultSchema },
  'personality.delete': { params: definitionDeleteParamsSchema, result: configSaveResultSchema },
  'shared_prompt.save': { params: sharedPromptSaveParamsSchema, result: managedSharedPromptResultSchema },
  'shared_prompt.delete': { params: sharedPromptDeleteParamsSchema, result: configSaveResultSchema },
  /** Host-local file reveal; gated by the 'definitions.reveal' capability. */
  'definition.reveal': { params: definitionRevealParamsSchema, result: configSaveResultSchema },

  'mcp.status': { params: noParams, result: z.array(mcpServerStatusResultSchema) },

  'rag.status': { params: noParams, result: ragStatusResultSchema },
  'rag.index': { params: ragIndexSchema, result: ragIndexResultSchema },
  'rag.clear': { params: noParams, result: configSaveResultSchema },

  'ast.status': { params: noParams, result: astStatusResultSchema },
  'ast.index': { params: astIndexSchema, result: astIndexResultSchema },

  'tool.execute': { params: toolExecuteSchema, result: toolExecuteResultSchema },

  'config.get': { params: noParams, result: configSchema },
  'config.save': { params: configSaveSchema, result: configSaveResultSchema },
  'config.get_home': { params: noParams, result: configSchema },
  'config.read_project': { params: configReadProjectSchema, result: projectConfigReadResultSchema },
  'config.save_project': { params: configSaveProjectSchema, result: voidResult },

  'providers.list': { params: noParams, result: providerOverviewResultSchema },
  'providers.validate': { params: providerConnectionIdParamsSchema, result: providerMutationResultSchema },
  'providers.disable': { params: providerConnectionIdParamsSchema, result: providerMutationResultSchema },
  'providers.enable': { params: providerConnectionIdParamsSchema, result: providerMutationResultSchema },
  'providers.disconnect': { params: providerDisconnectParamsSchema, result: providerMutationResultSchema },
  'providers.delete': { params: providerDisconnectParamsSchema, result: providerDeleteConnectionResultSchema },
  'providers.model_list': {
    params: providerModelListParamsSchema,
    result: z.array(providerModelOptionResultSchema),
  },
  'providers.discover_models': {
    params: providerConnectionIdParamsSchema,
    result: providerDiscoverModelsResultSchema,
  },
  'providers.status_refresh': { params: providerStatusRefreshParamsSchema, result: providerStatusViewSchema.nullable() },
  'providers.quota_refresh': { params: providerConnectionIdParamsSchema, result: providerStatusViewSchema.nullable() },
} as const satisfies Record<string, HostMethodSpec>;

export type HostMethodName = keyof typeof HOST_METHODS;

/** Params type for one method, inferred from its registry schema. */
export type HostMethodParams<M extends HostMethodName> = z.infer<(typeof HOST_METHODS)[M]['params']>;

/** Result type for one method, inferred from its registry schema. */
export type HostMethodResult<M extends HostMethodName> = z.infer<(typeof HOST_METHODS)[M]['result']>;

/**
 * Registry lookup for a wire method name. `undefined` means the name is not a
 * host method — callers must answer METHOD_NOT_FOUND (or, for a known
 * local-only family, keep the request client-side).
 */
export function lookupHostMethod(method: string): HostMethodSpec | undefined {
  return Object.hasOwn(HOST_METHODS, method)
    ? (HOST_METHODS as Record<string, HostMethodSpec>)[method]
    : undefined;
}

// ── Event registry ────────────────────────────────────────────────────────────

/** `session:subagents_changed` carries no payload (reload signal). */
const voidEventSchema = z.void();

/**
 * Every host-push event, keyed exactly by its IPC channel name so the IPC→
 * protocol mapping is mechanical. Client-local pushes (machines:changed,
 * startup:changed, updater:*) never cross the wire and are absent.
 */
export const HOST_EVENTS = {
  'chat:chunk': chatChunkEventSchema,
  'chat:thinking': chatThinkingEventSchema,
  'chat:state': chatStateEventSchema,
  'chat:done': chatDoneEventSchema,
  'chat:error': chatErrorEventSchema,
  'chat:usage': chatUsageEventSchema,
  'chat:tool_call_start': chatToolCallStartEventSchema,
  'chat:tool_call_delta': chatToolCallDeltaEventSchema,
  'chat:tool_call_update': chatToolCallUpdateEventSchema,
  'chat:compaction_progress': compactionProgressEventSchema,

  'subagents:event': subagentEventSchema,

  'session:deleted': sessionDeletedEventSchema,
  'session:renamed': sessionRenamedEventSchema,
  'session:created': sessionCreatedEventSchema,
  'session:updated': sessionUpdatedEventSchema,
  'session:compaction': sessionCompactionEventSchema,
  'session:workspace_changed': sessionWorkspaceChangedEventSchema,
  'session:subagents_changed': voidEventSchema,
  'session:todos_changed': sessionTodosChangedEventSchema,
  'session:activity_changed': sessionActivityChangedEventSchema,
  'session:working_set_changed': workingSetChangedEventSchema,

  'project:trust_changed': projectTrustChangedEventSchema,

  'bgcmd:changed': bgCommandChangedEventSchema,

  'ask_question:asked': askQuestionAskedEventSchema,
  'ask_question:settled': askQuestionSettledEventSchema,

  'permission:approval_requested': permissionApprovalRequestedEventSchema,
  'permission:approval_settled': permissionApprovalSettledEventSchema,

  'rag:progress': ragIndexProgressSchema,
  'ast:progress': astIndexProgressSchema,
  'index:auto_refresh': indexAutoRefreshEventSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type HostEventName = keyof typeof HOST_EVENTS;

/** Payload type for one event, inferred from its registry schema. */
export type HostEventParams<Ev extends HostEventName> = z.infer<(typeof HOST_EVENTS)[Ev]>;

/**
 * Registry lookup for a wire event name. `undefined` means the name is not a
 * host event — the client drops it rather than dispatching blindly.
 */
export function lookupHostEvent(ev: string): z.ZodTypeAny | undefined {
  return Object.hasOwn(HOST_EVENTS, ev)
    ? (HOST_EVENTS as Record<string, z.ZodTypeAny>)[ev]
    : undefined;
}
