/** All valid permission mode string values, for use with zod `z.enum(...)`. */
export const PERMISSION_MODE_VALUES = [
  'allow',
  'ask',
  'decide-for-me',
  'ask-when-flagged',
] as const;
export type PermissionMode = (typeof PERMISSION_MODE_VALUES)[number];

/** Named accessors for permission modes (kept for backward compatibility). */
export const PermissionMode = {
  ALLOW: 'allow',
  ASK: 'ask',
  DECIDE_FOR_ME: 'decide-for-me',
  ASK_WHEN_FLAGGED: 'ask-when-flagged',
} as const satisfies Record<string, PermissionMode>;

export const RiskClass = {
  READ_ONLY: 'read-only',
  MUTATION: 'mutation',
  EXECUTION: 'execution',
  DELEGATION: 'delegation',
  NETWORK: 'network',
  MCP: 'mcp',
} as const;
export type RiskClass = (typeof RiskClass)[keyof typeof RiskClass];

/** Default permission mode applied per risk class. */
export const RISK_CLASS_DEFAULTS: Record<RiskClass, PermissionMode> = {
  'read-only': 'allow',
  mutation: 'ask',
  execution: 'ask',
  delegation: 'ask',
  network: 'ask',
  mcp: 'ask',
};

export const ToolScope = {
  INSIDE: 'inside',
  OUTSIDE: 'outside',
} as const;
export type ToolScope = (typeof ToolScope)[keyof typeof ToolScope];

/** A path intent after resolution against the frozen workspace. */
export interface ResolvedToolPathIntent {
  userPath: string;
  resolvedPath: string;
  effectivePath: string | null;
  target: 'file' | 'directory';
  access: 'read' | 'mutation';
  activateInstructions: boolean;
}

/** Shared, single-pass path preflight used by permissions and instructions. */
export interface ResolvedToolScope {
  scope: ToolScope;
  intents: readonly ResolvedToolPathIntent[];
}

export interface FileToolPermission {
  inside: PermissionMode;
  outside: PermissionMode;
}

/** File tools that receive scope-aware inside/outside permissions. */
export const FILE_TOOLS = new Set<string>([
  'read',
  'write',
  'edit',
  'apply_patch',
  'grep',
  'glob',
  'read_directory',
  'get_file_skeleton',
  'get_function',
  'find_symbol_references',
  'replace_symbol',
  'rename_symbol',
]);

/** Default inside/outside permission modes for each file tool. */
export const FILE_TOOL_DEFAULTS: Record<string, FileToolPermission> = {
  read: { inside: 'allow', outside: 'ask' },
  grep: { inside: 'allow', outside: 'ask' },
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

export interface ToolPermissionConfig {
  [toolName: string]: PermissionMode | FileToolPermission;
}

export interface PermissionResolution {
  mode: PermissionMode;
  source: 'tool-default' | 'project-config' | 'session-selector';
  scope?: ToolScope;
}
