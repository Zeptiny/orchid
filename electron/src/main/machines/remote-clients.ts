/**
 * Remote machine clients — the connect/disconnect half of machine routing
 * (issue #112, plan unit U8).
 *
 * A connected SSH machine owns one `HostClient` over the connection manager's
 * live transport, registered in `host/routing.ts` so every machine-scoped IPC
 * request from a window pointing at that machine flows through it. Events
 * arriving on the client fan out to exactly the windows whose active machine is
 * that machine — the remote twin of `ipc/host-broadcast.ts`, which routes each
 * local per-window client to its own window by client id.
 */
import { BrowserWindow } from 'electron';
import { HOST_EVENTS, type HostEventName } from '../../shared/host/protocol';
import { createHostClient, type HostClient } from '../host/client';
import type { HostTransport } from '../host/transport';
import { activeMachineFor, registerHostClient, unregisterHostClient } from '../host/routing';
import { canSend } from '../ipc/chat/events';
import type { RemoteMachineRecord } from '../../shared/types/machine';

interface AttachedClient {
  readonly client: HostClient;
  readonly transport: HostTransport;
  readonly detach: () => void;
}

const attached = new Map<string, AttachedClient>();

/**
 * Interactive deadline for one host request on a remote machine (review fix
 * #24). Generous on purpose — it exists to reject renderer invokes that a
 * wedged-but-alive remote daemon (stuck sqlite lock, hung MCP call) would
 * otherwise leave pending forever; ssh keepalives only catch network death.
 */
const REMOTE_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Methods that legitimately outlive any interactive deadline (verified
 * against the server bindings in host/server.ts): full-project indexing
 * (`rag.index`, `ast.index`), provider model discovery (network round trips
 * to the provider — including the first-credential discovery that
 * `providers.create` embeds after persisting the connection), and
 * user-initiated compaction (a synchronous LLM summarization call). They run
 * with NO client timer — a deadline would cancel real work on a healthy
 * remote. `chat.send` is deliberately absent: the turn runs detached on the
 * host and the request itself returns promptly, so it takes the interactive
 * default.
 */
const REMOTE_UNTIMED_METHODS: ReadonlySet<string> = new Set([
  'rag.index',
  'ast.index',
  'providers.discover_models',
  'providers.create',
  'chat.compact',
]);

/** Deadline resolver handed to the remote client (0 disables, undefined = default). */
const remoteMethodTimeoutMs = (method: string): number | undefined =>
  REMOTE_UNTIMED_METHODS.has(method) ? 0 : undefined;

/**
 * Push one protocol event to every live window driving this machine. Unlike
 * the local path (clientId === window id) the recipients are resolved through
 * the per-window active-machine map, so several windows can share one remote
 * client and no window on another machine ever sees its events.
 *
 * Exported for `machines/resync.ts`, which re-broadcasts the reconnect
 * catch-up through this exact path so resync deliveries are indistinguishable
 * from live ones.
 */
export function deliverToMachineWindows(machineId: string, ev: string, params: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed?.() || win.webContents?.isDestroyed?.()) continue;
      if (activeMachineFor(String(win.webContents.id)) !== machineId) continue;
      if (!canSend(win.webContents)) continue;
      win.webContents.send(ev, params);
    } catch (error) {
      // One destroyed/racing window must not starve the remaining windows.
      console.debug(`[machine-client] '${ev}' to a window of '${machineId}' failed (non-fatal):`, error);
    }
  }
}

/**
 * Build, register, and wire the host client for a connected machine. Every
 * host event — including approvals and questions, which have no local store
 * for remotes — is forwarded to the machine's windows. Re-attaching for the
 * same live transport is a no-op; a different transport replaces the client.
 */
export function attachRemoteMachineClient(
  machine: RemoteMachineRecord,
  transport: HostTransport,
): HostClient {
  const existing = attached.get(machine.id);
  if (existing && existing.transport === transport && existing.client.isAlive()) {
    return existing.client;
  }
  detachRemoteMachineClient(machine.id);

  const client = createHostClient(transport, {
    clientId: `machine:${machine.id}`,
    label: `machine:${machine.label}`,
    // A wedged remote daemon must not leave renderer invokes pending forever
    // (#24): interactive methods get a generous deadline, the long-running
    // set above gets none. A timeout rejects that one request (typed TIMEOUT)
    // without killing the transport.
    requestTimeoutMs: REMOTE_REQUEST_TIMEOUT_MS,
    methodTimeoutMs: remoteMethodTimeoutMs,
    // The remote daemon is an untrusted peer (#16): event payloads and
    // response results are validated against the protocol registries before
    // they can reach renderer reducers.
    validateInbound: true,
  });
  const unsubscribers: Array<() => void> = [];
  for (const ev of Object.keys(HOST_EVENTS) as HostEventName[]) {
    unsubscribers.push(
      client.subscribe(ev, (params) => deliverToMachineWindows(machine.id, ev, params)),
    );
  }
  const detach = (): void => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // non-fatal
      }
    }
  };
  // A transport that dies (connection lost) must stop serving requests
  // immediately: drop the window broadcast and the routing registration. The
  // identity guard keeps a replacement client's registration safe when an
  // older transport closes late.
  client.onClose(() => {
    const current = attached.get(machine.id);
    if (current?.client !== client) return;
    attached.delete(machine.id);
    detach();
    unregisterHostClient(machine.id);
  });
  attached.set(machine.id, { client, transport, detach });
  registerHostClient(machine.id, client);
  return client;
}

/**
 * Tear one machine's client down: drop the routing registration, unsubscribe
 * the window broadcast, and close the client (idempotent for unknown ids).
 */
export function detachRemoteMachineClient(machineId: string): void {
  const existing = attached.get(machineId);
  attached.delete(machineId);
  if (existing) {
    existing.detach();
    try {
      existing.client.close();
    } catch {
      // non-fatal
    }
  }
  unregisterHostClient(machineId);
}

/** Detach every attached client (IPC teardown / tests). */
export function detachAllRemoteMachineClients(): void {
  for (const machineId of [...attached.keys()]) {
    detachRemoteMachineClient(machineId);
  }
}
