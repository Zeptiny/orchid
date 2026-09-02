/**
 * Tool IPC handler — tool:execute.
 *
 * Wraps the host's tool execution with zod-validated payloads.
 *
 * Security note (P1-3):
 * This IPC handler restricts the renderer to a safe subset of read-only tools.
 * Dangerous tools (write, edit, execute_command, etc.) are blocked — the agent
 * layer is responsible for invoking those through its own execution path.
 * This prevents a compromised renderer from directly mutating the filesystem
 * or executing arbitrary commands.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import {
  toolExecuteSchema,
} from './payload-schemas';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerToolIPC(): void {
  // tool:execute — execute a tool by name (restricted to safe subset)
  ipcMain.handle(IPC_CHANNELS.TOOL_EXECUTE, async (event, payload: unknown) => {
    const parsed = toolExecuteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid tool:execute payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.TOOL_EXECUTE, parsed.data);
  });
}

/**
 * Unregister tool IPC handlers (for cleanup/testing).
 */
export function unregisterToolIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.TOOL_EXECUTE);
}
