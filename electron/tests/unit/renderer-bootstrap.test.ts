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

  it('delegates initial index-status work to deferred inspector hydration', () => {
    const chatView = source('components', 'ChatView.tsx');
    const hydrationCall = chatView.match(
      /const workspaceCwd[\s\S]*?useInspectorHydration\(\{[\s\S]*?\}\);/,
    )?.[0];

    expect(hydrationCall).toContain('enabled: sidebarOpen');
    expect(hydrationCall).toContain('workspaceKey: workspaceCwd');
    expect(hydrationCall).toContain('refreshMCP');
    expect(hydrationCall).toContain('refreshIndex');
  });
});
