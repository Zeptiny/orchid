import type { Config } from './schema';
import { injectKeychainKeys } from './keychain';
import { getConfig } from './loader';

/** Return the active layered config with provider API keys restored in memory. */
export async function getRuntimeConfig(): Promise<Config> {
  const config = getConfig();
  const hydrated = await injectKeychainKeys(
    config as unknown as Record<string, unknown>,
  );
  return hydrated as unknown as Config;
}
