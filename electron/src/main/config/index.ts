/**
 * Config system — public API.
 *
 */
export {
  configSchema,
  ragConfigSchema,
  agentsMdConfigSchema,
  indexRefreshConfigSchema,
  subagentsConfigSchema,
  compactionScopeSchema,
  compactionSubagentsScopeSchema,
  compactionConfigSchema,
  COMPACTION_MODES,
  defaults,
  parsePartial,
  type Config,
  type RAGConfig,
  type AgentsMdConfig,
  type AgentsMdEnforcePolicy,
  type IndexRefreshConfig,
  type SubagentsConfig,
  type CompactionConfig,
  type CompactionScopeConfig,
  type CompactionMode,
  type ConfigDeepPartialInput,
} from './schema';

export {
  deepMerge,
  deepMergeNamedEntryDict,
  mergeConfigUpdates,
  mergeLayers,
  applyEnvOverrides,
  isUnsafeKey,
} from './merge';

export { validateConfig } from './validation';

export {
  loadConfig,
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
