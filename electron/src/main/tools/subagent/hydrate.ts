/**
 * Tool-side hydration helper for the close/follow-up subagent tools (U3).
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
import type { ToolExecutionContext } from '../types';

export interface HydrateSubagentRecordsResult {
  /** Ids materialized into the manager from durable storage. */
  hydrated: string[];
  /** Ids whose stored agent definition is no longer in the project registry. */
  agentMissing: string[];
}

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
export async function hydrateSubagentRecords(
  manager: SubagentManager,
  sessionId: string,
  ids: string[],
  ctx: ToolExecutionContext,
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

  const agents: ReadonlyMap<string, Agent> = ctx.projectRuntime?.agents ?? new Map();
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
      windowId: ctx.windowId ?? null,
      cwd: session.cwd ?? ctx.cwd ?? null,
      projectRuntime: ctx.projectRuntime,
    });
  }

  manager.hydrate(specs);
  for (const spec of specs) {
    // A spec can still be skipped defensively (non-terminal status); only reset
    // the persistence tracker for records that actually materialized.
    const record = manager.getRecord(spec.id);
    if (record && !manager.isSummary(spec.id)) {
      hydrated.push(spec.id);
    }
  }

  return { hydrated, agentMissing };
}
