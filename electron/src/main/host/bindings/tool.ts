/**
 * Tool family binding — the renderer-facing direct tool surface. Only the
 * shared renderer allow-list (read-only tools) is invocable; everything else
 * must go through the agent layer.
 */
import { RENDERER_ALLOWED_TOOLS } from '../../../shared/types/tool';
import { getSessionManager, resolveBoundProjectPath } from '../../session/singleton';
import { getProjectTrustState } from '../../project/trust';
import { getProjectRuntimeRegistry } from '../../project/runtime';
import { toolRegistry } from '../../tools';
import {
  executeToolCall,
  genericTerminalExecution,
} from '../../llm/tool-dispatch';
import type { HostBinding, HostBindingEntries } from './types';

export function buildToolBindings(): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('tool.execute', async (ctx, params: { name: string; args?: unknown }) => {
    const { name, args } = params;
    const toolCallId = crypto.randomUUID();
    if (!RENDERER_ALLOWED_TOOLS.has(name)) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        `Tool '${name}' is not allowed on this host surface. Use the agent layer for non-read-only tools.`,
        'host_tool_not_allowed',
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
    let cwd: string | null;
    try {
      cwd = resolveBoundProjectPath(ctx.clientId);
    } catch {
      cwd = null;
    }
    if (cwd == null) {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        'No project folder selected. Choose a folder before running tools.',
        'missing_workspace',
      );
    }
    if (getProjectTrustState(cwd) !== 'trusted') {
      return genericTerminalExecution(
        toolCallId,
        name,
        'error',
        'This project folder is not trusted. Trust it before running tools.',
        'untrusted_project',
      );
    }
    const active = getSessionManager().getActive(ctx.clientId);
    return executeToolCall(
      {
        id: toolCallId,
        name,
        args: args ?? {},
      },
      toolRegistry,
      {
        cwd,
        sessionId: active?.id,
        agentScopeId: 'main',
        projectRuntime: getProjectRuntimeRegistry().get(cwd),
        windowId: ctx.clientId,
        agentsMdDisabled: true,
      },
    );
  });

  return entries;
}
