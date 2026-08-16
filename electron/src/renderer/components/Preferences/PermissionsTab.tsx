import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Config,
  MCPServerStatus,
  PermissionModeValue,
  PermissionRule,
} from '../../../shared/types/ipc-boundary';
import type { ConfigPatch, PermissionConfigScope } from '../../../shared/types/ipc';
import {
  FILE_TOOLS,
  FILE_TOOL_DEFAULTS,
  type FileToolPermission,
} from '../../../shared/types/permission';
import { Icon, type IconName } from '../Icon';
import { parseConfigNumber } from '../../utils/config-draft';
import { Button } from '../ui/Button';
import { Disclosure } from '../ui/Disclosure';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { Select } from '../ui/Select';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';
import { TextInput } from '../ui/TextInput';
import { ScopeToggle } from './ScopeToggle';

const PERMISSION_MODES: ReadonlyArray<{ value: PermissionModeValue; label: string }> = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'decide-for-me', label: 'Decide for me' },
  { value: 'ask-when-flagged', label: 'Ask when flagged' },
];

const MCP_PREFIX = 'mcp::';
const MCP_DEFAULT_MODE: PermissionModeValue = 'ask';

interface RiskSection {
  id: string;
  title: string;
  icon: IconName;
  description: string;
  defaultMode: PermissionModeValue;
  tools: readonly string[];
}

const RISK_SECTIONS: readonly RiskSection[] = [
  {
    id: 'read-only',
    title: 'Read-only tools',
    icon: 'eye',
    description: 'Inspect files, search, and observe output without changing anything.',
    defaultMode: 'allow',
    tools: [
      'read',
      'grep',
      'glob',
      'rag_search',
      'read_directory',
      'read_output',
      'get_file_skeleton',
      'get_function',
      'find_symbol_references',
      'list_mcp_resources',
      'read_mcp_resource',
      'todo_list',
      'wait_for_subagent',
      'skill',
      'ask_question',
    ],
  },
  {
    id: 'mutation',
    title: 'Mutation tools',
    icon: 'edit',
    description: 'Create or modify files, todos, and search indexes.',
    defaultMode: 'ask',
    tools: [
      'write',
      'edit',
      'apply_patch',
      'replace_symbol',
      'rename_symbol',
      'todo_create',
      'todo_update',
      'todo_delete',
      'rag_index',
      'ast_index',
    ],
  },
  {
    id: 'execution',
    title: 'Execution tools',
    icon: 'terminal',
    description: 'Run shell commands and interact with running processes.',
    defaultMode: 'ask',
    tools: ['execute_command', 'send_input', 'terminate_command'],
  },
  {
    id: 'delegation',
    title: 'Delegation tools',
    icon: 'send',
    description: 'Spawn, interrupt, and answer subagents.',
    defaultMode: 'ask',
    tools: ['delegate_to_subagent', 'interrupt_subagents', 'answer_subagent'],
  },
  {
    id: 'network',
    title: 'Network tools',
    icon: 'globe',
    description: 'Fetch remote content over the network.',
    defaultMode: 'ask',
    tools: ['web_fetch'],
  },
];

/** UI fallback for file tools missing from the shared defaults table. */
const FILE_SLOT_FALLBACK: FileToolPermission = { inside: 'ask', outside: 'ask' };

function effectiveSlot(
  rule: PermissionRule | undefined,
  slot: 'inside' | 'outside',
  fallback: PermissionModeValue,
): PermissionModeValue {
  if (rule === undefined) return fallback;
  return typeof rule === 'string' ? rule : rule[slot];
}

function ModeSelect({
  id,
  value,
  ariaLabel,
  onChange,
}: {
  id: string;
  value: PermissionModeValue;
  ariaLabel: string;
  onChange: (mode: PermissionModeValue) => void;
}) {
  return (
    <Select
      id={id}
      size="sm"
      bordered
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value as PermissionModeValue)}
      className="w-40"
    >
      {PERMISSION_MODES.map((mode) => (
        <option key={mode.value} value={mode.value}>
          {mode.label}
        </option>
      ))}
    </Select>
  );
}

function ToolRow({
  name,
  hint,
  overridden,
  children,
}: {
  name: string;
  hint?: string;
  overridden: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
            overridden ? 'bg-primary' : 'bg-base-300'
          }`}
          aria-hidden
        />
        <span className="truncate font-mono text-sm">{name}</span>
        {hint && <span className="truncate font-mono text-xs text-base-content/50">{hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
    </div>
  );
}

function SlotPicker({
  id,
  label,
  ariaLabel,
  value,
  onChange,
}: {
  id: string;
  label: string;
  ariaLabel: string;
  value: PermissionModeValue;
  onChange: (mode: PermissionModeValue) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-base-content/60" htmlFor={id}>
        {label}
      </label>
      <ModeSelect id={id} value={value} ariaLabel={ariaLabel} onChange={onChange} />
    </div>
  );
}

function PermissionToolRow({
  tool,
  rule,
  overridden,
  defaultMode,
  onModeChange,
  onSlotChange,
}: {
  tool: string;
  rule: PermissionRule | undefined;
  overridden: boolean;
  defaultMode: PermissionModeValue;
  onModeChange: (tool: string, mode: PermissionModeValue) => void;
  onSlotChange: (tool: string, slot: 'inside' | 'outside', mode: PermissionModeValue) => void;
}) {
  if (FILE_TOOLS.has(tool)) {
    const defaults = FILE_TOOL_DEFAULTS[tool] ?? FILE_SLOT_FALLBACK;
    return (
      <ToolRow name={tool} overridden={overridden}>
        <SlotPicker
          id={`perm-${tool}-inside`}
          label="Inside project"
          ariaLabel={`${tool} — inside project`}
          value={effectiveSlot(rule, 'inside', defaults.inside)}
          onChange={(mode) => onSlotChange(tool, 'inside', mode)}
        />
        <SlotPicker
          id={`perm-${tool}-outside`}
          label="Outside project"
          ariaLabel={`${tool} — outside project`}
          value={effectiveSlot(rule, 'outside', defaults.outside)}
          onChange={(mode) => onSlotChange(tool, 'outside', mode)}
        />
      </ToolRow>
    );
  }

  return (
    <ToolRow name={tool} overridden={overridden}>
      <ModeSelect
        id={`perm-${tool}`}
        ariaLabel={`${tool} permission mode`}
        value={effectiveSlot(rule, 'inside', defaultMode)}
        onChange={(mode) => onModeChange(tool, mode)}
      />
    </ToolRow>
  );
}

function SectionTitle({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-sm font-semibold tracking-tight text-base-content">
      <Icon name={icon} size={14} className="text-base-content/60" />
      {children}
    </span>
  );
}

function OverrideBadge({ count }: { count: number }) {
  return (
    <StatusBadge tone="primary" size="sm" outline>
      {count} custom
    </StatusBadge>
  );
}

function overrideActions(count: number): ReactNode {
  return count > 0 ? <OverrideBadge count={count} /> : undefined;
}

/** Props for {@link PermissionsTab}. */
export interface PermissionsTabProps {
  config: Config;
  updateDraft: (updates: ConfigPatch) => void;
  scope?: PermissionConfigScope;
  lockedScope?: 'global' | 'project';
  projectDir?: string | null;
  onScopeChange?: (scope: PermissionConfigScope) => void;
  inheritedPermissions?: Record<string, PermissionRule>;
  projectLoading?: boolean;
  /** Live MCP server status; fetched over IPC when omitted. */
  mcpStatus?: readonly MCPServerStatus[];
}

/** Preferences tab for per-tool permission modes: inside/outside slots for file tools, single modes elsewhere, plus per-server MCP grouping. */
export function PermissionsTab({
  config,
  updateDraft,
  scope = 'global',
  lockedScope,
  projectDir = null,
  onScopeChange,
  inheritedPermissions = {},
  projectLoading = false,
  mcpStatus: mcpStatusProp,
}: PermissionsTabProps) {
  const effectiveScope = lockedScope ?? scope;
  const [fetchedMcpStatus, setFetchedMcpStatus] = useState<readonly MCPServerStatus[]>([]);
  const mcpFetchGeneration = useRef(0);

  const refreshMcpStatus = useCallback(async () => {
    const generation = ++mcpFetchGeneration.current;
    try {
      if (window.orchid?.mcp?.status) {
        const status = await window.orchid.mcp.status(projectDir);
        if (generation !== mcpFetchGeneration.current) return;
        setFetchedMcpStatus(status);
      }
    } catch {
      // Non-fatal — live MCP tools simply are not enumerated.
    }
  }, [projectDir]);

  // Re-fetch MCP status when the workspace changes. Clear stale results from
  // the previous project so old tools don't flash before the new fetch lands.
  useEffect(() => {
    if (mcpStatusProp !== undefined) return;
    setFetchedMcpStatus([]);
    void refreshMcpStatus();
  }, [mcpStatusProp, refreshMcpStatus, projectDir]);

  useEffect(() => {
    if (mcpStatusProp !== undefined) return;
    const unsubTrust = window.orchid?.projectTrust?.onChanged?.(() => {
      void refreshMcpStatus();
    });
    const unsubWorkspace = window.orchid?.session?.onWorkspaceChanged?.(() => {
      void refreshMcpStatus();
    });
    return () => {
      unsubTrust?.();
      unsubWorkspace?.();
    };
  }, [mcpStatusProp, refreshMcpStatus]);

  const mcpStatus = mcpStatusProp ?? fetchedMcpStatus;

  // Poll while any server is still starting OR when MCP servers are
  // configured but the status snapshot is empty (untrusted/dormant manager,
  // slow connect, workspace just bound). This covers the gap where the
  // initial fetch returns [] before servers have had a chance to connect.
  const hasConfiguredServers = Object.keys(config.mcp_servers).length > 0;
  const hasStarting = mcpStatus.some((server) => server.status === 'starting');
  const needsPolling = mcpStatusProp === undefined && (hasStarting || (hasConfiguredServers && mcpStatus.length === 0));

  useEffect(() => {
    if (!needsPolling) return;
    const id = setInterval(() => {
      void refreshMcpStatus();
    }, 1500);
    return () => clearInterval(id);
  }, [needsPolling, refreshMcpStatus]);

  useEffect(() => {
    if (mcpStatusProp !== undefined) return;
    if (hasConfiguredServers && mcpStatus.length === 0) {
      void refreshMcpStatus();
    }
  }, [config.mcp_servers, hasConfiguredServers, mcpStatus.length, mcpStatusProp, refreshMcpStatus]);

  const permissions = config.permissions;
  const overrideCount = Object.keys(permissions).length;
  const permissionKeys = useMemo(
    () => Array.from(new Set([
      ...Object.keys(inheritedPermissions),
      ...Object.keys(permissions),
    ])),
    [inheritedPermissions, permissions],
  );

  const setToolMode = useCallback(
    (tool: string, mode: PermissionModeValue) => {
      updateDraft({ permissions: { [tool]: mode } });
    },
    [updateDraft],
  );

  const setToolSlot = useCallback(
    (tool: string, slot: 'inside' | 'outside', mode: PermissionModeValue) => {
      const rule = permissions[tool] ?? inheritedPermissions[tool];
      const defaults = FILE_TOOL_DEFAULTS[tool] ?? FILE_SLOT_FALLBACK;
      const next: FileToolPermission = {
        inside: effectiveSlot(rule, 'inside', defaults.inside),
        outside: effectiveSlot(rule, 'outside', defaults.outside),
      };
      next[slot] = mode;
      updateDraft({ permissions: { [tool]: next } });
    },
    [inheritedPermissions, permissions, updateDraft],
  );

  const handleResetAll = useCallback(() => {
    updateDraft({
      permissions: Object.fromEntries(
        Object.keys(permissions).map((key): [string, null] => [key, null]),
      ),
    });
  }, [permissions, updateDraft]);

  const mcpServers = useMemo(() => {
    const servers = new Set<string>(Object.keys(config.mcp_servers));
    for (const key of permissionKeys) {
      if (!key.startsWith(MCP_PREFIX)) continue;
      const server = key.slice(MCP_PREFIX.length).split('::')[0];
      if (server) servers.add(server);
    }
    for (const server of mcpStatus) servers.add(server.name);
    return Array.from(servers).sort((a, b) => a.localeCompare(b));
  }, [config.mcp_servers, mcpStatus, permissionKeys]);

  const mcpOverrideCount = useMemo(
    () => Object.keys(permissions).filter((key) => key.startsWith(MCP_PREFIX)).length,
    [permissions],
  );

  const liveToolsByServer = useMemo(() => {
    const map = new Map<string, readonly string[]>();
    for (const server of mcpStatus) {
      if (server.tools.length > 0) map.set(server.name, server.tools);
    }
    return map;
  }, [mcpStatus]);

  if (projectLoading && effectiveScope === 'project') {
    return <StateMessage kind="loading" title="Loading project permissions…" />;
  }

  return (
    <div className="config-form flex flex-col gap-4">
      {onScopeChange && !lockedScope && (
        <ScopeToggle
          value={scope}
          onChange={(next) => {
            if (next !== 'all') onScopeChange(next);
          }}
          projectAvailable={!projectLoading && projectDir != null}
          projectDir={projectDir}
          includeAll={false}
          ariaLabel="Permission configuration scope"
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-base-content/70">
          Choose how each tool behaves in the {effectiveScope === 'project' ? 'active project' : 'global user'} scope. File tools carry
          separate rules for paths inside and outside the current project; everything else
          uses a single mode. Tools you leave untouched {effectiveScope === 'project'
            ? 'inherit the global user rule before falling back to the risk-class default.'
            : 'fall back to their risk-class default.'}
        </p>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          onClick={handleResetAll}
          disabled={overrideCount === 0}
        >
          Reset all to defaults
        </Button>
      </div>

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="History" />
        <div className="config-form-grid">
          <FormField
            label="Permission History Size"
            htmlFor="perm-history-size"
            hint="Number of recent permission decisions to remember (0 disables)."
            className="config-field"
          >
            <TextInput
              id="perm-history-size"
              type="number"
              value={config.permission_history_size}
              onChange={(e) => {
                const num = parseConfigNumber(e.target.value, 0, { integer: true });
                if (num !== null && num <= 50) {
                  updateDraft({ permission_history_size: num });
                }
              }}
              bordered
              className="w-full"
              min={0}
              max={50}
            />
          </FormField>
        </div>
      </Panel>

      {RISK_SECTIONS.map((section) => {
        const customCount = section.tools.filter(
          (tool) => permissions[tool] !== undefined,
        ).length;
        return (
          <Panel key={section.id} as="section" className="config-fieldset flex flex-col gap-3">
            <SectionHeader
              title={<SectionTitle icon={section.icon}>{section.title}</SectionTitle>}
              description={section.description}
              actions={overrideActions(customCount)}
            />
            <div className="divide-y divide-base-300/60">
              {section.tools.map((tool) => (
                <PermissionToolRow
                  key={tool}
                  tool={tool}
                  rule={permissions[tool] ?? inheritedPermissions[tool]}
                  overridden={permissions[tool] !== undefined}
                  defaultMode={section.defaultMode}
                  onModeChange={setToolMode}
                  onSlotChange={setToolSlot}
                />
              ))}
            </div>
          </Panel>
        );
      })}

      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title={<SectionTitle icon="layers">MCP tools</SectionTitle>}
          description="Tools exposed by configured MCP servers, grouped by server."
          actions={overrideActions(mcpOverrideCount)}
        />
        {mcpServers.length === 0 ? (
          <StateMessage kind="empty" title="No MCP servers configured" className="py-4" />
        ) : (
          <div className="flex flex-col gap-2">
            {mcpServers.map((server) => {
              const wildcard = `${MCP_PREFIX}${server}::*`;
              const prefix = `${MCP_PREFIX}${server}::`;
              const toolKeySet = new Set(
                permissionKeys.filter((key) => key.startsWith(prefix) && key !== wildcard),
              );
              for (const tool of liveToolsByServer.get(server) ?? []) {
                toolKeySet.add(`${prefix}${tool}`);
              }
              const toolKeys = Array.from(toolKeySet).sort((a, b) => a.localeCompare(b));
              const customCount = (permissions[wildcard] !== undefined ? 1 : 0) +
                Object.keys(permissions).filter(
                  (key) => key.startsWith(prefix) && key !== wildcard,
                ).length;
              const serverStatus = mcpStatus.find((entry) => entry.name === server);
              return (
                <Disclosure
                  key={server}
                  variant="card"
                  summary={
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium">{server}</span>
                      {serverStatus && serverStatus.status !== 'connected' && (
                        <StatusBadge
                          tone={serverStatus.status === 'starting' ? 'warning' : 'error'}
                          size="xs"
                        >
                          {serverStatus.status}
                        </StatusBadge>
                      )}
                      {overrideActions(customCount)}
                    </span>
                  }
                >
                  <div className="divide-y divide-base-300/60">
                    <ToolRow
                      name="All tools"
                      hint={wildcard}
                      overridden={permissions[wildcard] !== undefined}
                    >
                      <ModeSelect
                        id={`perm-mcp-${server}-all`}
                        ariaLabel={`All ${server} tools permission mode`}
                        value={effectiveSlot(
                          permissions[wildcard] ?? inheritedPermissions[wildcard],
                          'inside',
                          MCP_DEFAULT_MODE,
                        )}
                        onChange={(mode) => setToolMode(wildcard, mode)}
                      />
                    </ToolRow>
                    {toolKeys.map((key) => (
                      <ToolRow
                        key={key}
                        name={key.slice(prefix.length)}
                        overridden={permissions[key] !== undefined}
                      >
                        <ModeSelect
                          id={`perm-${key}`}
                          ariaLabel={`${key} permission mode`}
                          value={effectiveSlot(
                            permissions[key] ?? inheritedPermissions[key],
                            'inside',
                            MCP_DEFAULT_MODE,
                          )}
                          onChange={(mode) => setToolMode(key, mode)}
                        />
                      </ToolRow>
                    ))}
                  </div>
                </Disclosure>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
