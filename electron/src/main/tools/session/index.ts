/**
 * Session lifecycle tools — list, create, load, rename, delete, change_model.
 *
 * Wraps SessionManager / the same services as UI session IPC so agents can
 * manage sessions without going through renderer IPC.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { modelSelectionSchema } from '../../../shared/types/provider';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { getSessionManager } from '../../ipc/session';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function broadcastToWindows(channel: string, payload: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as typeof import('node:module');
    const req = createRequire(__filename);
    const { BrowserWindow } = req('electron') as typeof import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  } catch {
    // Expected in unit tests without Electron.
  }
}

function forceStopSession(sessionId: string): void {
  try {
    // Lazy require avoids circular init: tools ↔ chat IPC.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as typeof import('node:module');
    const req = createRequire(__filename);
    const chat = req('../../ipc/chat') as typeof import('../../ipc/chat');
    chat.forceStopSession(sessionId);
  } catch {
    // Expected in unit tests without chat IPC.
  }
}

// ---------------------------------------------------------------------------
// session_list
// ---------------------------------------------------------------------------

export const sessionListDefinition: ToolDefinition = {
  name: 'session_list',
  description:
    'List all saved chat sessions (id, name, model, cwd, updatedAt). Newest first.',
  inputSchema: z.object({}),
  actionLabel: 'Listing sessions...',
  category: 'session',
};

export const sessionListHandler: ToolHandler = async (): Promise<string> => {
  const manager = getSessionManager();
  const sessions = manager.listSaved();
  if (sessions.length === 0) {
    return 'No saved sessions.';
  }
  const lines = sessions.map((s) => {
    const parts = [
      `id=${s.id}`,
      `name=${s.name}`,
      `model=${s.modelLabel ?? 'none'}`,
      `cwd=${s.cwd ?? 'unbound'}`,
      `chains=${s.chainCount}`,
      `updated=${new Date(s.updatedAt).toISOString()}`,
    ];
    return parts.join(' | ');
  });
  return `Found ${sessions.length} session(s):\n${lines.join('\n')}`;
};

// ---------------------------------------------------------------------------
// session_create
// ---------------------------------------------------------------------------

export const sessionCreateDefinition: ToolDefinition = {
  name: 'session_create',
  description:
    'Create a new empty chat session bound to the current project directory. ' +
    'The new session becomes active. Prefer this only when you need an immediate empty session; ' +
    'normal chat already creates sessions on first message.',
  inputSchema: z.object({
    selection: modelSelectionSchema
      .nullable()
      .optional()
      .describe(
        'Optional model selection {connectionId, modelId}. Defaults to project default_model.',
      ),
  }),
  actionLabel: 'Creating session...',
  category: 'session',
};

export const sessionCreateHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<string> => {
  const { selection: inputSelection } = input as {
    selection?: { connectionId: string; modelId: string } | null;
  };
  const manager = getSessionManager();
  const cwd = ctx.cwd;
  if (!cwd) {
    return 'Error: Cannot create session without a project directory.';
  }

  let selection =
    inputSelection === undefined
      ? (ctx.projectRuntime?.config.default_model ?? null)
      : inputSelection;

  if (selection === undefined) selection = null;

  const session = manager.create(selection, { cwd });
  broadcastToWindows(IPC_CHANNELS.SESSION_CREATED, { session });
  return [
    'Session created:',
    `  id: ${session.id}`,
    `  name: ${session.name}`,
    `  cwd: ${session.cwd ?? 'unbound'}`,
    `  model: ${session.modelLabel ?? 'none'}`,
  ].join('\n');
};

// ---------------------------------------------------------------------------
// session_load
// ---------------------------------------------------------------------------

export const sessionLoadDefinition: ToolDefinition = {
  name: 'session_load',
  description:
    'Load a session by id and set it as active (view navigation). ' +
    'Does not cancel work in other sessions. Pass activate=false to peek without switching.',
  inputSchema: z.object({
    id: z.string().uuid().describe('Session UUID to load'),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe('When false, return session data without activating'),
  }),
  actionLabel: 'Loading session...',
  category: 'session',
};

export const sessionLoadHandler: ToolHandler = async (
  input: unknown,
): Promise<string> => {
  const { id, activate = true } = input as { id: string; activate?: boolean };
  const manager = getSessionManager();

  if (!activate) {
    const session = manager.load(id);
    if (!session) {
      return `Error: Session '${id}' not found.`;
    }
    return [
      'Session (peek):',
      `  id: ${session.id}`,
      `  name: ${session.name}`,
      `  cwd: ${session.cwd ?? 'unbound'}`,
      `  model: ${session.modelLabel ?? 'none'}`,
      `  chains: ${session.chains.length}`,
    ].join('\n');
  }

  const session = manager.switchTo(id);
  if (!session) {
    return `Error: Session '${id}' not found.`;
  }
  broadcastToWindows(IPC_CHANNELS.SESSION_UPDATED, { session });
  return [
    'Session loaded and activated:',
    `  id: ${session.id}`,
    `  name: ${session.name}`,
    `  cwd: ${session.cwd ?? 'unbound'}`,
    `  model: ${session.modelLabel ?? 'none'}`,
    `  chains: ${session.chains.length}`,
  ].join('\n');
};

// ---------------------------------------------------------------------------
// session_rename
// ---------------------------------------------------------------------------

export const sessionRenameDefinition: ToolDefinition = {
  name: 'session_rename',
  description: 'Rename a session. The session must be selected/active in some window.',
  inputSchema: z.object({
    id: z.string().uuid().describe('Session UUID to rename'),
    name: z.string().min(1).describe('New session name'),
  }),
  actionLabel: 'Renaming session...',
  category: 'session',
};

export const sessionRenameHandler: ToolHandler = async (
  input: unknown,
): Promise<string> => {
  const { id, name } = input as { id: string; name: string };
  const manager = getSessionManager();
  const before = manager.getSession(id);
  if (!before) {
    return `Error: Session '${id}' not found.`;
  }
  manager.rename(id, name);
  const after = manager.getSession(id);
  if (!after || after.name !== name) {
    return `Error: Session '${id}' is not active in any window; cannot rename. Load it first.`;
  }
  broadcastToWindows(IPC_CHANNELS.SESSION_RENAMED, { id, name });
  return `Session renamed to '${name}'.`;
};

// ---------------------------------------------------------------------------
// session_delete
// ---------------------------------------------------------------------------

export const sessionDeleteDefinition: ToolDefinition = {
  name: 'session_delete',
  description:
    'Delete a session by id. Stops any in-flight work for that session first. ' +
    'Cannot be undone.',
  inputSchema: z.object({
    id: z.string().uuid().describe('Session UUID to delete'),
  }),
  actionLabel: 'Deleting session...',
  category: 'session',
};

export const sessionDeleteHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<string> => {
  const { id } = input as { id: string };
  if (ctx.sessionId && ctx.sessionId === id) {
    return (
      `Error: Cannot delete the session currently running this agent turn (${id}). ` +
      'Delete a different session, or finish this turn first.'
    );
  }
  const manager = getSessionManager();
  forceStopSession(id);
  const deleted = manager.delete(id);
  if (!deleted) {
    return `Error: Session '${id}' not found or could not be deleted.`;
  }
  return `Session '${id}' deleted.`;
};

// ---------------------------------------------------------------------------
// session_change_model
// ---------------------------------------------------------------------------

export const sessionChangeModelDefinition: ToolDefinition = {
  name: 'session_change_model',
  description:
    'Change the model selection for a session. ' +
    'selection is typed {connectionId, modelId}; pass null to clear. ' +
    'The session must be selected/active in some window.',
  inputSchema: z.object({
    id: z.string().uuid().describe('Session UUID'),
    selection: modelSelectionSchema
      .nullable()
      .describe('Model selection {connectionId, modelId}, or null to clear'),
    modelLabel: z
      .string()
      .nullable()
      .optional()
      .describe('Optional display label; defaults to modelId'),
  }),
  actionLabel: 'Changing session model...',
  category: 'session',
};

export const sessionChangeModelHandler: ToolHandler = async (
  input: unknown,
): Promise<string> => {
  const parsed = z
    .object({
      id: z.string().uuid(),
      selection: modelSelectionSchema.nullable(),
      modelLabel: z.string().nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return `Error: Invalid session_change_model input: ${parsed.error.message}`;
  }

  const { id, selection, modelLabel } = parsed.data;
  const manager = getSessionManager();
  const before = manager.getSession(id);
  if (!before) {
    return `Error: Session '${id}' not found.`;
  }

  const label = modelLabel ?? selection?.modelId ?? null;
  const beforeSel = JSON.stringify(before.selection);
  const beforeLabel = before.modelLabel;
  manager.changeModel(id, selection, label);
  const after = manager.getSession(id);
  if (!after) {
    return `Error: Session '${id}' not found after change.`;
  }
  // changeModel no-ops when session is not selected by any owner
  const afterSel = JSON.stringify(after.selection);
  const wantSel = JSON.stringify(selection);
  if (afterSel !== wantSel || after.modelLabel !== label) {
    if (beforeSel !== wantSel || beforeLabel !== label) {
      return `Error: Session '${id}' is not active in any window; cannot change model. Load it first.`;
    }
  }

  broadcastToWindows(IPC_CHANNELS.SESSION_UPDATED, { session: after });
  return [
    'Session model updated:',
    `  id: ${after.id}`,
    `  selection: ${after.selection ? `${after.selection.connectionId}/${after.selection.modelId}` : 'none'}`,
    `  modelLabel: ${after.modelLabel ?? 'none'}`,
  ].join('\n');
};

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export function registerSessionTools(
  registry: import('../registry').ToolRegistry,
): void {
  registry.register(sessionListDefinition, sessionListHandler);
  registry.register(sessionCreateDefinition, sessionCreateHandler);
  registry.register(sessionLoadDefinition, sessionLoadHandler);
  registry.register(sessionRenameDefinition, sessionRenameHandler);
  registry.register(sessionDeleteDefinition, sessionDeleteHandler);
  registry.register(sessionChangeModelDefinition, sessionChangeModelHandler);
}
