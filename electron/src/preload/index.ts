/**
 * Preload script — typed API bridge between main and renderer.
 *
 * Exposes `window.orchid` via contextBridge with strict channel allowlists.
 * Each method is an ipcRenderer.invoke wrapper; event listeners use ipcRenderer.on.
 *
 * Security:
 * - contextIsolation: true (enforced in BrowserWindow)
 * - nodeIntegration: false (enforced in BrowserWindow)
 * - Only allowed channels can be invoked/subscribed
 * - Event payloads and critical invoke results are Zod-validated at this boundary
 */
import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
  IPC_CHANNELS,
} from '../shared/types/ipc';
import type {
  OrchidAPI,
  ChatSendMessage,
  ChatCancelMessage,
  ChatQueueNextRequest,
  ChatStopMessage,
  ChatSnapshotMessage,
  ChatChunkEvent,
  ChatThinkingEvent,
  ChatStateEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatUsageEvent,
  ChatToolCallStartEvent,
  ChatToolCallDeltaEvent,
  ChatToolCallUpdateEvent,
  ConfigSaveMessage,
  ProjectConfigSaveMessage,
  PermissionConfigScopeSaveMessage,
  PermissionConfigScopes,
  ProviderConnectionCreateMessage,
  ProviderConnectionUpdateMessage,
  ProviderSubmitApiKeyMessage,
  ProviderConnectionIdMessage,
  ProviderDisconnectMessage,
  ProviderDeleteConnectionMessage,
  ProviderStatusRefreshMessage,
  SessionLoadMessage,
  SessionOpenMessage,
  SessionOpenResult,
  SessionDeleteMessage,
  SessionRenamedEvent,
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SessionChangeCwdMessage,
  SessionSetWorkspaceMessage,
  SessionSetReasoningEffortMessage,
  SessionReasoningConfigResult,
  SessionWorkspaceChangedEvent,
  SessionTodosChangedEvent,
  SessionActivityChangedEvent,
  SessionMarkSeenMessage,
  WorkingSetIdMessage,
  WorkingSetSetFocusMessage,
  WorkingSetChangedEvent,
  WorkspaceInfo,
  ToolExecuteMessage,
  AgentSaveMessage,
  DefinitionDeleteMessage,
  DefinitionRevealMessage,
  PersonalitySaveMessage,
  SkillSaveMessage,
  RAGIndexMessage,
  RAGIndexProgress,
  ASTIndexMessage,
  ASTIndexProgress,
  BgCommandSnapshotRequest,
  SubagentSnapshotRequest,
  SubagentSnapshot,
  SubagentEvent,
  AskQuestionAnswerMessage,
  AskQuestionCancelMessage,
  AskQuestionAskedEvent,
  AskQuestionSettledEvent,
  AskQuestionResult,
  AskQuestionSnapshot,
  PermissionApprovalAnswerMessage,
  PermissionGetSessionModeMessage,
  PermissionSetSessionModeMessage,
  PermissionApprovalRequestedEvent,
  PermissionApprovalSettledEvent,
  PermissionApprovalSnapshot,
  PermissionResult,
  PermissionSessionModeMutationResult,
  PermissionSessionModeResult,
  StartupSnapshot,
  StartupContinueDegradedResult,
} from '../shared/types/ipc';
import {
  chatChunkEventSchema,
  chatThinkingEventSchema,
  chatStateEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
  chatUsageEventSchema,
  chatToolCallStartEventSchema,
  chatToolCallDeltaEventSchema,
  chatToolCallUpdateEventSchema,
  sessionRenamedEventSchema,
  sessionCreatedEventSchema,
  sessionWorkspaceChangedEventSchema,
  sessionTodosChangedEventSchema,
  sessionActivityChangedEventSchema,
  workingSetChangedEventSchema,
  ragIndexProgressSchema,
  astIndexProgressSchema,
  chatSendResultSchema,
  toolExecuteResultSchema,
  bgCommandSnapshotResultSchema,
  configSaveResultSchema,
  workspaceInfoSchema,
  sessionReasoningConfigResultSchema,
  chatSessionSnapshotSchema,
  subagentSnapshotSchema,
  subagentEventSchema,
  subagentDeltaEventSchema,
  startupSnapshotSchema,
  startupContinueDegradedResultSchema,
} from '../shared/types/ipc-schemas';

// ── Security helpers ─────────────────────────────────────────────────────────

function assertAllowedInvoke(channel: string): void {
  if (!(ALLOWED_INVOKE_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`IPC channel '${channel}' is not allowed for invoke`);
  }
}

function assertAllowedEvent(channel: string): void {
  if (!(ALLOWED_EVENT_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`IPC channel '${channel}' is not allowed for events`);
  }
}

// ── Typed invoke wrapper ─────────────────────────────────────────────────────

/**
 * High-risk invoke channels validated on resolve. Residual: most other
 * channels still rely on TypeScript casts only (see M-P1-016 residual).
 */
const INVOKE_RESULT_SCHEMAS: Partial<Record<string, z.ZodTypeAny>> = {
  [IPC_CHANNELS.STARTUP_SNAPSHOT]: startupSnapshotSchema,
  [IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED]: startupContinueDegradedResultSchema,
  [IPC_CHANNELS.CHAT_SEND]: chatSendResultSchema,
  [IPC_CHANNELS.CHAT_SNAPSHOT]: chatSessionSnapshotSchema,
  [IPC_CHANNELS.SUBAGENTS_SNAPSHOT]: subagentSnapshotSchema,
  [IPC_CHANNELS.TOOL_EXECUTE]: toolExecuteResultSchema,
  [IPC_CHANNELS.BG_CMD_SNAPSHOT]: bgCommandSnapshotResultSchema,
  [IPC_CHANNELS.CONFIG_SAVE]: configSaveResultSchema,
  [IPC_CHANNELS.SESSION_GET_WORKSPACE]: workspaceInfoSchema,
  [IPC_CHANNELS.SESSION_PICK_PROJECT_DIR]: workspaceInfoSchema,
  [IPC_CHANNELS.SESSION_SET_WORKSPACE]: workspaceInfoSchema,
  [IPC_CHANNELS.SESSION_GET_REASONING_CONFIG]: sessionReasoningConfigResultSchema,
};

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  assertAllowedInvoke(channel);
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  const schema = INVOKE_RESULT_SCHEMAS[channel];
  if (!schema) {
    return result as T;
  }
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Invalid IPC response for '${channel}': ${parsed.error.message}`);
  }
  return parsed.data as T;
}

// ── Typed event listener wrapper ─────────────────────────────────────────────

function on(channel: string, callback: (...args: unknown[]) => void): () => void {
  assertAllowedEvent(channel);
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
    callback(...args);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/**
 * Subscribe to an event channel and drop payloads that fail schema validation.
 * Prevents unchecked `as Event` casts from delivering malformed main→renderer data.
 * Schema shape may be a structural subset of T (e.g. session identity only).
 */
function onParsed<T>(
  channel: string,
  schema: z.ZodTypeAny,
  callback: (payload: T) => void,
): () => void {
  return on(channel, (...args) => {
    const parsed = schema.safeParse(args[0]);
    if (!parsed.success) {
      console.warn(
        `[orchid preload] dropped invalid event on '${channel}':`,
        parsed.error.message,
      );
      return;
    }
    callback(parsed.data as T);
  });
}

/**
 * SUBAGENTS_EVENT shell: the batch envelope without member payloads, derived
 * from `subagentEventSchema` so envelope fields can never drift apart. Members
 * are validated individually by `onSubagentEvent`.
 */
const subagentEventShellSchema = subagentEventSchema.extend({
  events: z.array(z.unknown()),
});

/** Identify a dropped delta for the warning log without trusting its shape. */
function describeSubagentDelta(member: unknown, index: number): string {
  if (typeof member !== 'object' || member === null) return `index ${index}`;
  const { type, subagentId } = member as { type?: unknown; subagentId?: unknown };
  const label = typeof type === 'string' ? type : `index ${index}`;
  return typeof subagentId === 'string' ? `${label} (subagent ${subagentId})` : label;
}

/**
 * SUBAGENTS_EVENT subscription with member-level validation. Deltas have no
 * retry path: one malformed member must not drop co-batched handoffs for other
 * subagents (a lost terminal leaves the renderer stuck running), so the valid
 * subset is still delivered and each drop is logged with its type/id. A
 * malformed shell (e.g. missing sessionId) drops the whole batch as before.
 */
function onSubagentEvent(callback: (event: SubagentEvent) => void): () => void {
  return on(IPC_CHANNELS.SUBAGENTS_EVENT, (...args) => {
    const shell = subagentEventShellSchema.safeParse(args[0]);
    if (!shell.success) {
      console.warn(
        `[orchid preload] dropped invalid event on '${IPC_CHANNELS.SUBAGENTS_EVENT}':`,
        shell.error.message,
      );
      return;
    }
    const events: SubagentEvent['events'] = [];
    const dropped: string[] = [];
    shell.data.events.forEach((member, index) => {
      const parsed = subagentDeltaEventSchema.safeParse(member);
      if (parsed.success) {
        events.push(parsed.data as SubagentEvent['events'][number]);
      } else {
        dropped.push(describeSubagentDelta(member, index));
      }
    });
    if (dropped.length > 0) {
      console.warn(
        `[orchid preload] dropped ${dropped.length} malformed subagent event(s) ` +
        `on '${IPC_CHANNELS.SUBAGENTS_EVENT}': ${dropped.join(', ')}`,
      );
    }
    callback({ sessionId: shell.data.sessionId, events });
  });
}

// ── Build the API surface ────────────────────────────────────────────────────

const orchidAPI: OrchidAPI = {
  startup: {
    snapshot: () => invoke<StartupSnapshot>(IPC_CHANNELS.STARTUP_SNAPSHOT),
    continueDegraded: () =>
      invoke<StartupContinueDegradedResult>(IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED),
    onChanged: (callback: (snapshot: StartupSnapshot) => void) =>
      onParsed(IPC_CHANNELS.STARTUP_CHANGED, startupSnapshotSchema, callback),
  },

  chat: {
    send: (message: ChatSendMessage) =>
      invoke(IPC_CHANNELS.CHAT_SEND, message),

    cancel: (message?: ChatCancelMessage) =>
      invoke(IPC_CHANNELS.CHAT_CANCEL, message ?? {}),

    queueNext: (request: ChatQueueNextRequest) =>
      invoke(IPC_CHANNELS.CHAT_QUEUE_NEXT, request),

    stop: (message: ChatStopMessage) =>
      invoke(IPC_CHANNELS.CHAT_STOP, message),

    snapshot: (message?: ChatSnapshotMessage) =>
      invoke(IPC_CHANNELS.CHAT_SNAPSHOT, message ?? {}),

    onChunk: (callback: (event: ChatChunkEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_CHUNK, chatChunkEventSchema, callback),

    onThinking: (callback: (event: ChatThinkingEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_THINKING, chatThinkingEventSchema, callback),

    onState: (callback: (event: ChatStateEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_STATE, chatStateEventSchema, callback),

    onDone: (callback: (event: ChatDoneEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_DONE, chatDoneEventSchema, callback),

    onError: (callback: (event: ChatErrorEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_ERROR, chatErrorEventSchema, callback),

    onUsage: (callback: (event: ChatUsageEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_USAGE, chatUsageEventSchema, callback),

    onToolCallStart: (callback: (event: ChatToolCallStartEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_TOOL_CALL_START, chatToolCallStartEventSchema, callback),

    onToolCallDelta: (callback: (event: ChatToolCallDeltaEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_TOOL_CALL_DELTA, chatToolCallDeltaEventSchema, callback),

    onToolCallUpdate: (callback: (event: ChatToolCallUpdateEvent) => void) =>
      onParsed(IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, chatToolCallUpdateEventSchema, callback),
  },

  config: {
    get: () =>
      invoke(IPC_CHANNELS.CONFIG_GET),

    save: (updates: ConfigSaveMessage) =>
      invoke(IPC_CHANNELS.CONFIG_SAVE, updates),

    permissionScopes: () =>
      invoke<PermissionConfigScopes>(IPC_CHANNELS.CONFIG_PERMISSION_SCOPES),

    savePermissionScope: (message: PermissionConfigScopeSaveMessage) =>
      invoke(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE, message),

    listPersonalities: () =>
      invoke(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES),

    readProject: (projectDir: string) =>
      invoke(IPC_CHANNELS.CONFIG_READ_PROJECT, projectDir),

    saveProject: (message: ProjectConfigSaveMessage) =>
      invoke(IPC_CHANNELS.CONFIG_SAVE_PROJECT, message),

    getHome: () =>
      invoke(IPC_CHANNELS.CONFIG_GET_HOME),
  },

  providers: {
    list: () =>
      invoke(IPC_CHANNELS.PROVIDERS_LIST),

    create: (message: ProviderConnectionCreateMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_CREATE, message),

    update: (message: ProviderConnectionUpdateMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_UPDATE, message),

    submitApiKey: (message: ProviderSubmitApiKeyMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY, message),

    validate: (message: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_VALIDATE, message),

    disable: (message: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_DISABLE, message),

    enable: (message: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_ENABLE, message),

    disconnect: (message: ProviderDisconnectMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_DISCONNECT, message),

    deleteConnection: (message: ProviderDeleteConnectionMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_DELETE, message),

    modelList: (message?: ProviderConnectionIdMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_MODEL_LIST, message),

    refreshStatus: (message: ProviderStatusRefreshMessage) =>
      invoke(IPC_CHANNELS.PROVIDERS_STATUS_REFRESH, message),
  },

  session: {
    list: () =>
      invoke(IPC_CHANNELS.SESSION_LIST),

    load: (id: SessionLoadMessage) =>
      invoke(IPC_CHANNELS.SESSION_LOAD, id),

    open: (message: SessionOpenMessage) =>
      invoke<SessionOpenResult>(IPC_CHANNELS.SESSION_OPEN, message),

    create: () =>
      invoke(IPC_CHANNELS.SESSION_CREATE),

    clearActive: () =>
      invoke(IPC_CHANNELS.SESSION_CLEAR_ACTIVE),

    delete: (id: SessionDeleteMessage) =>
      invoke(IPC_CHANNELS.SESSION_DELETE, id),

    rename: (id: string, name: string) =>
      invoke(IPC_CHANNELS.SESSION_RENAME, { id, name }),

    changeModel: (id, selection, modelLabel) =>
      invoke(IPC_CHANNELS.SESSION_CHANGE_MODEL, { id, selection, modelLabel }),

    getWorkspace: () =>
      invoke<WorkspaceInfo>(IPC_CHANNELS.SESSION_GET_WORKSPACE),

    pickProjectDir: () =>
      invoke<WorkspaceInfo>(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR),

    setWorkspace: (message: SessionSetWorkspaceMessage) =>
      invoke<WorkspaceInfo>(IPC_CHANNELS.SESSION_SET_WORKSPACE, message),

    changeCwd: (message: SessionChangeCwdMessage) =>
      invoke(IPC_CHANNELS.SESSION_CHANGE_CWD, message),

    setReasoningEffort: (message: SessionSetReasoningEffortMessage) =>
      invoke(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT, message),

    getReasoningConfig: () =>
      invoke<SessionReasoningConfigResult>(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG),

    listActivity: () =>
      invoke(IPC_CHANNELS.SESSION_ACTIVITY_LIST),

    markSeen: (message: SessionMarkSeenMessage) =>
      invoke(IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN, message),

    getWorkingSet: () =>
      invoke(IPC_CHANNELS.SESSION_WORKING_SET_GET),

    openOrFocusTab: (message: WorkingSetIdMessage) =>
      invoke(IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS, message),

    closeTab: (message: WorkingSetIdMessage) =>
      invoke(IPC_CHANNELS.SESSION_WORKING_SET_CLOSE, message),

    removeTab: (message: WorkingSetIdMessage) =>
      invoke(IPC_CHANNELS.SESSION_WORKING_SET_REMOVE, message),

    setTabFocus: (message: WorkingSetSetFocusMessage) =>
      invoke(IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS, message),

    onWorkingSetChanged: (callback: (event: WorkingSetChangedEvent) => void) =>
      onParsed(IPC_CHANNELS.SESSION_WORKING_SET_CHANGED, workingSetChangedEventSchema, callback),

    onRenamed: (callback: (event: SessionRenamedEvent) => void) =>
      onParsed(IPC_CHANNELS.SESSION_RENAMED, sessionRenamedEventSchema, callback),

    onCreated: (callback: (event: SessionCreatedEvent) => void) =>
      onParsed(IPC_CHANNELS.SESSION_CREATED, sessionCreatedEventSchema, callback),

    onUpdated: (callback: (event: SessionUpdatedEvent) => void) =>
      onParsed(IPC_CHANNELS.SESSION_UPDATED, sessionCreatedEventSchema, callback),

    onWorkspaceChanged: (callback: (event: SessionWorkspaceChangedEvent) => void) =>
      onParsed(IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, sessionWorkspaceChangedEventSchema, callback),

    onSubagentsChanged: (callback: () => void) =>
      on(IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED, () => callback()),

    onTodosChanged: (callback: (event: SessionTodosChangedEvent) => void) =>
      onParsed(IPC_CHANNELS.SESSION_TODOS_CHANGED, sessionTodosChangedEventSchema, callback),

    onActivityChanged: (callback: (event: SessionActivityChangedEvent) => void) =>
      onParsed(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED, sessionActivityChangedEventSchema, callback),
  },

  subagents: {
    snapshot: (request: SubagentSnapshotRequest) =>
      invoke<SubagentSnapshot>(IPC_CHANNELS.SUBAGENTS_SNAPSHOT, request),
    onEvent: (callback: (event: SubagentEvent) => void) =>
      onSubagentEvent(callback),
  },

  tool: {
    execute: (message: ToolExecuteMessage) =>
      invoke(IPC_CHANNELS.TOOL_EXECUTE, message),
  },

  agent: {
    save: (message: AgentSaveMessage) =>
      invoke(IPC_CHANNELS.AGENT_SAVE, message),

    delete: (message: DefinitionDeleteMessage) =>
      invoke(IPC_CHANNELS.AGENT_DELETE, message),
  },

  definitions: {
    list: () =>
      invoke(IPC_CHANNELS.DEFINITIONS_LIST),

    reveal: (message: DefinitionRevealMessage) =>
      invoke(IPC_CHANNELS.DEFINITION_REVEAL, message),
  },

  skill: {
    save: (message: SkillSaveMessage) =>
      invoke(IPC_CHANNELS.SKILL_SAVE, message),

    delete: (message: DefinitionDeleteMessage) =>
      invoke(IPC_CHANNELS.SKILL_DELETE, message),
  },

  personality: {
    save: (message: PersonalitySaveMessage) =>
      invoke(IPC_CHANNELS.PERSONALITY_SAVE, message),

    delete: (message: DefinitionDeleteMessage) =>
      invoke(IPC_CHANNELS.PERSONALITY_DELETE, message),
  },

  mcp: {
    status: () =>
      invoke(IPC_CHANNELS.MCP_STATUS),
  },

  rag: {
    status: () =>
      invoke(IPC_CHANNELS.RAG_STATUS),

    index: (message?: RAGIndexMessage) =>
      invoke(IPC_CHANNELS.RAG_INDEX, message),

    clear: () =>
      invoke(IPC_CHANNELS.RAG_CLEAR),

    indexState: () =>
      invoke(IPC_CHANNELS.RAG_INDEX_STATE),

    onProgress: (callback: (progress: RAGIndexProgress) => void) =>
      onParsed(IPC_CHANNELS.RAG_PROGRESS, ragIndexProgressSchema, callback),
  },

  ast: {
    status: () =>
      invoke(IPC_CHANNELS.AST_STATUS),

    index: (message?: ASTIndexMessage) =>
      invoke(IPC_CHANNELS.AST_INDEX, message),

    indexState: () =>
      invoke(IPC_CHANNELS.AST_INDEX_STATE),

    onProgress: (callback: (progress: ASTIndexProgress) => void) =>
      onParsed(IPC_CHANNELS.AST_PROGRESS, astIndexProgressSchema, callback),
  },

  bgCmd: {
    snapshot: (request: BgCommandSnapshotRequest) =>
      invoke(IPC_CHANNELS.BG_CMD_SNAPSHOT, request),
  },

  askQuestion: {
    snapshot: () =>
      invoke<AskQuestionSnapshot>(IPC_CHANNELS.ASK_QUESTION_SNAPSHOT),

    answer: (payload: AskQuestionAnswerMessage) =>
      invoke<AskQuestionResult>(IPC_CHANNELS.ASK_QUESTION_ANSWER, payload),

    cancel: (payload: AskQuestionCancelMessage) =>
      invoke<AskQuestionResult>(IPC_CHANNELS.ASK_QUESTION_CANCEL, payload),

    onAsked: (callback: (event: AskQuestionAskedEvent) => void) =>
      on(IPC_CHANNELS.ASK_QUESTION_ASKED, (...args) => callback(args[0] as AskQuestionAskedEvent)),

    onSettled: (callback: (event: AskQuestionSettledEvent) => void) =>
      on(
        IPC_CHANNELS.ASK_QUESTION_SETTLED,
        (...args) => callback(args[0] as AskQuestionSettledEvent),
      ),
  },

  permission: {
    snapshot: () =>
      invoke<PermissionApprovalSnapshot>(IPC_CHANNELS.PERMISSION_SNAPSHOT),

    answer: (payload: PermissionApprovalAnswerMessage) =>
      invoke<PermissionResult>(IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER, payload),

    setSessionMode: (payload: PermissionSetSessionModeMessage) =>
      invoke<PermissionSessionModeMutationResult>(IPC_CHANNELS.PERMISSION_SET_SESSION_MODE, payload),

    getSessionMode: (payload: PermissionGetSessionModeMessage) =>
      invoke<PermissionSessionModeResult>(IPC_CHANNELS.PERMISSION_GET_SESSION_MODE, payload),

    onApprovalRequested: (callback: (event: PermissionApprovalRequestedEvent) => void) =>
      on(
        IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED,
        (...args) => callback(args[0] as PermissionApprovalRequestedEvent),
      ),

    onApprovalSettled: (callback: (event: PermissionApprovalSettledEvent) => void) =>
      on(
        IPC_CHANNELS.PERMISSION_APPROVAL_SETTLED,
        (...args) => callback(args[0] as PermissionApprovalSettledEvent),
      ),
  },
};

// ── Expose to renderer ───────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('orchid', orchidAPI);
