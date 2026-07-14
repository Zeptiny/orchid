/**
 * Config system — public API.
 *
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

export {
  deepMerge,
  deepMergeProviderDict,
  mergeConfigUpdates,
  mergeLayers,
  applyEnvOverrides,
  isUnsafeKey,
} from './merge';

export { validateConfig } from './validation';

export {
  loadConfig,
  getConfigDiagnostics,
  ensureHomeConfig,
  ConfigManager,
  getConfig,
  getTierModelSelection,
  atomicWriteJson,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
  HOME_AGENTS_DIR,
  HOME_SKILLS_DIR,
  HOME_PERSONALITIES_DIR,
  PROJECT_CONFIG_NAME,
  type LoadConfigOptions,
} from './loader';

export type { ConfigDiagnostic } from '../../shared/types/ipc-boundary';
