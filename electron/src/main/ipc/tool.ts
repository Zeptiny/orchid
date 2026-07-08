/**
 * Tool IPC handler — tool:execute.
 *
 * Wraps ToolRegistry from U7 with zod-validated payloads.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { toolRegistry } from '../tools';

// ── Zod validation schemas ───────────────────────────────────────────────────

const toolExecuteSchema = z.object({
  name: z.string().min(1),
  args: z.unknown(),
});

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerToolIPC(): void {
  // tool:execute — execute a tool by name
  ipcMain.handle(IPC_CHANNELS.TOOL_EXECUTE, async (_event, payload: unknown) => {
    const parsed = toolExecuteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid tool:execute payload: ${parsed.error.message}`);
    }

    const { name, args } = parsed.data;
    const tool = toolRegistry.get(name);

    if (!tool) {
      return {
        content: `Tool '${name}' not found in registry`,
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args);
      return {
        content: typeof result === 'string' ? result : JSON.stringify(result),
        isError: false,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: `Tool execution failed: ${errorMessage}`,
        isError: true,
      };
    }
  });
}

/**
 * Unregister tool IPC handlers (for cleanup/testing).
 */
export function unregisterToolIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.TOOL_EXECUTE);
}
