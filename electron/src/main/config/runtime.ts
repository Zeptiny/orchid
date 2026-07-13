import type { Config } from './schema';
import { getConfig } from './loader';

/**
 * Return the active layered config without hydrating retired alias-keyed
 * credentials. U3 replaces this compatibility helper with a
 * connection-scoped credential vault.
 */
export async function getRuntimeConfig(): Promise<Config> {
  return getConfig();
}
