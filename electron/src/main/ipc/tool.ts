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
import { getProjectTrustState } from '../project/trust';
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

    // One call id for the whole invocation — executeToolCall derives the
    // handler ctx's toolCallId from request.id, so the live-output mirror
    // and every terminal result below key off the same id.
    const toolCallId = crypto.randomUUID();

    // Security: reject tools not in the allowlist
    if (!RENDERER_ALLOWED_TOOLS.has(name)) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        `Tool '${name}' is not allowed via IPC. Use the agent layer for non-read-only tools.`,
        'ipc_tool_not_allowed',
      );
    }

    const tool = toolRegistry.get(name);

    if (!tool) {
      return genericTerminalExecution(
        toolCallId,
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
        toolCallId,
        name,
        'error',
        'No project folder selected. Choose a folder before running tools.',
        'missing_workspace',
      );
    }

    if (getProjectTrustState(toolCtx.cwd) !== 'trusted') {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        'This project folder is not trusted. Trust it before running tools.',
        'untrusted_project',
      );
    }

    return executeToolCall(
      {
        id: toolCallId,
        name,
        args,
      },
      toolRegistry,
      {
        cwd: toolCtx.cwd,
        sessionId: toolCtx.sessionId,
        agentScopeId: toolCtx.agentScopeId,
        projectRuntime: toolCtx.projectRuntime,
        windowId,
        // Renderer tool:execute results surface in the UI, not the LLM context:
        // keep AGENTS.md read injection / write enforcement off this path (R17).
        agentsMdDisabled: true,
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
