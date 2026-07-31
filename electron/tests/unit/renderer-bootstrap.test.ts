import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

function source(...parts: string[]): string {
  return fs.readFileSync(path.join(rendererRoot, ...parts), 'utf8');
}

describe('renderer bootstrap', () => {
  it('shares one effective configuration snapshot across the ready app and ChatView', () => {
    const app = source('AppReady.tsx');
    const chatView = source('components', 'ChatView.tsx');
    const configRequests = `${app}\n${chatView}`.match(
      /window\.orchid\.config\.get\(\)/g,
    ) ?? [];

    expect(configRequests).toHaveLength(1);
    expect(app).toContain('bootstrapConfig={bootstrapConfig}');
    expect(chatView).toContain('bootstrapConfig?: Config | null');
  });

  it('uses the workspace effect as the sole initial index-status trigger', () => {
    const chatView = source('components', 'ChatView.tsx');
    const startupEffect = chatView.match(
      /useEffect\(\(\) => \{\s*refreshMCP\(\);[\s\S]*?\}, \[refreshMCP[^\]]*\]\);/,
    )?.[0];
    const workspaceEffect = chatView.match(
      /const workspaceCwd[\s\S]*?useEffect\(\(\) => \{\s*void refreshIndex\(\);[\s\S]*?\}, \[workspaceCwd, refreshIndex\]\);/,
    )?.[0];

    expect(startupEffect).toBeDefined();
    expect(startupEffect).not.toContain('refreshIndex');
    expect(workspaceEffect).toBeDefined();
  });
});
