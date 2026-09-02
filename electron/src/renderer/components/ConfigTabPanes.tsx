/**
 * ConfigTabPanes — per-tab pane renderers for the global settings screen.
 *
 * ConfigView owns the tab machinery and the preloadable lazy components;
 * each pane receives its tab component preselected so the tab modules stay
 * code-split behind ConfigView's lazy boundaries.
 */
import type { ComponentType, LazyExoticComponent, ReactElement } from 'react';
import type { DefinitionsListResult } from '../../shared/types/definitions';
import type { Config, PermissionRule } from '../../shared/types/ipc-boundary';
import type { ConfigPatch, PermissionConfigScope } from '../../shared/types/ipc';
import type { Notify } from '../utils/notify';
import { StateMessage } from './ui/StateMessage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LoadableComponent = ComponentType<any>;

export type TabId =
  | 'general'
  | 'permissions'
  | 'trusted-projects'
  | 'providers'
  | 'machines'
  | 'mcp'
  | 'tier-models'
  | 'rag'
  | 'agents-md'
  | 'subagents'
  | 'compaction'
  | 'skills'
  | 'agents'
  | 'personalities'
  | 'shared-prompts';

export type ConfigTabComponents = Record<TabId, LazyExoticComponent<LoadableComponent>>;

export interface TabDef {
  id: TabId;
  label: string;
}

export interface ConfigTabItem extends TabDef {
  ariaBusy: boolean;
}

export const TABS: TabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'trusted-projects', label: 'Trusted Projects' },
  { id: 'providers', label: 'Providers' },
  { id: 'machines', label: 'Machines' },
  { id: 'mcp', label: 'MCP' },
  { id: 'tier-models', label: 'Tier Models' },
  { id: 'rag', label: 'RAG' },
  { id: 'agents-md', label: 'AGENTS.md' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'personalities', label: 'Personalities' },
  { id: 'shared-prompts', label: 'Shared Prompts' },
];

export interface PermissionTabContext {
  config: Config;
  scope: PermissionConfigScope;
  projectDir: string | null;
  inheritedPermissions: Record<string, PermissionRule>;
  projectLoading: boolean;
  onScopeChange: (scope: PermissionConfigScope) => void;
  updateDraft: (updates: ConfigPatch) => void;
}

export interface ConfigTabPaneProps {
  config: Config;
  updateDraft: (updates: ConfigPatch) => void;
  personalities: readonly string[];
  definitions: DefinitionsListResult | null;
  reloadDefinitions: () => Promise<void>;
  permission: PermissionTabContext;
  onNotify: Notify;
}

type TabPaneRenderer = (
  props: ConfigTabPaneProps,
  Tab: LazyExoticComponent<LoadableComponent>,
) => ReactElement;

const TAB_PANES: Record<TabId, TabPaneRenderer> = {
  general: ({ config, personalities, updateDraft }, General) => (
    <General
      astMaxFileSize={config.ast_max_file_size}
      backgroundCommandIdleTimeout={config.background_command_idle_timeout}
      commandTimeout={config.command_timeout}
      directoryTreeDepth={config.directory_tree_depth}
      grepMaxResults={config.grep_max_results}
      ignoredDirs={config.ignored_dirs}
      llmStreamIdleTimeout={config.llm_stream_idle_timeout}
      llmStreamRetries={config.llm_stream_retries}
      maxToolSteps={config.max_tool_steps}
      debugCaptureRequests={config.debug_capture_requests}
      mcpStartupTimeout={config.mcp_startup_timeout}
      mcpPerServerTimeout={config.mcp_per_server_timeout}
      personality={config.personality}
      personalities={personalities}
      readLineLimit={config.read_line_limit}
      theme={config.theme}
      alwaysExpandToolGroups={config.always_expand_tool_groups}
      commandMaxOutputBytes={config.command_max_output_bytes}
      toolOutputInlineThreshold={config.tool_output_inline_threshold}
      grepPerFileTimeout={config.grep_per_file_timeout}
      webFetchTimeout={config.web_fetch_timeout}
      webFetchMaxBodyBytes={config.web_fetch_max_body_bytes}
      webFetchUserAgent={config.web_fetch_user_agent}
      llmRetryBackoffBase={config.llm_retry_backoff_base}
      llmRetryMaxDelay={config.llm_retry_max_delay}
      maxBackgroundProcesses={config.max_background_processes}
      approvalTimeout={config.approval_timeout}
      subagentWaitTimeout={config.subagent_wait_timeout}
      bgPromptMaxEntries={config.bg_prompt_max_entries}
      bgPromptTailLines={config.bg_prompt_tail_lines}
      bgPromptTailChars={config.bg_prompt_tail_chars}
      bgOutputHeadBytes={config.bg_output_head_bytes}
      bgOutputTailBytes={config.bg_output_tail_bytes}
      readOutputLongPollMax={config.read_output_long_poll_max}
      mcpResultMaxBytes={config.mcp_result_max_bytes}
      toolWorkerPoolSize={config.tool_worker_pool_size}
      toolWorkerPoolMainAgentReserved={config.tool_worker_pool_main_agent_reserved}
      sessionTitleMaxWaitSeconds={config.session_title_max_wait_seconds}
      onChange={updateDraft}
    />
  ),
  permissions: ({ permission }, Permissions) => (
    <Permissions
      config={permission.config}
      updateDraft={permission.updateDraft}
      scope={permission.scope}
      lockedScope="global"
      projectDir={permission.projectDir}
      inheritedPermissions={permission.scope === 'project'
        ? permission.inheritedPermissions
        : {}}
      projectLoading={permission.projectLoading}
      onScopeChange={permission.onScopeChange}
    />
  ),
  'trusted-projects': ({ onNotify }, TrustedProjects) => (
    <TrustedProjects onNotify={onNotify} />
  ),
  providers: ({ onNotify }, Providers) => <Providers onNotify={onNotify} />,
  machines: ({ onNotify }, Machines) => <Machines onNotify={onNotify} />,
  mcp: ({ config, updateDraft }, McpServers) => (
    <McpServers
      mcpServers={config.mcp_servers}
      onChange={(mcp_servers: NonNullable<ConfigPatch['mcp_servers']>) => updateDraft({ mcp_servers })}
    />
  ),
  'tier-models': ({ config, updateDraft }, TierModels) => (
    <TierModels
      defaultModel={config.default_model}
      tierModels={config.tier_models}
      tierReasoningEffort={config.tier_reasoning_effort}
      onDefaultModelChange={(default_model: NonNullable<ConfigPatch['default_model']>) => updateDraft({ default_model })}
      onChange={(tier_models: NonNullable<ConfigPatch['tier_models']>) => updateDraft({ tier_models })}
      onTierReasoningEffortChange={(tier_reasoning_effort: NonNullable<ConfigPatch['tier_reasoning_effort']>) =>
        updateDraft({ tier_reasoning_effort })}
    />
  ),
  rag: ({ config, updateDraft }, Rag) => (
    <Rag
      rag={config.rag}
      onChange={(rag: NonNullable<ConfigPatch['rag']>) => updateDraft({ rag })}
      indexRefresh={config.index_refresh}
      onIndexRefreshChange={(index_refresh: NonNullable<ConfigPatch['index_refresh']>) => updateDraft({ index_refresh })}
    />
  ),
  'agents-md': ({ config, updateDraft }, AgentsMd) => (
    <AgentsMd
      agentsMd={config.agents_md}
      onChange={(agents_md: NonNullable<ConfigPatch['agents_md']>) => updateDraft({ agents_md })}
    />
  ),
  subagents: ({ config, updateDraft }, Subagents) => (
    <Subagents
      subagents={config.subagents}
      onChange={(subagents: NonNullable<ConfigPatch['subagents']>) => updateDraft({ subagents })}
    />
  ),
  compaction: ({ config, updateDraft }, Compaction) => (
    <Compaction
      compaction={config.compaction}
      onChange={(compaction: NonNullable<ConfigPatch['compaction']>) => updateDraft({ compaction })}
    />
  ),
  skills: ({ definitions, reloadDefinitions }, Skills) => {
    // requestTab gates until definitions are loaded — only show error if failed.
    if (!definitions) {
      return <StateMessage kind="warning" title="Skills could not be loaded." />;
    }
    return <Skills data={definitions} onReload={reloadDefinitions} lockedScope="global" />;
  },
  agents: ({ config, definitions, reloadDefinitions }, Agents) => {
    if (!definitions) {
      return <StateMessage kind="warning" title="Agents could not be loaded." />;
    }
    return (
      <Agents
        data={definitions}
        tierModels={config.tier_models}
        onReload={reloadDefinitions}
        lockedScope="global"
      />
    );
  },
  personalities: ({ definitions, reloadDefinitions }, Personalities) => {
    if (!definitions) {
      return <StateMessage kind="warning" title="Personalities could not be loaded." />;
    }
    return <Personalities data={definitions} onReload={reloadDefinitions} lockedScope="global" />;
  },
  'shared-prompts': ({ definitions, reloadDefinitions }, SharedPrompts) => {
    if (!definitions) {
      return <StateMessage kind="warning" title="Shared prompts could not be loaded." />;
    }
    return <SharedPrompts data={definitions} onReload={reloadDefinitions} lockedScope="global" />;
  },
};

export function renderTab(
  activeTab: TabId,
  props: ConfigTabPaneProps,
  components: ConfigTabComponents,
): ReactElement {
  return TAB_PANES[activeTab](props, components[activeTab]);
}
