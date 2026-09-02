/**
 * Plain-Node SecureStorageAdapter for the headless `orchid-agent` daemon.
 *
 * The daemon has no OS keychain integration in v1, so the adapter reports
 * encryption unavailable and every encrypt/decrypt attempt throws the vault's
 * typed unavailable error: stored API-key credentials fail closed with a
 * clean message. Environment credential references never reach the adapter —
 * `ProviderRuntime.resolveCredential` resolves them from `process.env` before
 * touching the vault — so remote hosts authenticate via
 * `~/.orchid/config.json` connections plus environment variables (plan
 * 2026-08-23-001, "Env-referenced credentials on headless hosts").
 */
import type { SecureStorageAdapter } from './vault';
import { SecureStorageUnavailableError } from './vault';

function unavailable(): never {
  throw new SecureStorageUnavailableError({ available: false, reason: 'unavailable' });
}

/** Vault storage for plain-Node hosts: no secret storage, clean typed errors. */
export const nodeSecureStorageAdapter: SecureStorageAdapter = {
  isEncryptionAvailable(): boolean {
    return false;
  },
  encryptString(): Buffer {
    unavailable();
  },
  decryptString(): string {
    unavailable();
  },
};
