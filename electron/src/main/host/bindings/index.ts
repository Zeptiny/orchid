/**
 * Binding registry composition — assembles the per-family tables
 * (bindings/*.ts) into the single method → binding map HostServer
 * dispatches through, and enforces the completeness guard: every
 * `HOST_METHODS` registry entry must be bound (or intentionally absent from
 * both). Fail fast at server construction instead of at runtime.
 */
import { HOST_METHODS } from '../../../shared/host/protocol';
import { buildBgCommandBindings } from './bgcmd';
import { buildChatBindings } from './chat';
import { buildConfigBindings } from './config';
import { buildDefinitionBindings } from './definitions';
import { buildHostBindings as buildHostFamilyBindings } from './host';
import { buildIndexBindings } from './indexes';
import { buildPermissionBindings } from './permissions';
import { buildProjectBindings } from './project';
import { buildProviderBindings } from './providers';
import { buildSessionBindings } from './sessions';
import { buildSubagentsBindings } from './subagents';
import { buildToolBindings } from './tool';
import { buildWorkingSetBindings } from './working-set';
import type { HostBinding, HostServerSurface } from './types';

export type { HostBinding, HostRequestContext, HostServerSurface } from './types';
export { pendingApprovalEvent, pendingQuestionEvent } from './pending-events';

/** Compose every family table into one dispatch map (completeness-gated). */
export function buildHostBindings(surface: HostServerSurface): ReadonlyMap<string, HostBinding<never>> {
  const entries: Array<[string, HostBinding<never>]> = [
    ...buildHostFamilyBindings(surface),
    ...buildChatBindings(),
    ...buildSubagentsBindings(),
    ...buildSessionBindings(surface),
    ...buildWorkingSetBindings(surface),
    ...buildBgCommandBindings(),
    ...buildPermissionBindings(),
    ...buildProjectBindings(surface),
    ...buildDefinitionBindings(surface),
    ...buildIndexBindings(surface),
    ...buildToolBindings(),
    ...buildConfigBindings(),
    ...buildProviderBindings(),
  ];

  // Completeness guard: every registry method must be bound (or intentionally
  // absent from both). Duplicates would silently shadow inside the Map, so a
  // repeated method across family tables is equally fatal.
  const bound = new Set(entries.map(([method]) => method));
  if (bound.size !== entries.length) {
    const seen = new Set<string>();
    for (const [method] of entries) {
      if (seen.has(method)) {
        throw new Error(`HostServer has duplicate bindings for '${method}'`);
      }
      seen.add(method);
    }
  }
  for (const method of Object.keys(HOST_METHODS)) {
    if (!bound.has(method)) {
      throw new Error(`HostServer is missing a binding for '${method}'`);
    }
  }

  return new Map(entries);
}
