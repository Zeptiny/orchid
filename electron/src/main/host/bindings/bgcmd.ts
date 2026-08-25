/**
 * Background-command family bindings — thin forwarders over host/bgcmd.ts.
 */
import { bgCommandList, bgCommandReleaseInput, bgCommandSendInput, bgCommandSnapshot, bgCommandTerminate } from '../bgcmd';
import type { HostBinding, HostBindingEntries } from './types';

type BgSnapshotParams = Parameters<typeof bgCommandSnapshot>[0];

export function buildBgCommandBindings(): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('bgcmd.snapshot', (ctx, params: BgSnapshotParams) => bgCommandSnapshot(params, ctx.clientId));
  bind('bgcmd.list', (ctx, params: { sessionId?: string }) => bgCommandList(params, ctx.clientId));
  bind('bgcmd.send_input', (ctx, params: { commandId: number; text: string; sessionId?: string }) =>
    bgCommandSendInput(params, ctx.clientId));
  bind('bgcmd.terminate', (ctx, params: { commandId: number; sessionId?: string }) =>
    bgCommandTerminate(params, ctx.clientId));
  bind('bgcmd.release_input', (ctx, params: { commandId: number; sessionId?: string }) =>
    bgCommandReleaseInput(params, ctx.clientId));

  return entries;
}
