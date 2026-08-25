/**
 * Config schema — main-process facade for types, defaults, and validation.
 *
 * The zod schemas live in shared/types/config-schema.ts (single source shared
 * with the host protocol registry, shared/host/protocol.ts) so the shared
 * layer never imports main; this module re-exports them unchanged and keeps
 * the load-time helpers only main uses.
 */
import { configSchema } from '../../shared/types/config-schema';
import type {
  Config as BoundaryConfig,
} from '../../shared/types/ipc-boundary';
import type {
  ConfigDeepPartialInput as DeepPartialInput,
} from '../../shared/types/config-schema';

export {
  AGENTS_MD_ENFORCE_POLICIES,
  agentsMdConfigSchema,
  compactionConfigSchema,
  compactionScopeSchema,
  compactionSubagentsScopeSchema,
  configReadProjectSchema,
  configSaveProjectSchema,
  configSaveSchema,
  configSchema,
  indexRefreshConfigSchema,
  machinesConfigSchema,
  permissionRuleSchema,
  permissionsConfigSchema,
  ragConfigSchema,
  subagentsConfigSchema,
} from '../../shared/types/config-schema';
export type { ConfigDeepPartialInput } from '../../shared/types/config-schema';

export { COMPACTION_MODES } from '../../shared/types/message';

export type {
  Config,
  RAGConfig,
  AgentsMdConfig,
  AgentsMdEnforcePolicy,
  IndexRefreshConfig,
  SubagentsConfig,
  CompactionConfig,
  CompactionScopeConfig,
  CompactionMode,
} from '../../shared/types/ipc-boundary';
export { modelSelectionSchema, type ModelSelection } from '../../shared/types/provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a full default Config (all fields populated). */
export function defaults(): BoundaryConfig {
  return configSchema.parse({});
}

/**
 * Parse a raw JSON value that may be a partial config (e.g. a project config
 * that only specifies a few overrides).  Returns a deep-partial object
 * suitable for merging with defaults.
 */
export function parsePartial(raw: unknown): DeepPartialInput {
  return configSchema.deepPartial().parse(raw);
}
