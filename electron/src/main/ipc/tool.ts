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
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { toolRegistry } from '../tools';
import type { ToolExecutionContext } from '../tools/types';
import { getSessionManager, resolveBoundProjectPath } from './session';
import { getProjectRuntimeRegistry } from '../project/runtime';
import {
  RENDERER_ALLOWED_TOOLS,
  toolExecuteSchema,
} from './payload-schemas';
import {
  executeToolCall,
  genericTerminalExecution,
} from '../llm/tool-dispatch';

/**
 * Resolve tool context for renderer-initiated tool:execute (outside an agent turn).
 * Uses active workspace (draft → session → sticky). Rejects when unbound.
 */
function resolveToolExecuteContext(windowId: string): ToolExecutionContext | null {
  try {
    const cwd = resolveBoundProjectPath(windowId);
    if (cwd == null) return null;
    const active = getSessionManager().getActive(windowId);
    return {
      cwd,
      sessionId: active?.id,
      agentScopeId: 'main',
      projectRuntime: getProjectRuntimeRegistry().get(cwd),
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
      return genericTerminalExecution(
        crypto.randomUUID(),
        name,
        'error',
        `Tool '${name}' is not allowed via IPC. Use the agent layer for non-read-only tools.`,
        'ipc_tool_not_allowed',
      );
    }

    const tool = toolRegistry.get(name);

    if (!tool) {
      return genericTerminalExecution(
        crypto.randomUUID(),
        name,
        'error',
        `Tool '${name}' not found in registry`,
        'unknown_tool',
      );
    }

    const windowId = String(event.sender.id);
    const toolCtx = resolveToolExecuteContext(windowId);
    if (!toolCtx) {
      return genericTerminalExecution(
        crypto.randomUUID(),
        name,
        'error',
        'No project folder selected. Choose a folder before running tools.',
        'missing_workspace',
      );
    }

    return executeToolCall(
      {
        id: crypto.randomUUID(),
        name,
        args,
      },
      toolRegistry,
      {
        cwd: toolCtx.cwd,
        sessionId: toolCtx.sessionId,
        agentScopeId: toolCtx.agentScopeId,
        projectRuntime: toolCtx.projectRuntime,
      },
    );
  });
}

/**
 * Unregister tool IPC handlers (for cleanup/testing).
 */
export function unregisterToolIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.TOOL_EXECUTE);
}
