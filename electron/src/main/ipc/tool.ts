/**
 * Tool IPC handler — tool:execute.
 *
 * Wraps ToolRegistry from U7 with zod-validated payloads.
 *
 * Security note (P1-3):
 * This IPC handler restricts the renderer to a safe subset of read-only tools.
 * Dangerous tools (write, edit, execute_command, etc.) are blocked — the agent
 * layer is responsible for invoking those through its own execution path.
 * This prevents a compromised renderer from directly mutating the filesystem
 * or executing arbitrary commands.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { toolRegistry } from '../tools';
import type { ToolExecutionContext } from '../tools/types';
import { getSessionManager, resolveWindowWorkspace } from './session';
import { isWorkspaceBound } from '../project/workspace';

// ── Zod validation schemas ───────────────────────────────────────────────────

const toolExecuteSchema = z.object({
  name: z.string().min(1),
  args: z.unknown(),
});

// ── Allowlist of tools safe for renderer invocation ──────────────────────────

/**
 * Tools that the renderer may invoke directly via tool:execute.
 * Only read-only, non-destructive tools are permitted.
 * Dangerous tools (write, edit, execute_command, web_fetch, etc.) must be
 * invoked through the agent layer which enforces its own safety checks.
 */
const RENDERER_ALLOWED_TOOLS = new Set([
  'read',
  'read_directory',
  'glob',
  'grep',
  'todo_list',
  'rag_search',
]);

/**
 * Resolve tool context for renderer-initiated tool:execute (outside an agent turn).
 * Uses active workspace (draft → session → sticky) via resolveWindowWorkspace.
 * Rejects unless isWorkspaceBound (no raw session.cwd fallback).
 */
function resolveToolExecuteContext(windowId: string): ToolExecutionContext | null {
  try {
    const info = resolveWindowWorkspace(windowId);
    if (!isWorkspaceBound(info) || info.cwd == null) {
      return null;
    }
    const active = getSessionManager().getActive();
    return {
      cwd: info.cwd,
      sessionId: active?.id,
      agentScopeId: 'main',
    };
  } catch {
    return null;
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerToolIPC(): void {
  // tool:execute — execute a tool by name (restricted to safe subset)
  ipcMain.handle(IPC_CHANNELS.TOOL_EXECUTE, async (event, payload: unknown) => {
    const parsed = toolExecuteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid tool:execute payload: ${parsed.error.message}`);
    }

    const { name, args } = parsed.data;

    // Security: reject tools not in the allowlist
    if (!RENDERER_ALLOWED_TOOLS.has(name)) {
      return {
        content: `Tool '${name}' is not allowed via IPC. Use the agent layer for non-read-only tools.`,
        isError: true,
      };
    }

    const tool = toolRegistry.get(name);

    if (!tool) {
      return {
        content: `Tool '${name}' not found in registry`,
        isError: true,
      };
    }

    const windowId = String(event.sender.id);
    const toolCtx = resolveToolExecuteContext(windowId);
    if (!toolCtx) {
      return {
        content:
          'No project folder selected. Choose a folder before running tools.',
        isError: true,
      };
    }

    // Validate args against the tool's Zod input schema before the handler
    const validation = toolRegistry.validate(name, args);
    if (!validation.ok) {
      return {
        content: validation.error,
        isError: true,
      };
    }

    try {
      const { normalizeToolHandlerResult } = await import('../tools/result');
      const result = await tool.handler(validation.data, toolCtx);
      return normalizeToolHandlerResult(result);
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
