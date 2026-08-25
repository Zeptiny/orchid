/**
 * Host-key scan/pin flow (issue #112, plan unit U8).
 *
 * The add-machine wizard and the connect handler both need the same two-step
 * TOFU exchange: `scanHostKeys` out-of-band, then an explicit confirmation that
 * pins *that* scan. The last raw scan per machine is cached in memory so
 * `confirm` pins exactly the fingerprints the user saw — a re-scan between
 * display and confirm can never silently pin different keys.
 */
import {
  fingerprintsFromScan,
  readPinnedKeys,
  removeKnownHosts,
  scanHostKeys,
  writeKnownHosts,
  type HostKeyFingerprint,
  type KeyScanExecFn,
} from './host-key';
import type { RemoteMachineRecord } from '../../shared/types/machine';

/** Typed flow failure the IPC layer serializes for the renderer. */
export class MachineHostKeyFlowError extends Error {
  readonly kind: 'host-key-scan-missing';

  constructor(message: string) {
    super(message);
    this.name = 'MachineHostKeyFlowError';
    this.kind = 'host-key-scan-missing';
  }
}

export interface MachineHostKeyFlowOptions {
  /** Base dir for known-hosts paths (tests); defaults to `~/.orchid`. */
  readonly homeDir?: string;
  /** Injectable keyscan exec (tests fake the keyscan output). */
  readonly execFn?: KeyScanExecFn;
}

export class MachineHostKeyFlow {
  private readonly homeDir: string | undefined;
  private readonly execFn: KeyScanExecFn | undefined;
  private readonly scans = new Map<string, string[]>();

  constructor(options: MachineHostKeyFlowOptions = {}) {
    this.homeDir = options.homeDir;
    this.execFn = options.execFn;
  }

  /**
   * Scan a machine's host keys out-of-band and cache the raw lines for a later
   * {@link confirm}. Rejects with `HostKeyScanError` when the host cannot be
   * scanned or yields no keys.
   */
  async scan(machine: RemoteMachineRecord): Promise<HostKeyFingerprint[]> {
    const lines = await scanHostKeys(machine.host, machine.port, {
      execFn: this.execFn,
    });
    this.scans.set(machine.id, lines);
    return fingerprintsFromScan(lines);
  }

  /**
   * Pin the machine's most recent scan into its known-hosts file. Throws
   * `MachineHostKeyFlowError` when no scan is cached — confirming requires
   * showing the user fingerprints first.
   */
  confirm(machineId: string): HostKeyFingerprint[] {
    const lines = this.scans.get(machineId);
    if (!lines || lines.length === 0) {
      throw new MachineHostKeyFlowError(
        `No host-key scan for machine '${machineId}'; scan before confirming.`,
      );
    }
    writeKnownHosts(machineId, lines, { homeDir: this.homeDir });
    return fingerprintsFromScan(lines);
  }

  /** Whether a non-empty known-hosts pin exists (the connect-time TOFU gate). */
  pinned(machineId: string): boolean {
    return readPinnedKeys(machineId, this.homeDir).length > 0;
  }

  /** Drop cached state for a machine (registry delete). */
  forget(machineId: string): void {
    this.scans.delete(machineId);
  }

  /**
   * Drop the machine's pinned known-hosts file AND its cached scan so the
   * TOFU scan/confirm gate re-arms. Used when a registry update changes the
   * machine's destination (host/user/port): the old pin attests a host the
   * machine no longer points at, and a stale cached scan must never be
   * confirmable into a pin for the new destination.
   */
  unpin(machineId: string): void {
    this.scans.delete(machineId);
    removeKnownHosts(machineId, this.homeDir);
  }
}

let flow: MachineHostKeyFlow | null = null;

/** Process-wide host-key flow (real `ssh-keyscan`, `~/.orchid` pins). */
export function getMachineHostKeyFlow(): MachineHostKeyFlow {
  if (flow === null) {
    flow = new MachineHostKeyFlow();
  }
  return flow;
}

/** Drop the process-wide flow so the next call rebuilds it. For tests. */
export function _resetMachineHostKeyFlowForTests(): void {
  flow = null;
}
