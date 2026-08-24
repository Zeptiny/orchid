/**
 * TOFU host-key trust for SSH remote machines (issue #112, plan unit U7).
 *
 * Adding a machine scans its host keys out-of-band (`ssh-keyscan`), computes
 * fingerprints (SHA256 over the key blob — `ssh-keygen -lf` equivalent, no
 * subprocess), and pins the raw key lines into a per-machine known-hosts file
 * under `~/.orchid/machines/<id>/`. Connections then enforce the pin via ssh
 * itself (`StrictHostKeyChecking=yes`); `verifyPinnedKeys` only produces the
 * drift report the UI shows when a host's keys change.
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOME_CONFIG_DIR } from '../config/loader';

/** Default exec timeout for `ssh-keyscan` (ms). */
const KEYSCAN_TIMEOUT_MS = 30_000;

/** One scanned/pinned host key with its `ssh-keygen -lf`-style fingerprint. */
export interface HostKeyFingerprint {
  /** Key algorithm, e.g. `ssh-ed25519` (second field of the key line). */
  readonly algorithm: string;
  /** `SHA256:<unpadded-base64>` over the base64-decoded key blob. */
  readonly fingerprintSha256: string;
  /** The raw `host keytype blob [comment]` line. */
  readonly rawLine: string;
}

/** Typed ssh-keyscan failure. */
export class HostKeyScanError extends Error {
  readonly reason: 'unreachable' | 'no-keys';
  readonly stderrExcerpt: string;

  constructor(reason: 'unreachable' | 'no-keys', message: string, stderrExcerpt = '') {
    super(message);
    this.name = 'HostKeyScanError';
    this.reason = reason;
    this.stderrExcerpt = stderrExcerpt;
  }
}

/** Injectable exec (tests fake the keyscan output). */
export type KeyScanExecFn = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

function defaultExecFile(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: KEYSCAN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(error.message) as Error & { stderr: string };
          wrapped.stderr = String(stderr ?? '');
          reject(wrapped);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * Run `ssh-keyscan -p <port> <host>` and return the raw key lines (trimmed,
 * non-empty, comments stripped). Rejects with `HostKeyScanError` when the host
 * cannot be scanned (`unreachable`) or the scan yields no keys (`no-keys`).
 */
export async function scanHostKeys(
  host: string,
  port: number,
  options: { execFn?: KeyScanExecFn } = {},
): Promise<string[]> {
  const execFn = options.execFn ?? defaultExecFile;
  let stdout: string;
  try {
    ({ stdout } = await execFn('ssh-keyscan', ['-p', String(port), host]));
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    const detail = error instanceof Error ? error.message : String(error);
    throw new HostKeyScanError(
      'unreachable',
      `ssh-keyscan failed for ${host}:${port}: ${detail}`,
      stderr,
    );
  }
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (lines.length === 0) {
    throw new HostKeyScanError('no-keys', `ssh-keyscan returned no host keys for ${host}:${port}`);
  }
  return lines;
}

/** Compute the SHA256 fingerprint of a base64 key blob; null for empty input. */
export function fingerprintKeyBlob(base64Blob: string): string | null {
  const blob = Buffer.from(base64Blob, 'base64');
  if (blob.length === 0) return null;
  const digest = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** Parse `host keytype blob [comment]` (marker-prefixed lines tolerated). */
function parseKeyLine(line: string): { algorithm: string; blob: string } | null {
  const fields = line.trim().split(/\s+/);
  const start = fields[0]?.startsWith('@') === true ? 1 : 0;
  const algorithm = fields[start + 1];
  const blob = fields[start + 2];
  if (algorithm === undefined || blob === undefined) return null;
  return { algorithm, blob };
}

/**
 * Fingerprint every parseable key line. Malformed lines are skipped: keyscan
 * output is operator-visible, so the pinning flow reports the parsed set
 * rather than failing the whole scan on one bad line.
 */
export function fingerprintsFromScan(lines: readonly string[]): HostKeyFingerprint[] {
  const fingerprints: HostKeyFingerprint[] = [];
  for (const rawLine of lines) {
    const parsed = parseKeyLine(rawLine);
    if (parsed === null) continue;
    const fingerprintSha256 = fingerprintKeyBlob(parsed.blob);
    if (fingerprintSha256 === null) continue;
    fingerprints.push({ algorithm: parsed.algorithm, fingerprintSha256, rawLine: rawLine.trim() });
  }
  return fingerprints;
}

/** Per-machine known-hosts path: `<homeDir>/machines/<machineId>/known_hosts`. */
export function knownHostsPath(machineId: string, homeDir: string = HOME_CONFIG_DIR): string {
  return path.join(homeDir, 'machines', machineId, 'known_hosts');
}

export interface WriteKnownHostsOptions {
  /** Base dir override (tests); defaults to `~/.orchid`. */
  readonly homeDir?: string;
  /**
   * Canonical hostname to write; with `port`, replaces each line's host token
   * (`[host]:port` for non-22 ports, bare `host` otherwise, per OpenSSH
   * format). Omitted: lines are pinned exactly as keyscan produced them
   * (keyscan itself emits `[host]:port` for non-default ports).
   */
  readonly host?: string;
  readonly port?: number;
}

/**
 * Pin scanned key lines for one machine: dir 0700, file 0600. Returns the
 * written path. Rejects empty input — an empty pin file must never satisfy
 * the connect-time pinned-keys check.
 */
export function writeKnownHosts(
  machineId: string,
  lines: readonly string[],
  options: WriteKnownHostsOptions = {},
): string {
  const filePath = knownHostsPath(machineId, options.homeDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);

  const hostToken =
    options.host === undefined
      ? null
      : (options.port ?? 22) === 22
        ? options.host
        : `[${options.host}]:${options.port ?? 22}`;

  const entries = lines
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      if (hostToken === null) return line;
      const fields = line.split(/\s+/);
      const start = fields[0]?.startsWith('@') === true ? 1 : 0;
      return [hostToken, ...fields.slice(start + 1)].join(' ');
    });

  if (entries.length === 0) {
    throw new Error(`Cannot pin an empty host-key set for machine '${machineId}'`);
  }

  fs.writeFileSync(filePath, `${entries.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

/** Read the pinned fingerprints back; a missing file reads as empty. */
export function readPinnedKeys(machineId: string, homeDir?: string): HostKeyFingerprint[] {
  let raw: string;
  try {
    raw = fs.readFileSync(knownHostsPath(machineId, homeDir), 'utf-8');
  } catch {
    return [];
  }
  return fingerprintsFromScan(raw.split('\n'));
}

/** Drift between the pinned key set and a current scan, for the UI report. */
export interface HostKeyDrift {
  /** Present in the scan but not pinned. */
  readonly added: HostKeyFingerprint[];
  /** Pinned but absent from the scan. */
  readonly removed: HostKeyFingerprint[];
  readonly unchanged: boolean;
}

const fingerprintKey = (key: HostKeyFingerprint): string =>
  `${key.algorithm}|${key.fingerprintSha256}`;

/**
 * Pure diff of a current scan against the pinned file (ssh itself enforces
 * the pin at connect time; this only powers the drift report).
 */
export function verifyPinnedKeys(
  machineId: string,
  currentScan: readonly string[],
  options: { homeDir?: string } = {},
): HostKeyDrift {
  const pinned = readPinnedKeys(machineId, options.homeDir);
  const pinnedKeys = new Set(pinned.map(fingerprintKey));
  const current = fingerprintsFromScan(currentScan);
  const currentKeys = new Set(current.map(fingerprintKey));
  const added = current.filter((key) => !pinnedKeys.has(fingerprintKey(key)));
  const removed = pinned.filter((key) => !currentKeys.has(fingerprintKey(key)));
  return { added, removed, unchanged: added.length === 0 && removed.length === 0 };
}
