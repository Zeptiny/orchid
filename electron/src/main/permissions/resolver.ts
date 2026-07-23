import fs from 'node:fs';
import path from 'node:path';
import {
  RISK_CLASS_DEFAULTS,
  FILE_TOOLS,
  FILE_TOOL_DEFAULTS,
  type PermissionMode,
  type RiskClass,
  type ToolScope,
  type PermissionResolution,
} from '../../shared/types/permission';
import type { Config, PermissionRule } from '../../shared/types/ipc-boundary';

// Re-export the shared source-of-truth constants so existing consumers that
// import them from the resolver (tool-dispatch.ts, permissions/index.ts) keep
// working without duplicating the definitions here.
export { RISK_CLASS_DEFAULTS, FILE_TOOLS, FILE_TOOL_DEFAULTS };

const PATCH_FILE_PATTERN = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const PATCH_MOVE_TO_PATTERN = /^\*\*\* Move to: (.+)$/gm;

function extractPathsFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName === 'apply_patch') {
    const patch = args['patch'];
    if (typeof patch !== 'string') return [];
    const paths: string[] = [];
    for (const match of patch.matchAll(PATCH_FILE_PATTERN)) {
      const filePath = match[1]?.trim();
      if (filePath) paths.push(filePath);
    }
    // Also containment-check `*** Move to:` destinations so a patch that moves
    // a file outside the workspace is not classified 'inside'.
    for (const match of patch.matchAll(PATCH_MOVE_TO_PATTERN)) {
      const moveToPath = match[1]?.trim();
      if (moveToPath) paths.push(moveToPath);
    }
    return paths;
  }

  const paths: string[] = [];
  for (const key of ['file_path', 'path', 'directory_path']) {
    const value = args[key];
    if (typeof value === 'string') paths.push(value);
  }
  return paths;
}

function isPathContainedIn(resolved: string, cwd: string): boolean {
  return resolved === cwd || resolved.startsWith(cwd + path.sep);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function canonicalizeEffectivePath(candidate: string): string | null {
  let current = path.resolve(candidate);
  const missingParts: string[] = [];

  while (true) {
    try {
      const existingParent = fs.realpathSync.native(current);
      return path.resolve(existingParent, ...missingParts);
    } catch (error) {
      if (!isMissingPathError(error)) return null;

      try {
        fs.lstatSync(current);
        return null;
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) return null;
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      missingParts.unshift(path.basename(current));
      current = parent;
    }
  }
}

function canonicalizeExistingPath(candidate: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(candidate));
  } catch {
    return null;
  }
}

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

/** Resolve a file tool's workspace scope ('inside' | 'outside') from its args. */
export function resolveToolScope(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): ToolScope | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;

  const canonicalCwd = canonicalizeExistingPathCached(cwd);
  if (canonicalCwd === null) return 'outside';

  const toolPaths = extractPathsFromArgs(toolName, args);
  if (toolPaths.length === 0) return 'inside';

  for (const toolPath of toolPaths) {
    const target = canonicalizeEffectivePath(path.resolve(cwd, toolPath));
    if (target === null || !isPathContainedIn(target, canonicalCwd)) return 'outside';
  }
  return 'inside';
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
  args: Record<string, unknown>,
  cwd: string,
  config: Config,
  sessionOverride: PermissionMode | null,
): PermissionResolution {
  const scope = resolveToolScope(toolName, args, cwd);

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
  args: Record<string, unknown>,
  cwd: string,
  config: Config,
): boolean {
  const resolution = resolvePermission(toolName, riskClass, args, cwd, config, null);
  return resolution.mode !== 'allow';
}
