/**
 * Machine registry — the implicit local machine plus persisted SSH remotes.
 *
 * Remotes live in the home config `machines` section (metadata only; SSH auth
 * rides the user's existing key/agent, so no secrets are stored). The local
 * machine is never persisted: it is synthesized on read and always listed
 * first.
 *
 * Mutations patch only the `machines` key of the home config file so sibling
 * keys survive, and they apply the same records to the cached config so a
 * later `config:save` cannot resurrect the pre-mutation registry.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getConfig, atomicWriteJson, HOME_CONFIG_PATH } from '../config/loader';
import { isPlainObject } from '../config/merge';
import { withConfigSaveLock } from '../config/write-lock';
import {
  MACHINE_ID_LOCAL,
  remoteMachineRecordSchema,
  type LocalMachineRecord,
  type MachineCreateInput,
  type MachineRecord,
  type MachineUpdateInput,
  type RemoteMachineRecord,
} from '../../shared/types/machine';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Sort remote machines by label (locale-aware), id as the stable tie-break. */
export function sortRemoteMachines(
  records: readonly RemoteMachineRecord[],
): RemoteMachineRecord[] {
  return [...records].sort(
    (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

/** Display label for the implicit local machine, e.g. `This Mac (studio)`. */
export function localMachineLabel(hostname: string, platform: NodeJS.Platform): string {
  const prefix = platform === 'darwin' ? 'This Mac' : 'This PC';
  const host = hostname.trim();
  return host === '' ? prefix : `${prefix} (${host})`;
}

/** Build the implicit local machine record for the host it runs on. */
export function buildLocalMachine(
  hostname: string,
  platform: NodeJS.Platform,
): LocalMachineRecord {
  return {
    id: MACHINE_ID_LOCAL,
    label: localMachineLabel(hostname, platform),
    kind: 'local',
  };
}

/** Ordered machine list: implicit local machine first, then remotes by label. */
export function orderMachines(
  local: LocalMachineRecord,
  remotes: readonly RemoteMachineRecord[],
): MachineRecord[] {
  return [local, ...sortRemoteMachines(remotes)];
}

/**
 * Parse the raw home-config `machines` value into validated remote records.
 * Throws on a non-array section or an invalid entry so a hand-edited config is
 * surfaced instead of silently dropping records on the next write.
 */
export function parseRemoteMachineRecords(raw: unknown): RemoteMachineRecord[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('Home config `machines` section must be an array of machine records');
  }
  return raw.map((entry, index) => {
    const parsed = remoteMachineRecordSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `Home config machine entry ${index} is invalid: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  });
}

/** Merge a partial patch into a stored record, bumping `updated_at`. */
export function applyMachinePatch(
  record: RemoteMachineRecord,
  patch: MachineUpdateInput,
  now: string,
): RemoteMachineRecord {
  return remoteMachineRecordSchema.parse({ ...record, ...patch, updated_at: now });
}

/** True for the implicit local machine id. */
export function isLocalMachineId(id: string): boolean {
  return id === MACHINE_ID_LOCAL;
}

// ---------------------------------------------------------------------------
// Home config access
// ---------------------------------------------------------------------------

/**
 * Read the raw home config object. A missing file reads as `{}`; an unreadable
 * or non-object file throws so a mutation can never clobber it.
 */
function readHomeConfig(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Home config is not readable JSON (${filePath}): ${String(error)}`, {
      cause: error,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Home config is not a JSON object (${filePath})`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface MachineRegistryOptions {
  /** Home config path override. Defaults to `~/.orchid/config.json`. */
  readonly homeConfigPath?: string;
  readonly idFactory?: () => string;
  /** ISO-timestamp clock override (tests). */
  readonly now?: () => string;
  readonly hostname?: () => string;
  readonly platform?: () => NodeJS.Platform;
}

/**
 * Local-machine-first CRUD over the home config `machines` section.
 *
 * Read-modify-write cycles run under `withConfigSaveLock` so registry writes
 * cannot race `config:save`.
 */
export class MachineRegistry {
  private readonly homeConfigPath: string;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly hostname: () => string;
  private readonly platform: () => NodeJS.Platform;

  constructor(options: MachineRegistryOptions = {}) {
    this.homeConfigPath = options.homeConfigPath ?? HOME_CONFIG_PATH;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.hostname = options.hostname ?? os.hostname;
    this.platform = options.platform ?? (() => os.platform());
  }

  /** The implicit local machine. */
  localMachine(): LocalMachineRecord {
    return buildLocalMachine(this.hostname(), this.platform());
  }

  /** Stored remote machines in persisted order. */
  async listRemotes(): Promise<RemoteMachineRecord[]> {
    const home = readHomeConfig(this.homeConfigPath);
    return parseRemoteMachineRecords(home['machines']);
  }

  /** Full machine list: local machine first, then remotes sorted by label. */
  async list(): Promise<MachineRecord[]> {
    return orderMachines(this.localMachine(), await this.listRemotes());
  }

  /**
   * Validate and append one remote machine. Rejects a duplicate id and the
   * reserved `local` id (which can never be stored).
   */
  async create(input: MachineCreateInput): Promise<RemoteMachineRecord> {
    const now = this.now();
    const machine = remoteMachineRecordSchema.parse({
      ...input,
      id: input.id ?? this.idFactory(),
      kind: 'ssh',
      created_at: now,
      updated_at: now,
    });
    return this.commit((current) => {
      if (current.some((item) => item.id === machine.id)) {
        throw new Error(`Duplicate machine id '${machine.id}'`);
      }
      return { records: [...current, machine], value: machine };
    });
  }

  /**
   * Patch editable fields of one remote machine by id. The local machine is
   * immutable and unknown ids reject.
   */
  async update(id: string, patch: MachineUpdateInput): Promise<RemoteMachineRecord> {
    if (isLocalMachineId(id)) {
      throw new Error('The local machine cannot be modified.');
    }
    return this.commit((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`Unknown machine '${id}'`);
      const updated = applyMachinePatch(current[index], patch, this.now());
      const records = [...current];
      records[index] = updated;
      return { records, value: updated };
    });
  }

  /**
   * Delete one remote machine by id. The local machine is immutable; an
   * unknown id deletes nothing and reports `not_found`.
   */
  async remove(id: string): Promise<
    { status: 'deleted'; machine: RemoteMachineRecord } | { status: 'not_found' }
  > {
    if (isLocalMachineId(id)) {
      throw new Error('The local machine cannot be deleted.');
    }
    return this.commit<
      { status: 'deleted'; machine: RemoteMachineRecord } | { status: 'not_found' }
    >((current) => {
      const machine = current.find((item) => item.id === id);
      if (!machine) {
        return { records: current, value: { status: 'not_found' as const } };
      }
      return {
        records: current.filter((item) => item.id !== id),
        value: { status: 'deleted' as const, machine },
      };
    });
  }

  /**
   * Run one mutation inside the config save lock: read the home config, parse
   * the `machines` section, apply the mutation, then write the patched file
   * and mirror the result into the cached config.
   */
  private commit<T>(
    mutate: (
      current: RemoteMachineRecord[],
    ) => { records: RemoteMachineRecord[]; value: T },
  ): Promise<T> {
    return withConfigSaveLock(async () => {
      const home = readHomeConfig(this.homeConfigPath);
      const current = parseRemoteMachineRecords(home['machines']);
      const { records, value } = mutate(current);
      home['machines'] = records;
      atomicWriteJson(this.homeConfigPath, home);
      getConfig().machines = records;
      return value;
    });
  }
}

let registry: MachineRegistry | null = null;

/** Process-wide machine registry (home config backed). */
export function getMachineRegistry(): MachineRegistry {
  if (registry === null) {
    registry = new MachineRegistry();
  }
  return registry;
}

/** Drop the process-wide registry so the next call rebuilds it. For tests. */
export function _resetMachineRegistryForTests(): void {
  registry = null;
}
