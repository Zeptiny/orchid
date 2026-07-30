import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(import.meta.dirname, '../../src/renderer');

function source(path: string): string {
  return readFileSync(resolve(rendererRoot, path), 'utf8');
}

describe('lazy renderer boundaries', () => {
  it('loads settings and onboarding only when their surfaces are requested', () => {
    const app = source('App.tsx');

    expect(app).toContain('lazy(() => import(\'./components/ConfigView\')');
    expect(app).toContain('lazy(() => import(\'./components/Onboarding/OnboardingScreen\')');
    expect(app).not.toMatch(/import \{ ConfigView \} from/);
    expect(app).not.toMatch(/import \{ OnboardingScreen \} from/);
    expect(app).toContain('<Suspense');
    expect(app).toContain('onboardingOpen && onboardingChecked');
  });

  it('splits optional project and subagent surfaces from the initial chat', () => {
    const chatView = source('components/ChatView.tsx');

    expect(chatView).toContain('lazy(() => import(\'./ProjectConfigView\')');
    expect(chatView).toContain('lazy(() => import(\'./SubagentView\')');
    expect(chatView).not.toMatch(/import \{ ProjectConfigView \} from/);
    expect(chatView).not.toMatch(/import \{ SubagentView,/);
    expect(chatView).toContain('<Suspense');
  });

  it('loads each settings tab behind the persistent ConfigView draft owner', () => {
    const configView = source('components/ConfigView.tsx');
    const tabModules = [
      'AgentsTab',
      'GeneralTab',
      'MCPServersTab',
      'PermissionsTab',
      'PersonalitiesTab',
      'ProvidersTab',
      'RAGTab',
      'SkillsTab',
      'SubagentsTab',
      'TierModelsTab',
    ];

    for (const tabModule of tabModules) {
      expect(configView).toContain(
        `lazyWithPreload(() => import('./Preferences/${tabModule}')`,
      );
      expect(configView).not.toContain(
        `import { ${tabModule} } from`,
      );
    }

    expect(configView).toContain('<Suspense');
    expect(configView).toContain('renderTab(');
    expect(configView).toContain('TAB_COMPONENTS[tab].preload()');
    expect(configView).toContain('await Promise.allSettled([');
  });
});
