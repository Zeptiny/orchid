/**
 * Subagent family bindings — live snapshot + detail projection of the
 * subagent manager, per session.
 */
import { createSubagentDetail, createSubagentSnapshot } from '../subagents';
import type { HostBinding, HostBindingEntries } from './types';

export function buildSubagentsBindings(): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('subagents.snapshot', (_ctx, params: { sessionId: string }) =>
    createSubagentSnapshot(params.sessionId));
  bind('subagents.detail', (_ctx, params: { sessionId: string; subagentId: string }) =>
    createSubagentDetail(params.sessionId, params.subagentId));

  return entries;
}
