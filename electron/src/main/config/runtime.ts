import type { Config } from './schema';
import { getConfig } from './loader';

/**
 * Return the active layered config without hydrating credentials. Trusted
 * drivers resolve connection-scoped secrets through CredentialVault in the
 * Electron main process, never through project or renderer configuration.
 */
export async function getRuntimeConfig(): Promise<Config> {
  return getConfig();
}
