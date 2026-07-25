import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = resolve(import.meta.dirname, '../..');

function source(path: string): string {
  return readFileSync(resolve(appRoot, path), 'utf8');
}

describe('renderer motion contract', () => {
  it('loads the shared vocabulary and preserves reduced-motion behavior', () => {
    const index = source('src/renderer/styles/index.css');
    const motion = source('src/renderer/styles/motion.css');
    const exceptions = source('src/renderer/styles/exceptions.css');

    expect(index).toContain('@import "./motion.css";');
    expect(motion).toContain('.orchid-collapsible-region');
    expect(motion).toContain('.orchid-state-enter');
    expect(motion).toContain('.orchid-view-enter');
    expect(exceptions).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('animates shell continuity through theme transition tokens', () => {
    expect(source('src/renderer/styles/exceptions.css')).toMatch(
      /\.app-frame[\s\S]*transition: grid-template-columns var\(--transition-slow/,
    );
    expect(source('src/renderer/styles/shell.css')).toMatch(
      /\.left-panel,[\s\S]*\.right-panel[\s\S]*transition: width var\(--transition-slow/,
    );
  });

  it('uses the mounted disclosure primitive on live stateful surfaces', () => {
    const paths = [
      'src/renderer/components/MessageWidget.tsx',
      'src/renderer/components/Sidebar.tsx',
      'src/renderer/components/ToolActivityGroup.tsx',
      'src/renderer/components/ToolResults/ToolResultShell.tsx',
      'src/renderer/components/ToolWidgets/LiveCommandInline.tsx',
    ];

    for (const path of paths) {
      expect(source(path), path).toContain('<CollapsibleRegion');
    }
  });

  it('documents the standard for future renderer work', () => {
    expect(source('../AGENTS.md')).toContain('### Motion and state transitions');
    expect(source('src/renderer/styles/README.md')).toContain('## Motion contract');
  });
});
