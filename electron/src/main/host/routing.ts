/**
 * Machine routing — the authoritative table saying which IPC channels are
 * served by a host (through a {@link HostClient}) and which stay local
 * (plan 2026-08-23-001, U5).
 *
 * Classification is mechanical: a channel is host-routed exactly when its
 * name maps to a `HOST_METHODS` entry (':' → '.') *and* it is an invocable
 * channel (`ALLOWED_INVOKE_CHANNELS`). Everything else — machines, analytics,
 * updater, startup, provider vault writes, the config-scope surfaces with no
 * host method, and push-event channels — is local.
 *
 * Two channels that satisfy the mechanical rule are nevertheless pinned local:
 * `session:pick_project_dir` and `definition:reveal` need a host-native
 * dialog/shell, so the Electron shell keeps them (they are protocol methods
 * gated by capabilities the daemon never declares).
 */
import {
  HOST_ERROR_CODES,
  HOST_METHODS,
  HostProtocolError,
  channelToMethod,
  methodToChannel,
} from '../../shared/host/protocol';
import { ALLOWED_INVOKE_CHANNELS, IPC_CHANNELS } from '../../shared/types/ipc';
import { getLocalHostClient } from './local-host';
import type { HostClient } from './client';

/** The machine this app runs on; implicitly connected, never registered. */
export const LOCAL_MACHINE_ID = 'local';

export type MachineId = string;

export type ChannelRoute = 'host' | 'local';

/**
 * Host-protocol methods whose Electron handler must stay local because they
 * need a host-native surface (folder dialog / shell reveal). They are absent
 * from {@link HOST_ROUTED_CHANNELS} on purpose; see the module comment.
 */
export const LOCAL_ONLY_HOST_CAPABILITY_CHANNELS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.SESSION_PICK_PROJECT_DIR,
  IPC_CHANNELS.DEFINITION_REVEAL,
]);

/** Every channel served through a HostClient. */
export const HOST_ROUTED_CHANNELS: ReadonlySet<string> = computeHostRoutedChannels();

function computeHostRoutedChannels(): ReadonlySet<string> {
  const invocable = new Set<string>(ALLOWED_INVOKE_CHANNELS);
  const routed = new Set<string>();
  for (const method of Object.keys(HOST_METHODS)) {
    const channel = methodToChannel(method);
    if (invocable.has(channel) && !LOCAL_ONLY_HOST_CAPABILITY_CHANNELS.has(channel)) {
      routed.add(channel);
    }
  }
  return routed;
}

/** Whether an invocable channel is served by the active machine's host. */
export function isHostRoutedChannel(channel: string): boolean {
  return HOST_ROUTED_CHANNELS.has(channel);
}

/**
 * Routing-table invariants; throws on drift so a channel added without a
 * protocol method (or vice versa) fails loudly instead of routing silently.
 */
export function verifyRoutingTable(): void {
  const invocable = new Set<string>(ALLOWED_INVOKE_CHANNELS);
  const hostMethodChannels = new Set(
    Object.keys(HOST_METHODS).map((method) => methodToChannel(method)),
  );
  // 1. Host routing is exactly (HOST_METHODS ∩ invocable) − local-only caps.
  const expected = new Set(
    [...hostMethodChannels].filter(
      (channel) => invocable.has(channel) && !LOCAL_ONLY_HOST_CAPABILITY_CHANNELS.has(channel),
    ),
  );
  if (expected.size !== HOST_ROUTED_CHANNELS.size
    || [...expected].some((channel) => !HOST_ROUTED_CHANNELS.has(channel))) {
    throw new Error('Host routing table drifted from HOST_METHODS ∩ ALLOWED_INVOKE_CHANNELS');
  }
  // 2. Local-only capability overrides must be real, invocable host methods —
  //    a typo here would silently drop the channel from every host.
  for (const channel of LOCAL_ONLY_HOST_CAPABILITY_CHANNELS) {
    if (!hostMethodChannels.has(channel) || !invocable.has(channel)) {
      throw new Error(`Local-only capability channel '${channel}' is not a host method`);
    }
  }
}

/**
 * The invocable channels that stay local (machines, analytics, updater,
 * startup, provider vault writes, config-scope surfaces with no host method,
 * the two local-only capability channels, …).
 */
export function localInvokeChannels(): string[] {
  return ALLOWED_INVOKE_CHANNELS.filter((channel) => !HOST_ROUTED_CHANNELS.has(channel));
}

// ── Per-window active machine ────────────────────────────────────────────────

const machineByWindow = new Map<string, MachineId>();
const clientsByMachine = new Map<MachineId, HostClient>();

/** The machine a window currently drives (defaults to the local machine). */
export function activeMachineFor(windowId: string): MachineId {
  return machineByWindow.get(windowId) ?? LOCAL_MACHINE_ID;
}

/** Point a window at another machine's host (U8); returns the previous id. */
export function setActiveMachine(windowId: string, machineId: MachineId): MachineId {
  const previous = activeMachineFor(windowId);
  if (machineId === LOCAL_MACHINE_ID) {
    machineByWindow.delete(windowId);
  } else {
    machineByWindow.set(windowId, machineId);
  }
  return previous;
}

/** Forget a window's override (window closed / tests). */
export function clearActiveMachine(windowId: string): void {
  machineByWindow.delete(windowId);
}

/**
 * Reset every window still pointing at one machine back to local (the machine
 * was deleted or its client torn down); returns the reset window ids.
 */
export function resetWindowsForMachine(machineId: MachineId): string[] {
  const reset: string[] = [];
  for (const [windowId, machine] of machineByWindow) {
    if (machine === machineId) {
      machineByWindow.delete(windowId);
      reset.push(windowId);
    }
  }
  return reset;
}

/** Register the client of a connected machine (remote machines, U7/U8). */
export function registerHostClient(machineId: MachineId, client: HostClient): void {
  clientsByMachine.set(machineId, client);
}

export function unregisterHostClient(machineId: MachineId): void {
  clientsByMachine.delete(machineId);
}

/** The client of a registered machine; unknown ids are a hard error. */
export function getHostClient(machineId: MachineId): HostClient {
  const client = clientsByMachine.get(machineId);
  if (!client) {
    throw new HostProtocolError(
      HOST_ERROR_CODES.HOST_UNAVAILABLE,
      `No host client is registered for machine '${machineId}'`,
    );
  }
  return client;
}

/** Which machine ids currently have a client (diagnostics/tests). */
export function registeredMachines(): MachineId[] {
  return [...clientsByMachine.keys()];
}

/**
 * The client a window's requests must go through: the local machine resolves to
 * its per-window in-process client, any other machine to the registered client.
 */
export function clientForWindow(windowId: string): HostClient {
  const machineId = activeMachineFor(windowId);
  if (machineId === LOCAL_MACHINE_ID) {
    return getLocalHostClient(windowId);
  }
  return getHostClient(machineId);
}

/**
 * Facade used by every host-routed IPC handler:
 * `hostRequest(String(event.sender.id), channel, payload)`.
 */
export async function hostRequest<T = unknown>(
  windowId: string,
  channel: string,
  payload?: unknown,
): Promise<T> {
  if (!isHostRoutedChannel(channel)) {
    throw new Error(`Channel '${channel}' is not host-routed; keep it local`);
  }
  return clientForWindow(windowId).request<T>(channelToMethod(channel), payload);
}
