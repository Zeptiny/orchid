/**
 * Hydration helpers for the close/follow-up subagent tools (U3) and for
 * session open (R9).
 *
 * Records whose full form lives only in `session.subagentChains` — evicted lean
 * summaries and everything persisted before the current app launch — are
 * materialized back into the runtime manager on demand so the mutating tools can
 * operate on them (R9). Live full records are left untouched (they win).
 *
 * Successful hydration resets the manager-owned persistence timeline, so a
 * post-hydrate mutation receives a fresh checkpoint revision (R12).
 */
import type { Agent } from '../../../shared/types/agent';
import type { SubagentRecord as DomainSubagentRecord } from '../../../shared/types/subagent';
import type { HydrateSpec, SubagentManager } from '../../agents/manager';
import type { ProjectRuntime } from '../../project/runtime';
import type { ToolExecutionContext } from '../types';
import { SubagentHydrationReadiness } from './hydration-readiness';

export interface HydrateSubagentRecordsResult {
  /** Ids materialized into the manager from durable storage. */
  hydrated: string[];
  /** Ids whose stored agent definition is no longer in the project registry. */
  agentMissing: string[];
}

/** Runtime resolution inputs shared by the tool and session-open paths. */
export interface HydrateSubagentDeps {
  projectRuntime?: ProjectRuntime | null;
  windowId?: string | null;
  cwd?: string | null;
  /** Fail instead of silently skipping when durable records need a runtime. */
  requireRuntime?: boolean;
}

const sessionHydrationReadiness =
  new SubagentHydrationReadiness<HydrateSubagentRecordsResult>();

/**
 * Hydrate the given ids from `session.subagentChains` into the runtime manager.
 *
 * Ids already live in the manager as full (non-evicted) records are skipped —
 * the runtime record wins. Ids absent from the session's stored chains are left
 * out of both result lists; the caller reports them as not found. Ids whose
 * stored `agent_type` no longer resolves in the project runtime registry are
 * reported in `agentMissing` and not hydrated (synthesizing a permissive
 * fallback agent would grant tools the original definition may not have allowed).
 */
async function hydrateStoredRecords(
  manager: SubagentManager,
  sessionId: string,
  ids: string[],
  deps: HydrateSubagentDeps,
): Promise<HydrateSubagentRecordsResult> {
  const hydrated: string[] = [];
  const agentMissing: string[] = [];

  // Deduplicate so specs/hydrated/agentMissing carry no repeated entries.
  const uniqueIds = [...new Set(ids)];
  // Only ids that are absent or summaries need materialization; a live full
  // record is the authoritative copy and is never replaced.
  const needsHydration = uniqueIds.filter((id) => {
    return manager.needsHydration(id);
  });
  if (needsHydration.length === 0) {
    return { hydrated, agentMissing };
  }

  // Lazy import avoids the tools ↔ session IPC circular init and stays mockable
  // in unit tests (matches wait.ts's persistence trigger).
  const { getSessionManager } = await import('../../session/singleton.js');
  const session = getSessionManager().getSession(sessionId);
  if (!session) {
    return { hydrated, agentMissing };
  }

  const storedById = new Map<string, DomainSubagentRecord>();
  for (const record of session.subagentChains) {
    storedById.set(record.id, record);
  }

  const agents: ReadonlyMap<string, Agent> = deps.projectRuntime?.agents ?? new Map();
  const specs: HydrateSpec[] = [];
  for (const id of needsHydration) {
    const domain = storedById.get(id);
    if (!domain) continue; // not in durable storage; caller reports not found
    const agent = agents.get(domain.agent_type);
    if (!agent) {
      agentMissing.push(id);
      continue;
    }
    specs.push({
      id,
      agent,
      domain,
      sessionId,
      windowId: deps.windowId ?? null,
      cwd: session.cwd ?? deps.cwd ?? null,
      projectRuntime: deps.projectRuntime ?? undefined,
    });
  }

  manager.hydrate(specs);
  for (const spec of specs) {
    // A spec can still be skipped defensively (non-terminal status); only
    // record IDs for specs that actually materialized.
    const record = manager.getRecord(spec.id);
    if (record && !manager.isSummary(spec.id)) {
      hydrated.push(spec.id);
    }
  }

  return { hydrated, agentMissing };
}

/**
 * Tool-path entry: hydrate the given ids from durable storage, resolving the
 * project definitions from the frozen per-turn runtime.
 */
export async function hydrateSubagentRecords(
  manager: SubagentManager,
  sessionId: string,
  ids: string[],
  ctx: ToolExecutionContext,
): Promise<HydrateSubagentRecordsResult> {
  const ready = await awaitSessionSubagentHydration(manager, sessionId, {
    projectRuntime: ctx.projectRuntime,
    windowId: ctx.windowId,
    cwd: ctx.cwd,
  });
  const targeted = await hydrateStoredRecords(manager, sessionId, ids, {
    projectRuntime: ctx.projectRuntime,
    windowId: ctx.windowId,
    cwd: ctx.cwd,
  });
  const requested = new Set(ids);
  return {
    hydrated: [...new Set([
      ...ready.hydrated.filter((id) => requested.has(id)),
      ...targeted.hydrated,
    ])],
    agentMissing: [...new Set([
      ...ready.agentMissing.filter((id) => requested.has(id)),
      ...targeted.agentMissing,
    ])],
  };
}

/**
 * Session-open entry: materialize every stored subagent chain of one session
 * back into the runtime manager, so the main agent regains its subagent context
 * after an app restart. The UI already renders stored rows; the dynamic system
 * prompt and the wait/interrupt/answer tools only see the manager, which starts
 * empty each launch.
 *
 * Idempotent: live full records win and are never replaced, so repeated opens
 * are no-ops. Records whose stored `agent_type` no longer resolves are left in
 * storage (the tool path reports them as `agentMissing`). When the project
 * runtime cannot be resolved (directory deleted/moved, runtime load failure)
 * hydration is skipped entirely — the session is unusable without it.
 */
export async function hydrateSessionSubagents(
  manager: SubagentManager,
  sessionId: string,
  deps: HydrateSubagentDeps = {},
): Promise<HydrateSubagentRecordsResult> {
  const { getSessionManager } = await import('../../session/singleton.js');
  const session = getSessionManager().getSession(sessionId);
  if (!session || session.subagentChains.length === 0) {
    return { hydrated: [], agentMissing: [] };
  }

  let projectRuntime: ProjectRuntime | null = deps.projectRuntime ?? null;
  const cwd = session.cwd ?? deps.cwd ?? null;
  if (!projectRuntime && cwd) {
    try {
      const { getProjectRuntimeRegistry } = await import('../../project/runtime.js');
      projectRuntime = getProjectRuntimeRegistry().get(cwd);
    } catch {
      // Project directory deleted/moved or runtime load failed; leave the
      // records stored and visible in the UI.
      projectRuntime = null;
    }
  }
  if (!projectRuntime) {
    if (deps.requireRuntime) {
      throw new Error(
        `Cannot hydrate stored subagents for session '${sessionId}': project runtime is unavailable.`,
      );
    }
    return { hydrated: [], agentMissing: [] };
  }

  return hydrateStoredRecords(
    manager,
    sessionId,
    session.subagentChains.map((record) => record.id),
    { projectRuntime, windowId: deps.windowId, cwd },
  );
}

/**
 * Start or join the correctness boundary for one session's persisted records.
 * Navigation may fire-and-forget this promise; sends and lifecycle tools await
 * it. A rejection is not cached, allowing the next caller to retry.
 */
export function awaitSessionSubagentHydration(
  manager: SubagentManager,
  sessionId: string,
  deps: HydrateSubagentDeps = {},
): Promise<HydrateSubagentRecordsResult> {
  return sessionHydrationReadiness.ensure(manager, sessionId, () => (
    hydrateSessionSubagents(manager, sessionId, {
      ...deps,
      requireRuntime: true,
    })
  ));
}

/** Clear retained readiness when a durable session is removed or invalidated. */
export function clearSessionSubagentHydration(
  manager: SubagentManager,
  sessionId?: string,
): void {
  sessionHydrationReadiness.clear(manager, sessionId);
}
