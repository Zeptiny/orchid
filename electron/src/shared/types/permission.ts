export const PermissionMode = {
  ALLOW: 'allow',
  ASK: 'ask',
  DECIDE_FOR_ME: 'decide-for-me',
  ASK_WHEN_FLAGGED: 'ask-when-flagged',
} as const;
export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode];

export const RiskClass = {
  READ_ONLY: 'read-only',
  MUTATION: 'mutation',
  EXECUTION: 'execution',
  DELEGATION: 'delegation',
  NETWORK: 'network',
  MCP: 'mcp',
} as const;
export type RiskClass = (typeof RiskClass)[keyof typeof RiskClass];

export const ToolScope = {
  INSIDE: 'inside',
  OUTSIDE: 'outside',
} as const;
export type ToolScope = (typeof ToolScope)[keyof typeof ToolScope];

export interface FileToolPermission {
  inside: PermissionMode;
  outside: PermissionMode;
}

export interface ToolPermissionConfig {
  [toolName: string]: PermissionMode | FileToolPermission;
}

export interface PermissionResolution {
  mode: PermissionMode;
  source: 'tool-default' | 'project-config' | 'session-selector';
  scope?: ToolScope;
}
