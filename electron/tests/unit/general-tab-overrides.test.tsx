import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneralTab, type GeneralTabProps } from '../../src/renderer/components/Preferences/GeneralTab';

const BASE_PROPS: GeneralTabProps = {
  theme: 'default',
  personality: 'default',
  personalities: ['default'],
  ignoredDirs: ['.git'],
  commandTimeout: 30,
  readLineLimit: 1000,
  grepMaxResults: 100,
  directoryTreeDepth: 2,
  projectInstructionFallbackFilenames: ['CLAUDE.md', 'GEMINI.md'],
  projectInstructionMaxBytes: 131072,
  projectInstructionMaxImportDepth: 5,
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

function renderTab(): string {
  return renderToStaticMarkup(<GeneralTab {...BASE_PROPS} />);
}

function projectBadgeCount(html: string): number {
  return (html.match(/>project<\/span>/g) ?? []).length;
}

describe('GeneralTab rendering', () => {
  it('renders without project override badges', () => {
    expect(projectBadgeCount(renderTab())).toBe(0);
  });

  it('renders field labels as plain strings', () => {
    const html = renderTab();
    expect(html).toContain('Command Timeout (s)');
    expect(html).toContain('Web Fetch User-Agent');
    expect(html).toContain('Always expand tool groups');
    expect(html).toContain('Theme');
    expect(html).toContain('Fallback Instruction Filenames');
    expect(html).toContain('Instruction Payload Budget (bytes)');
    expect(html).toContain('Shim Import Depth');
  });
});
