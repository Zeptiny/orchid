import path from 'node:path';
import type {
  PermissionMode,
  RiskClass,
  ToolScope,
  FileToolPermission,
  PermissionResolution,
} from '../../shared/types/permission';
import type { Config, PermissionRule } from '../../shared/types/ipc-boundary';

export const RISK_CLASS_DEFAULTS: Record<RiskClass, PermissionMode> = {
  'read-only': 'allow',
  mutation: 'ask',
  execution: 'ask',
  delegation: 'ask',
  network: 'ask',
  mcp: 'ask',
};

export const FILE_TOOLS = new Set<string>([
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'read_directory',
  'get_file_skeleton',
  'get_function',
  'find_symbol_references',
  'replace_symbol',
  'rename_symbol',
]);

export const FILE_TOOL_DEFAULTS: Record<string, FileToolPermission> = {
  read: { inside: 'allow', outside: 'ask' },
  glob: { inside: 'allow', outside: 'ask' },
  read_directory: { inside: 'allow', outside: 'ask' },
  get_file_skeleton: { inside: 'allow', outside: 'ask' },
  get_function: { inside: 'allow', outside: 'ask' },
  find_symbol_references: { inside: 'allow', outside: 'ask' },
  write: { inside: 'ask', outside: 'ask' },
  edit: { inside: 'ask', outside: 'ask' },
  apply_patch: { inside: 'ask', outside: 'ask' },
  replace_symbol: { inside: 'ask', outside: 'ask' },
  rename_symbol: { inside: 'ask', outside: 'ask' },
};

const PATCH_FILE_PATTERN = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

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

export function resolveToolScope(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): ToolScope | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;

  const toolPaths = extractPathsFromArgs(toolName, args);
  if (toolPaths.length === 0) return 'inside';

  for (const toolPath of toolPaths) {
    const resolved = path.resolve(cwd, toolPath);
    if (!isPathContainedIn(resolved, cwd)) return 'outside';
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

  const configRule = config.permissions?.[toolName];
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
