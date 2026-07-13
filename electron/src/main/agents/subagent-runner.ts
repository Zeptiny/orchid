/**
 * Subagent stream runner — drives streamChat for a delegated subagent.
 *
 * Used by SubagentManager when a runner is configured (production).
 * Tests leave the runner unset so spawn/markCompleted stay manual.
 */
import type { Agent } from '../../shared/types/agent';
import type { ModelSelection } from '../../shared/types/provider';
import type { StreamEvent } from '../llm/orchestrator';
import { getConfig } from '../config/loader';
import { getSessionManager } from '../ipc/session';
import {
  getProjectRuntimeRegistry,
  hydrateProjectRuntime,
  type ProjectRuntime,
} from '../project/runtime';
import type { SubagentStreamRunner } from './manager';

/**
 * Fallback cwd when spawn did not pass a frozen parent-turn path.
 * Never uses process.cwd().
 */
function resolveParentSessionCwdFallback(sessionId?: string): string | null {
  try {
    const manager = getSessionManager();
    const session = sessionId
      ? manager.getSession(sessionId)
      : manager.getActive();
    if (session?.cwd != null && session.cwd !== '') {
      return session.cwd;
    }
    const sticky = getConfig().default_project_dir;
    if (sticky != null && sticky !== '') {
      return sticky;
    }
  } catch {
    // Session manager may be unavailable in tests
  }
  return null;
}

/**
 * Create the production stream runner for subagents.
 * Validates a frozen selection before U4 wires it into a trusted driver.
 */
export function createSubagentStreamRunner(): SubagentStreamRunner {
  return async function* subagentStream(params: {
    task: string;
    agent: Agent;
    selection: ModelSelection | null;
    abortSignal: AbortSignal;
    sessionId?: string;
    /** Frozen parent-turn workspace cwd. */
    cwd?: string;
    /** This subagent's scope id (record.id) for todos / bg / prompt isolation. */
    agentScopeId: string;
    /** Immutable project config/definitions captured by the parent turn. */
    projectRuntime?: ProjectRuntime;
  }): AsyncGenerator<StreamEvent> {
    const sessionId = params.sessionId;
    if (!sessionId) {
      yield {
        type: 'error',
        title: 'Missing session',
        detail: 'Subagent cannot run without an explicit parent session id.',
      };
      return;
    }

    // Prefer frozen parent-turn cwd; only fall back if spawn omitted it.
    const parentCwd =
      (params.cwd != null && params.cwd !== '' ? params.cwd : null) ??
      resolveParentSessionCwdFallback(sessionId);
    if (parentCwd == null) {
      yield {
        type: 'error',
        title: 'No workspace',
        detail:
          'Subagent cannot run: parent session has no project working directory.',
      };
      return;
    }

    const baseRuntime =
      params.projectRuntime ?? getProjectRuntimeRegistry().get(parentCwd);
    const runtime = await hydrateProjectRuntime(baseRuntime);
    const config = runtime.config;
    // Resolve selection: explicit override → tier selection → nullable default.
    const selection =
      params.selection ??
      (config.tier_models[params.agent.tier] ?? config.default_model);
    if (selection == null) {
      yield {
        type: 'error',
        title: 'Provider connection required',
        detail: 'Connect a provider and select a model before delegating a subagent.',
      };
      return;
    }

    // U4 installs the trusted registry that turns this frozen selection into a
    // native adapter. U1 must not revive the legacy alias/model parser here.
    yield {
      type: 'error',
      title: 'Provider driver unavailable',
      detail: 'Provider connections are not ready for execution yet.',
    };
    return;
  };
}
