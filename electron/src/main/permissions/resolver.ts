import path from 'node:path';
import {
  RISK_CLASS_DEFAULTS,
  FILE_TOOLS,
  FILE_TOOL_DEFAULTS,
  type PermissionMode,
  type RiskClass,
  type ToolScope,
  type ResolvedToolScope,
  type PermissionResolution,
} from '../../shared/types/permission';
import type { Config, PermissionRule } from '../../shared/types/ipc-boundary';
import type { ToolDefinition } from '../tools/types';
import {
  canonicalizeEffectivePath,
  canonicalizeExistingPath,
  isPathContainedIn,
} from '../project/path';

// Re-export the shared source-of-truth constants so existing consumers that
// import them from the resolver (tool-dispatch.ts, permissions/index.ts) keep
// working without duplicating the definitions here.
export { RISK_CLASS_DEFAULTS, FILE_TOOLS, FILE_TOOL_DEFAULTS };

// The cwd is frozen per turn, so canonicalizing it on every file-tool call
// repeats a blocking fs.realpathSync.native on the main-process event loop.
// Memoize the result in a small bounded cache keyed by the resolved cwd.
// Per-target symlink resolution (canonicalizeEffectivePath) stays live.
const canonicalPathCache = new Map<string, string | null>();
const CANONICAL_CACHE_MAX = 256;

function canonicalizeExistingPathCached(candidate: string): string | null {
  const key = path.resolve(candidate);
  if (canonicalPathCache.has(key)) return canonicalPathCache.get(key) ?? null;
  const result = canonicalizeExistingPath(key);
  if (canonicalPathCache.size >= CANONICAL_CACHE_MAX) canonicalPathCache.clear();
  canonicalPathCache.set(key, result);
  return result;
}

/**
 * Resolve declarative, validated path intents once for permission and later
 * instruction preflight. No tool-name or input-key parsing belongs here.
 */
export function resolveToolScope(
  definition: ToolDefinition,
  validatedInput: unknown,
  cwd: string,
): ResolvedToolScope | undefined {
  if (!definition.inputPathIntents) return undefined;

  const canonicalCwd = canonicalizeExistingPathCached(cwd);
  const declared = definition.inputPathIntents(validatedInput);
  const intents = declared.map((intent) => {
    const resolvedPath = path.resolve(cwd, intent.userPath);
    return {
      ...intent,
      resolvedPath,
      effectivePath: canonicalizeEffectivePath(resolvedPath),
    };
  });
  const scope: ToolScope = canonicalCwd !== null && intents.every(
    (intent) => intent.effectivePath !== null && isPathContainedIn(intent.effectivePath, canonicalCwd),
  ) ? 'inside' : 'outside';
  return { scope, intents };
}

function resolvePermissionRule(
  rule: PermissionRule,
  scope: ToolScope | undefined,
): PermissionMode {
  if (typeof rule === 'string') return rule;
  if (scope !== undefined) return rule[scope];
  return rule.inside;
}

function resolveConfiguredRule(
  toolName: string,
  permissions: Config['permissions'],
): PermissionRule | undefined {
  const exact = permissions?.[toolName];
  if (exact !== undefined) return exact;

  const mcpPrefix = 'mcp::';
  if (!toolName.startsWith(mcpPrefix)) return undefined;
  const serverEnd = toolName.indexOf('::', mcpPrefix.length);
  if (serverEnd < 0) return undefined;

  const serverName = toolName.slice(mcpPrefix.length, serverEnd);
  if (serverName === '') return undefined;
  return permissions?.[`${mcpPrefix}${serverName}::*`];
}

/** Resolve the effective permission mode for a tool call and where it came from. */
export function resolvePermission(
  toolName: string,
  riskClass: RiskClass,
  config: Config,
  sessionOverride: PermissionMode | null,
  resolvedScope?: ResolvedToolScope,
): PermissionResolution {
  const scope = resolvedScope?.scope;

  let mode: PermissionMode;
  let source: PermissionResolution['source'] = 'tool-default';

  const fileDefault = FILE_TOOL_DEFAULTS[toolName];
  if (fileDefault && scope !== undefined) {
    mode = fileDefault[scope];
  } else {
    mode = RISK_CLASS_DEFAULTS[riskClass];
  }

  const configRule = resolveConfiguredRule(toolName, config.permissions);
  if (configRule !== undefined) {
    mode = resolvePermissionRule(configRule, scope);
    source = 'project-config';
  }

  if (sessionOverride !== null) {
    mode = sessionOverride;
    source = 'session-selector';
  }

  return { mode, source, scope };
}

/** Whether a tool call's resolved mode clears the risk-class floor (i.e. is not auto-allowed). */
export function passesRiskClassFloor(
  toolName: string,
  riskClass: RiskClass,
  config: Config,
  resolvedScope?: ResolvedToolScope,
): boolean {
  const resolution = resolvePermission(toolName, riskClass, config, null, resolvedScope);
  return resolution.mode !== 'allow';
}
