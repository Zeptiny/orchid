/**
 * Host-key trust tests (issue #112, plan unit U7).
 *
 * Fingerprints are checked against a real generated key set whose
 * SHA256 values were additionally verified with `ssh-keygen -lf` at
 * authoring time; the expected values are also recomputed inline from the
 * same blobs so the assertions stay self-consistent.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HostKeyScanError,
  fingerprintsFromScan,
  knownHostsPath,
  removeKnownHosts,
  scanHostKeys,
  verifyPinnedKeys,
  writeKnownHosts,
  type KeyScanExecFn,
} from '../../src/main/machines/host-key';
import {
  MachineHostKeyFlow,
  MachineHostKeyFlowError,
} from '../../src/main/machines/host-key-flow';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const HOST = 'build.example.com';
const T0 = '2026-08-23T00:00:00.000Z';

// Real throwaway key pairs (public lines only; no private material).
const ED25519_LINE =
  'build.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPHhT8R1+f81M2hvSEhe/iCDDHV3m79vicl5uXQ0IZRM test-ed25519';
const ED25519_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIPHhT8R1+f81M2hvSEhe/iCDDHV3m79vicl5uXQ0IZRM';
const ED25519_FP = 'SHA256:29lbW1HkKXIbM7tD/NQSIN+gEa7OqARwZ9EC+aNMOSk';

const RSA_LINE =
  'build.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCvGHIP0CZ7Dr/+eLv5SlHO8aooj9eVt6gP8vErTnBnwcTSQ28lsW9ebREZdF+19s8V3WyBNtmkPJFGnM46ol/VMEsyphKrW+jb7ShT4QTtLCUoK7vZ/H8wSJ5n33ZAwC/z6N8OtQ4V5Poi30/Bwy0sDIL9qqBR72CKEMovS091wo1MAaZrmltHywzFSjh5/CU5Zr3iGbFKmEU+fnlPTTbLpFTYhiI5CMEeI6gfZ3M3do2LlFOanKlu5zsJnO4xM4HaAiC8lkLgBRfOp46D+EJvB/Q0ss2c02+n/LKAYeeJtvsLRDLvISRUNhfJ6MAlk67757U7rSYi1XUI658Vk3mz test-rsa';
const RSA_BLOB =
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQCvGHIP0CZ7Dr/+eLv5SlHO8aooj9eVt6gP8vErTnBnwcTSQ28lsW9ebREZdF+19s8V3WyBNtmkPJFGnM46ol/VMEsyphKrW+jb7ShT4QTtLCUoK7vZ/H8wSJ5n33ZAwC/z6N8OtQ4V5Poi30/Bwy0sDIL9qqBR72CKEMovS091wo1MAaZrmltHywzFSjh5/CU5Zr3iGbFKmEU+fnlPTTbLpFTYhiI5CMEeI6gfZ3M3do2LlFOanKlu5zsJnO4xM4HaAiC8lkLgBRfOp46D+EJvB/Q0ss2c02+n/LKAYeeJtvsLRDLvISRUNhfJ6MAlk67757U7rSYi1XUI658Vk3mz';
const RSA_FP = 'SHA256:M/oY/sHojGfAWqaZ1wd5Y1BGF40xP8SGCx9s/UG+CI0';

const ECDSA_LINE =
  'build.example.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBMAoRWMuE5UDY30mJvaCLSRSwGJnOBBhV5B10oUWmGI5lHoYqN+GEfAvmpCiLeTZwM1bG03FNwOvtEqfMTsaAYI= test-ecdsa';
const ECDSA_BLOB =
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBMAoRWMuE5UDY30mJvaCLSRSwGJnOBBhV5B10oUWmGI5lHoYqN+GEfAvmpCiLeTZwM1bG03FNwOvtEqfMTsaAYI=';
const ECDSA_FP = 'SHA256:AvLJ1Q3cL1S5jLZ9wIThd91IazoXhVogtODBLVY13GI';

/** Inline `ssh-keygen -lf`-equivalent computation for self-consistency. */
function expectedFingerprint(blob: string): string {
  return `SHA256:${crypto
    .createHash('sha256')
    .update(Buffer.from(blob, 'base64'))
    .digest('base64')
    .replace(/=+$/, '')}`;
}

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-machines-host-key-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ── fingerprintsFromScan ─────────────────────────────────────────────────────

describe('fingerprintsFromScan', () => {
  it('parses a real ed25519 key line into algorithm + SHA256 fingerprint', () => {
    expect(expectedFingerprint(ED25519_BLOB)).toBe(ED25519_FP);
    expect(fingerprintsFromScan([ED25519_LINE])).toEqual([
      { algorithm: 'ssh-ed25519', fingerprintSha256: ED25519_FP, rawLine: ED25519_LINE },
    ]);
  });

  it('parses multi-algorithm scans (rsa, ecdsa)', () => {
    expect(expectedFingerprint(RSA_BLOB)).toBe(RSA_FP);
    expect(expectedFingerprint(ECDSA_BLOB)).toBe(ECDSA_FP);
    expect(
      fingerprintsFromScan([RSA_LINE, ECDSA_LINE]).map(
        (key) => [key.algorithm, key.fingerprintSha256] as const,
      ),
    ).toEqual([
      ['ssh-rsa', RSA_FP],
      ['ecdsa-sha2-nistp256', ECDSA_FP],
    ]);
  });

  it('skips comments, blank, and malformed lines', () => {
    expect(
      fingerprintsFromScan(['# comment', '', '   ', 'only-host keytype', ED25519_LINE]),
    ).toEqual([{ algorithm: 'ssh-ed25519', fingerprintSha256: ED25519_FP, rawLine: ED25519_LINE }]);
  });
});

// ── scanHostKeys ─────────────────────────────────────────────────────────────

describe('scanHostKeys', () => {
  it('runs ssh-keyscan with the port and returns cleaned key lines', async () => {
    const calls: Array<[string, string[]]> = [];
    const execFn: KeyScanExecFn = async (command, args) => {
      calls.push([command, [...args]]);
      return {
        stdout: `# build.example.com:2222 SSH-2.0-OpenSSH_9.6\n\n${RSA_LINE}\n${ED25519_LINE}\n`,
        stderr: '',
      };
    };
    await expect(scanHostKeys(HOST, 2222, { execFn })).resolves.toEqual([RSA_LINE, ED25519_LINE]);
    expect(calls).toEqual([['ssh-keyscan', ['-p', '2222', HOST]]]);
  });

  it('rejects with a typed no-keys error when the scan returns nothing usable', async () => {
    const execFn: KeyScanExecFn = async () => ({ stdout: '# only comments\n', stderr: '' });
    const error = await scanHostKeys(HOST, 22, { execFn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostKeyScanError);
    expect((error as HostKeyScanError).reason).toBe('no-keys');
    expect((error as HostKeyScanError).message).toContain('build.example.com:22');
  });

  it('rejects with a typed unreachable error carrying the stderr excerpt', async () => {
    const execFn: KeyScanExecFn = async () => {
      throw Object.assign(new Error('spawn failed'), { stderr: 'ssh-keyscan: no route' });
    };
    const error = await scanHostKeys(HOST, 22, { execFn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostKeyScanError);
    expect((error as HostKeyScanError).reason).toBe('unreachable');
    expect((error as HostKeyScanError).stderrExcerpt).toBe('ssh-keyscan: no route');
  });
});

// ── writeKnownHosts / knownHostsPath ─────────────────────────────────────────

describe('writeKnownHosts', () => {
  it('writes 0600 file in a 0700 dir with [host]:port tokens for non-22 ports', () => {
    const filePath = writeKnownHosts('build-1', [ED25519_LINE, RSA_LINE], {
      homeDir,
      host: HOST,
      port: 2222,
    });

    expect(filePath).toBe(knownHostsPath('build-1', homeDir));
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    const [first, second] = fs.readFileSync(filePath, 'utf-8').split('\n');
    expect(first?.startsWith(`[${HOST}]:2222 ssh-ed25519 ${ED25519_BLOB} `)).toBe(true);
    expect(second?.startsWith(`[${HOST}]:2222 ssh-rsa ${RSA_BLOB} `)).toBe(true);
  });

  it('writes bare host tokens for port 22 and preserves keyscan lines verbatim', () => {
    const withBracketToken = `[${HOST}]:2222 ssh-ed25519 ${ED25519_BLOB} test-ed25519`;
    const filePath = writeKnownHosts('build-1', [withBracketToken], { homeDir });
    expect(fs.readFileSync(filePath, 'utf-8').trim()).toBe(withBracketToken);

    const bare = writeKnownHosts('build-1', [ED25519_LINE], { homeDir, host: HOST, port: 22 });
    expect(fs.readFileSync(bare, 'utf-8').trim()).toBe(
      `${HOST} ssh-ed25519 ${ED25519_BLOB} test-ed25519`,
    );
  });

  it('refuses to pin an empty key set', () => {
    expect(() => writeKnownHosts('build-1', [], { homeDir })).toThrow(/empty host-key set/);
    expect(() => writeKnownHosts('build-1', ['   ', '# comment'], { homeDir })).toThrow(
      /empty host-key set/,
    );
    expect(fs.existsSync(knownHostsPath('build-1', homeDir))).toBe(false);
  });
});

// ── removeKnownHosts / MachineHostKeyFlow.unpin ──────────────────────────────

describe('removeKnownHosts', () => {
  it('deletes the pin file and is a no-op when absent', () => {
    writeKnownHosts('build-1', [ED25519_LINE], { homeDir });
    const filePath = knownHostsPath('build-1', homeDir);
    expect(fs.existsSync(filePath)).toBe(true);

    removeKnownHosts('build-1', homeDir);
    expect(fs.existsSync(filePath)).toBe(false);

    // Idempotent: an unpinned machine must never fail the update path.
    expect(() => removeKnownHosts('build-1', homeDir)).not.toThrow();
  });
});

describe('MachineHostKeyFlow.unpin', () => {
  const machine: RemoteMachineRecord = {
    id: 'build-1',
    label: 'Build server',
    kind: 'ssh',
    host: HOST,
    port: 22,
    user: '',
    agentCommand: 'orchid-agent',
    authMethod: 'key',
    created_at: T0,
    updated_at: T0,
  };

  it('drops the pin AND the cached scan so the TOFU gate re-arms', async () => {
    writeKnownHosts('build-1', [ED25519_LINE], { homeDir });
    const flow = new MachineHostKeyFlow({
      homeDir,
      execFn: async () => ({ stdout: `${ED25519_LINE}\n`, stderr: '' }),
    });
    expect(await flow.scan(machine)).toHaveLength(1);
    expect(flow.pinned('build-1')).toBe(true);

    flow.unpin('build-1');

    // The pin file is gone and no cached scan can be confirmed into a new
    // pin for the changed destination without a fresh user-reviewed scan.
    expect(flow.pinned('build-1')).toBe(false);
    expect(fs.existsSync(knownHostsPath('build-1', homeDir))).toBe(false);
    expect(() => flow.confirm('build-1')).toThrow(MachineHostKeyFlowError);
  });
});

// ── verifyPinnedKeys ─────────────────────────────────────────────────────────

describe('verifyPinnedKeys', () => {
  it('reports added and removed keys between pin and scan', () => {
    writeKnownHosts('build-1', [ED25519_LINE, RSA_LINE], { homeDir, host: HOST, port: 22 });

    const drift = verifyPinnedKeys('build-1', [ED25519_LINE, ECDSA_LINE], { homeDir });

    expect(drift.added.map((key) => [key.algorithm, key.fingerprintSha256])).toEqual([
      ['ecdsa-sha2-nistp256', ECDSA_FP],
    ]);
    expect(drift.removed.map((key) => [key.algorithm, key.fingerprintSha256])).toEqual([
      ['ssh-rsa', RSA_FP],
    ]);
    expect(drift.unchanged).toBe(false);
  });

  it('reports unchanged for an identical scan', () => {
    writeKnownHosts('build-1', [ED25519_LINE], { homeDir, host: HOST, port: 22 });
    expect(verifyPinnedKeys('build-1', [ED25519_LINE], { homeDir })).toEqual({
      added: [],
      removed: [],
      unchanged: true,
    });
  });

  it('treats a missing pin file as everything added', () => {
    const drift = verifyPinnedKeys('never-pinned', [ED25519_LINE], { homeDir });
    expect(drift.added).toHaveLength(1);
    expect(drift.removed).toEqual([]);
    expect(drift.unchanged).toBe(false);
  });

  it('flags a replaced key for the same algorithm', () => {
    writeKnownHosts('build-1', [ED25519_LINE], { homeDir, host: HOST, port: 22 });
    const drift = verifyPinnedKeys(
      'build-1',
      [`build.example.com ssh-ed25519 ${RSA_BLOB} attacker-ed25519`],
      { homeDir },
    );
    expect(drift.unchanged).toBe(false);
    expect(drift.removed[0]?.fingerprintSha256).toBe(ED25519_FP);
    expect(drift.added[0]?.fingerprintSha256).toBe(RSA_FP);
  });
});
