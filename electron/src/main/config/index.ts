/**
 * Config system — public API.
 *
 * Note: keychain.ts is intentionally NOT re-exported here because it imports
 * `electron` (safeStorage) which is unavailable in non-Electron test contexts.
 * Import directly from `./keychain` when needed.
 */
export {
  configSchema,
  ragConfigSchema,
  defaults,
  parsePartial,
  type Config,
  type RAGConfig,
  type ConfigDeepPartialInput,
} from './schema';

export { deepMerge, deepMergeProviderDict, mergeLayers, applyEnvOverrides } from './merge';

export { validateConfig } from './validation';

export {
  loadConfig,
  ensureHomeConfig,
  ConfigManager,
  getConfig,
  getModelForTier,
  atomicWriteJson,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
  HOME_AGENTS_DIR,
  HOME_SKILLS_DIR,
  HOME_PERSONALITIES_DIR,
  PROJECT_CONFIG_NAME,
  type LoadConfigOptions,
} from './loader';
