/**
 * GeneralTab project-override indicator contract.
 *
 * Static-markup verification (no DOM runtime in this suite): fields whose
 * config key exists in the bound project's `.orchid.json` overrides render a
 * "project" scope badge next to the label; everything else stays bare.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneralTab, type GeneralTabProps } from '../../src/renderer/components/Preferences/GeneralTab';

const BASE_PROPS: Omit<GeneralTabProps, 'projectOverrides'> = {
  theme: 'default',
  personality: 'default',
  personalities: ['default'],
  ignoredDirs: ['.git'],
  commandTimeout: 30,
  readLineLimit: 1000,
  grepMaxResults: 100,
  directoryTreeDepth: 2,
  astMaxFileSize: 1048576,
  mcpStartupTimeout: 60,
  mcpPerServerTimeout: 10,
  llmStreamIdleTimeout: 300,
  llmStreamRetries: 3,
  backgroundCommandIdleTimeout: 900,
  maxToolSteps: 100,
  alwaysExpandToolGroups: false,
  commandMaxOutputBytes: 1048576,
  toolOutputInlineThreshold: 20000,
  grepPerFileTimeout: 5,
  webFetchTimeout: 30,
  webFetchMaxBodyBytes: 10485760,
  webFetchUserAgent: 'Orchid/1.0 web-fetch (Electron)',
  llmRetryBackoffBase: 0.5,
  llmRetryMaxDelay: 30,
  maxBackgroundProcesses: 64,
  approvalTimeout: 600,
  subagentWaitTimeout: 300,
  bgPromptMaxEntries: 5,
  bgPromptTailLines: 8,
  bgPromptTailChars: 500,
  bgOutputHeadBytes: 4096,
  bgOutputTailBytes: 8192,
  readOutputLongPollMax: 30,
  mcpResultMaxBytes: 5242880,
  onChange: () => {},
};

function renderTab(projectOverrides?: Record<string, unknown> | null): string {
  return renderToStaticMarkup(
    <GeneralTab {...BASE_PROPS} projectOverrides={projectOverrides} />,
  );
}

function projectBadgeCount(html: string): number {
  return (html.match(/>project<\/span>/g) ?? []).length;
}

describe('GeneralTab project override indicators', () => {
  it('renders no project badges without overrides', () => {
    expect(projectBadgeCount(renderTab(null))).toBe(0);
    expect(projectBadgeCount(renderTab(undefined))).toBe(0);
    expect(projectBadgeCount(renderTab({}))).toBe(0);
  });

  it('badges each field whose key exists in the project overrides', () => {
    const html = renderTab({ command_timeout: 60, web_fetch_user_agent: 'custom-agent' });
    expect(projectBadgeCount(html)).toBe(2);
    expect(html).toContain('Command Timeout (s)');
    expect(html).toContain('Web Fetch User-Agent');
  });

  it('badges the checkbox field when its key is overridden', () => {
    const html = renderTab({ always_expand_tool_groups: true });
    expect(projectBadgeCount(html)).toBe(1);
    expect(html).toContain('Always expand tool groups');
  });

  it('ignores override keys that have no GeneralTab field', () => {
    const html = renderTab({ rag: { top_k: 5 }, default_model: null, theme: 'dark' });
    expect(projectBadgeCount(html)).toBe(1);
    expect(html).toContain('Theme');
  });
});
