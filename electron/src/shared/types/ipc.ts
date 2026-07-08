/**
 * IPC API surface types — shared between main, preload, and renderer.
 *
 * This file defines the typed contract for the contextBridge API.
 * All IPC payloads are validated with zod at the main-process boundary.
 *
 * The renderer accesses this API via `window.orchid.*`.
 */

import type { Session, SessionStorageDict } from './session';
import type { SessionSummary } from '../../main/session/storage';
import type { Config } from '../../main/config/schema';
import type { Agent } from './agent';
import type { MCPServerStatus } from '../../main/mcp/schema';
import type { StoreStatus as RAGStoreStatus } from '../../main/rag/store';
import type { StoreStatus as ASTStoreStatus } from '../../main/ast/store';
import type { IndexResult as RAGIndexResult } from '../../main/rag/indexer';
import type { IndexResult as ASTIndexResult } from '../../main/ast/indexer';
export type { UpdaterState } from '../../main/updater';
import type { UpdaterState } from '../../main/updater';

// ── Chat API ─────────────────────────────────────────────────────────────────

export interface ChatSendMessage {
  /** The user's message text. */
  message: string;
  /** Optional session ID (uses active session if omitted). */
  sessionId?: string;
}

export interface ChatCancelMessage {
  /** Optional session ID (uses active session if omitted). */
  sessionId?: string;
}

export interface ChatChunkEvent {
  type: 'chunk';
  data: string;
}

export interface ChatStateEvent {
  state: string;
  response: string;
  error: string | null;
}

export interface ChatDoneEvent {
  type: 'done';
  response: string;
}

export interface ChatErrorEvent {
  type: 'error';
  error: string;
}

// ── Config API ───────────────────────────────────────────────────────────────

export interface ConfigSaveMessage {
  updates: Partial<Config>;
}

// ── Session API ──────────────────────────────────────────────────────────────

export interface SessionLoadMessage {
  id: string;
}

export interface SessionDeleteMessage {
  id: string;
}

export interface SessionRenameMessage {
  id: string;
  name: string;
}

// ── Tool API ─────────────────────────────────────────────────────────────────

export interface ToolExecuteMessage {
  name: string;
  args: unknown;
}

export interface ToolExecuteResult {
  content: string;
  isError: boolean;
}

// ── Agent API ────────────────────────────────────────────────────────────────

export interface AgentSpawnMessage {
  name: string;
  task: string;
  tier?: string;
}

export interface AgentSpawnResult {
  id: string;
  agent: Agent;
}

// ── RAG API ──────────────────────────────────────────────────────────────────

export interface RAGIndexMessage {
  /** Force re-index everything. */
  force?: boolean;
}

// ── AST API ──────────────────────────────────────────────────────────────────

export interface ASTIndexMessage {
  /** Force re-index everything. */
  force?: boolean;
}

// ── Updater API ──────────────────────────────────────────────────────────────

export interface UpdaterProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface UpdaterErrorEvent {
  error: string;
}

// ── Orchid API (the full contextBridge surface) ──────────────────────────────

export interface OrchidAPI {
  chat: {
    send: (message: ChatSendMessage) => Promise<{ status: string }>;
    cancel: () => Promise<{ status: string }>;
    onChunk: (callback: (event: ChatChunkEvent) => void) => () => void;
    onState: (callback: (event: ChatStateEvent) => void) => () => void;
    onDone: (callback: (event: ChatDoneEvent) => void) => () => void;
    onError: (callback: (event: ChatErrorEvent) => void) => () => void;
  };

  config: {
    get: () => Promise<Config>;
    save: (updates: ConfigSaveMessage) => Promise<{ status: string }>;
  };

  session: {
    list: () => Promise<SessionSummary[]>;
    load: (id: SessionLoadMessage) => Promise<Session | null>;
    create: () => Promise<Session>;
    delete: (id: SessionDeleteMessage) => Promise<{ status: string }>;
    rename: (id: string, name: string) => Promise<{ status: string }>;
  };

  tool: {
    execute: (message: ToolExecuteMessage) => Promise<ToolExecuteResult>;
  };

  agent: {
    list: () => Promise<Agent[]>;
    spawn: (message: AgentSpawnMessage) => Promise<AgentSpawnResult>;
  };

  mcp: {
    status: () => Promise<MCPServerStatus[]>;
  };

  rag: {
    status: () => Promise<RAGStoreStatus>;
    index: (message?: RAGIndexMessage) => Promise<RAGIndexResult>;
    clear: () => Promise<{ status: string }>;
  };

  ast: {
    status: () => Promise<ASTStoreStatus>;
    index: (message?: ASTIndexMessage) => Promise<ASTIndexResult>;
  };

  updater: {
    check: () => Promise<UpdaterState>;
    install: () => Promise<{ status: string }>;
    status: () => Promise<UpdaterState>;
    download: () => Promise<UpdaterState>;
    onStatus: (callback: (state: UpdaterState) => void) => () => void;
    onProgress: (callback: (progress: UpdaterProgress) => void) => () => void;
    onError: (callback: (event: UpdaterErrorEvent) => void) => () => void;
  };
}

// ── IPC Channel names ────────────────────────────────────────────────────────

export const IPC_CHANNELS = {
  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_CHUNK: 'chat:chunk',
  CHAT_STATE: 'chat:state',
  CHAT_DONE: 'chat:done',
  CHAT_ERROR: 'chat:error',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',

  // Session
  SESSION_LIST: 'session:list',
  SESSION_LOAD: 'session:load',
  SESSION_CREATE: 'session:create',
  SESSION_DELETE: 'session:delete',
  SESSION_RENAME: 'session:rename',

  // Tool
  TOOL_EXECUTE: 'tool:execute',

  // Agent
  AGENT_LIST: 'agent:list',
  AGENT_SPAWN: 'agent:spawn',

  // MCP
  MCP_STATUS: 'mcp:status',

  // RAG
  RAG_STATUS: 'rag:status',
  RAG_INDEX: 'rag:index',
  RAG_CLEAR: 'rag:clear',

  // AST
  AST_STATUS: 'ast:status',
  AST_INDEX: 'ast:index',

  // Updater
  UPDATER_CHECK: 'updater:check',
  UPDATER_INSTALL: 'updater:install',
  UPDATER_STATUS: 'updater:status',
  UPDATER_DOWNLOAD: 'updater:download',
  UPDATER_STATUS_UPDATE: 'updater:status_update',
  UPDATER_PROGRESS: 'updater:progress',
  UPDATER_ERROR: 'updater:error',
} as const;

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ── Allowed invoke channels (preload security gate) ──────────────────────────

export const ALLOWED_INVOKE_CHANNELS: readonly string[] = [
  IPC_CHANNELS.CHAT_SEND,
  IPC_CHANNELS.CHAT_CANCEL,
  IPC_CHANNELS.CONFIG_GET,
  IPC_CHANNELS.CONFIG_SAVE,
  IPC_CHANNELS.SESSION_LIST,
  IPC_CHANNELS.SESSION_LOAD,
  IPC_CHANNELS.SESSION_CREATE,
  IPC_CHANNELS.SESSION_DELETE,
  IPC_CHANNELS.SESSION_RENAME,
  IPC_CHANNELS.TOOL_EXECUTE,
  IPC_CHANNELS.AGENT_LIST,
  IPC_CHANNELS.AGENT_SPAWN,
  IPC_CHANNELS.MCP_STATUS,
  IPC_CHANNELS.RAG_STATUS,
  IPC_CHANNELS.RAG_INDEX,
  IPC_CHANNELS.RAG_CLEAR,
  IPC_CHANNELS.AST_STATUS,
  IPC_CHANNELS.AST_INDEX,
  IPC_CHANNELS.UPDATER_CHECK,
  IPC_CHANNELS.UPDATER_INSTALL,
  IPC_CHANNELS.UPDATER_STATUS,
  IPC_CHANNELS.UPDATER_DOWNLOAD,
];

// ── Allowed event channels (preload security gate) ───────────────────────────

export const ALLOWED_EVENT_CHANNELS: readonly string[] = [
  IPC_CHANNELS.CHAT_CHUNK,
  IPC_CHANNELS.CHAT_STATE,
  IPC_CHANNELS.CHAT_DONE,
  IPC_CHANNELS.CHAT_ERROR,
  IPC_CHANNELS.UPDATER_STATUS_UPDATE,
  IPC_CHANNELS.UPDATER_PROGRESS,
  IPC_CHANNELS.UPDATER_ERROR,
];

// ── Window type augmentation (renderer-side) ─────────────────────────────────

declare global {
  interface Window {
    orchid: OrchidAPI;
  }
}
