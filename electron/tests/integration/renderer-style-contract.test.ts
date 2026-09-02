/**
 * Renderer style contract — zero-violation gate.
 *
 * Scans class-bearing source (className / class attributes) and feature CSS
 * for styling-contract violations. Arbitrary utilities and top-level reserved
 * component-root redefinitions must be zero outside the approved exception
 * registries. Component roots (`btn`, `input`, `badge`, ...) are owned solely
 * by `styles/primitives.css` — the engine that replaced DaisyUI.
 *
 * Scanners, vocabularies and baselines live in `style-contract-lib.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPROVED_ARBITRARY_UTILITIES,
  APPROVED_DYNAMIC_STYLE_PATHS,
  BASELINE_ARBITRARY_UTILITIES,
  BASELINE_COMPONENT_ROOT_HITS,
  BASELINE_COMPONENT_ROOT_TOTAL_TOKENS,
  BASELINE_NON_TOKEN_COLORS,
  BASELINE_RESERVED_REDEFINITIONS,
  PACKAGE_JSON,
  PRIMITIVES_CSS,
  RENDERER_ROOT,
  REQUIRED_THEMES,
  STYLES_ROOT,
  THEMES_INDEX,
  THEMES_ROOT,
  escapeRegExp,
  extractStaticClassStrings,
  findArbitraryUtilityTokens,
  findCssRuleBody,
  findTopLevelReservedRedefinitions,
  relRenderer,
  scanArbitraryUtilities,
  scanComponentRootDrift,
  scanNonTokenColors,
  scanReservedRedefinitions,
  stripCssComments,
  walkFiles,
} from './style-contract-lib';

describe('Renderer style contract', () => {
  describe('theme registry', () => {
    it('registers all required theme names', () => {
      const indexSource = fs.readFileSync(THEMES_INDEX, 'utf8');
      for (const name of REQUIRED_THEMES) {
        expect(indexSource, `themes/index.ts missing ${name}`).toMatch(
          new RegExp(`['"]${name}['"]`),
        );
      }
      expect(indexSource).toContain('export type ThemeName');
      expect(indexSource).toContain('export const THEMES');
      expect(indexSource).toContain('export function applyTheme');
    });

    it('ships a CSS file for each required theme', () => {
      for (const name of REQUIRED_THEMES) {
        const themePath = path.join(THEMES_ROOT, `${name}.css`);
        expect(fs.existsSync(themePath), `missing theme file ${name}.css`).toBe(true);
      }
    });
  });

  describe('layout preservation contract', () => {
    it('applies lifecycle accents through collapsible tool-result wrappers', () => {
      const componentCss = fs.readFileSync(
        path.join(STYLES_ROOT, 'components.css'),
        'utf8',
      );

      for (const selector of [
        '.orchid-tool-block.running .orchid-tool-block-content',
        '.orchid-tool-block.generating .orchid-tool-block-content',
        '.orchid-tool-block.failed .orchid-tool-block-content',
        '.orchid-tool-block.error .orchid-tool-block-content',
      ]) {
        expect(findCssRuleBody(componentCss, selector), `${selector} is missing`).toContain(
          'border-left-color:',
        );
      }
    });

    it('documents layout preservation in styles README', () => {
      const readme = fs.readFileSync(path.join(STYLES_ROOT, 'README.md'), 'utf8');
      expect(readme).toMatch(/layout preservation/i);
      expect(readme).toMatch(/Focused Workspace/i);
      expect(readme).toMatch(/restyle\s+(\*\*)?in place(\*\*)?/i);
    });

    it('keeps the existing shell entry components', () => {
      for (const rel of [
        'App.tsx',
        'components/ChatView.tsx',
        'components/LeftSidebar.tsx',
        'components/Sidebar.tsx',
        'components/SessionTabBar.tsx',
        'components/ConfigView.tsx',
      ]) {
        expect(fs.existsSync(path.join(RENDERER_ROOT, rel)), rel).toBe(true);
      }
    });

    it('keeps the three-panel shell contracts in the canonical stylesheet', () => {
      const shellCss = fs.readFileSync(
        path.join(STYLES_ROOT, 'shell.css'),
        'utf8',
      );
      const componentCss = fs.readFileSync(
        path.join(STYLES_ROOT, 'components.css'),
        'utf8',
      );
      const indexCss = fs.readFileSync(path.join(STYLES_ROOT, 'index.css'), 'utf8');
      expect(indexCss.indexOf('@import "tailwindcss"')).toBeLessThan(
        indexCss.indexOf('@import "./components.css"'),
      );
      expect(indexCss.indexOf('@import "./components.css"')).toBeLessThan(
        indexCss.indexOf('@import "./shell.css"'),
      );
      expect(shellCss).toMatch(/@layer\s+orchid\s*\{/);
      const rendererHtml = fs.readFileSync(
        path.join(RENDERER_ROOT, 'index.html'),
        'utf8',
      );
      expect(rendererHtml).not.toMatch(/<style>[\s\S]*?\*\s*\{[\s\S]*?padding\s*:\s*0/);
      const contracts: Array<[string, string[]]> = [
        ['.main-pane', ['display: flex;', 'flex-direction: column;']],
        ['.panel-header', ['min-height: 46px;', 'padding: 7px 10px;', 'align-items: center;', 'gap: 8px;']],
        ['.panel-body', ['padding: 8px;', 'box-sizing: border-box;', 'flex: 1 1 0;']],
        ['.panel-footer', ['padding: 6px 8px;', 'flex: 0 0 auto;']],
        ['.right-panel-toolbar', ['min-height: 28px;', 'margin: -2px 0 4px;']],
        ['.session-tab-bar', ['min-height: 36px;', 'flex-shrink: 0;']],
        ['.session-tab-bar-scroll', ['gap: 2px;', 'padding: 4px 6px;']],
        ['.session-tab', ['min-width: 96px;', 'border-radius: 0.5rem;', 'box-sizing: border-box;']],
        ['.session-tab-active', ['background: color-mix(', 'border-color: color-mix(']],
        ['.session-tab-select', ['padding: 0.3rem 0.25rem 0.3rem 0.5rem;']],
        ['.session-header', ['padding: 7px 14px 6px;', 'box-sizing: border-box;']],
        ['.session-project-sessions > .session-row', ['margin-left: 10px;', 'padding-left: var(--tree-gutter);']],
        ['.session-project-sessions > .session-row::before', ['border-left: 1px solid var(--tree-line);']],
        ['.workspace-chip', ['min-height: 28px;', 'border-radius: 5px;']],
        ['.session-search-input', ['height: 36px;', 'border: 1px solid']],
        ['.session-item-main', ['flex: 1 1 auto;']],
        ['.session-item', ['min-height: 30px;', 'padding: 5px 7px;']],
        ['.session-project-label', ['font-size: 12px;']],
        ['.session-item-delete', ['position: absolute;', 'opacity: 0;']],
        ['.session-settings-btn', ['width: 100%;', 'min-height: 36px !important;', 'padding: 8px 10px !important;']],
        ['.inspector-stack', ['display: flex;', 'gap: 4px;']],
        ['.inspector-row', ['justify-content: space-between;', 'font-size: 12px;']],
        ['.panel-header .btn-circle', ['width: 28px;', 'height: 28px;', 'min-height: 28px;']],
      ];

      for (const [selector, declarations] of contracts) {
        const ruleBody = findCssRuleBody(shellCss, selector);
        expect(ruleBody, `${selector} is missing`).not.toBeNull();
        for (const declaration of declarations) {
          expect(
            ruleBody,
            `${selector} is missing ${declaration}`,
          ).toContain(declaration);
        }
      }

      const messageRule = findCssRuleBody(componentCss, '.orchid-msg');
      const assistantRule = findCssRuleBody(componentCss, '.orchid-msg-assistant');
      expect(messageRule).toContain('width: 100%;');
      expect(messageRule).toContain('max-width: 100%;');
      expect(assistantRule).toContain('max-width: 100%;');

      const sessionTabSource = fs.readFileSync(
        path.join(RENDERER_ROOT, 'components/SessionTabBar.tsx'),
        'utf8',
      );
      expect(sessionTabSource).not.toMatch(
        /session-tab-active[^"'\n]*(?:bg-base-100|border-base-300)/,
      );
      expect(findCssRuleBody(shellCss, '.session-tab-select')).not.toContain(
        'min-height:',
      );

      const sessionHeaderSource = fs.readFileSync(
        path.join(RENDERER_ROOT, 'components/session-header.tsx'),
        'utf8',
      );
      expect(sessionHeaderSource).not.toMatch(
        /session-header-(?:title|path)[^"']*(?:text-sm|text-xs|font-semibold)/,
      );

      const leftSidebarSource = fs.readFileSync(
        path.join(RENDERER_ROOT, 'components/LeftSidebar.tsx'),
        'utf8',
      );
      expect(leftSidebarSource).toContain('className="session-project-sessions"');
      expect(leftSidebarSource).not.toContain('session-select-badge');
      expect(leftSidebarSource).not.toMatch(/>\s*(?:selected|project)\s*</);
      expect(leftSidebarSource).toMatch(
        /size="md"\s+className=\{`session-settings-btn \$\{activeView === 'settings' \? 'session-item-active' : ''\}`}/,
      );

      for (const selector of [
        '.orchid-thought-content',
        '.orchid-tool-block-content',
        '.orchid-tool-args-stream',
        '.orchid-tool-running-hint',
        '.orchid-tool-result-body',
        '.orchid-live-command-pre',
        '.orchid-live-command-exit',
      ]) {
        expect(findCssRuleBody(componentCss, selector), `${selector} is missing`).toContain(
          'font-size: 1rem;',
        );
      }

      expect(findCssRuleBody(componentCss, '.orchid-thought-content')).toContain(
        'cursor: pointer;',
      );
      expect(findCssRuleBody(componentCss, '.orchid-thought-content:hover')).toContain(
        'background: color-mix(in srgb, var(--color-base-content) 2%, transparent);',
      );
    });
  });

  describe('arbitrary utilities in static class strings', () => {
    it('scans className attributes only (not all TypeScript brackets)', () => {
      const sample = `
        const xs: Array<Record<string, number>> = [{ a: 1 }];
        const idx = items[0];
        const map = tierModels[tier.id];
        return <div className="text-[10px] flex" style={{ width: sizes[i] }} />;
      `;
      const classes = extractStaticClassStrings(sample);
      expect(classes).toEqual(['text-[10px] flex']);
      expect(findArbitraryUtilityTokens(classes[0]!)).toEqual(['text-[10px]']);
    });

    it('does not treat template-expression interiors as static class tokens', () => {
      const sample = `
        <div className={\`flex \${cond ? 'hidden' : 'block'} gap-2\`} />
        <div className={\`grid \${tierModels[tier.id]}\`} />
      `;
      const classes = extractStaticClassStrings(sample);
      const tokens = classes.flatMap(findArbitraryUtilityTokens);
      expect(tokens).toEqual([]);
      expect(classes.some((c) => c.includes('flex'))).toBe(true);
    });

    it('allows only approved arbitrary utilities (zero unapproved)', () => {
      const found = scanArbitraryUtilities();
      const unexpected: string[] = [];
      for (const key of found.keys()) {
        if (APPROVED_ARBITRARY_UTILITIES.has(key)) continue;
        if (BASELINE_ARBITRARY_UTILITIES.has(key)) continue;
        unexpected.push(key);
      }
      expect(
        unexpected,
        `Unapproved arbitrary utilities:\n${unexpected.join('\n')}`,
      ).toEqual([]);
    });

    it('reports zero unapproved arbitrary utilities after U8', () => {
      const found = scanArbitraryUtilities();
      const unapproved = [...found.keys()].filter(
        (k) => !APPROVED_ARBITRARY_UTILITIES.has(k) && !BASELINE_ARBITRARY_UTILITIES.has(k),
      );
      expect(unapproved).toEqual([]);
      expect(found.size).toBeLessThanOrEqual(APPROVED_ARBITRARY_UTILITIES.size);
    });
  });

  describe('reserved component-root redefinitions', () => {
    it('detects top-level reserved redefinitions in CSS', () => {
      const sample = `
        .btn { color: red; }
        .btn-primary:hover { color: blue; }
        .input-area { padding: 4px; }
        .composer .input { border: none; }
        .orchid-panel { display: flex; }
      `;
      const hits = findTopLevelReservedRedefinitions(sample);
      const selectors = hits.map((h) => h.selector);
      expect(selectors).toContain('.btn');
      expect(selectors).toContain('.btn-primary:hover');
      expect(selectors.some((s) => s.includes('input-area'))).toBe(false);
      expect(selectors.some((s) => s.includes('composer'))).toBe(false);
      expect(selectors.some((s) => s.includes('orchid-panel'))).toBe(false);
    });

    it('reports zero top-level reserved redefinitions outside primitives.css', () => {
      const found = scanReservedRedefinitions();
      const unexpected: string[] = [];
      for (const key of found.keys()) {
        if (BASELINE_RESERVED_REDEFINITIONS.has(key)) continue;
        unexpected.push(key);
      }
      expect(
        unexpected,
        `Reserved component-root redefinitions:\n${unexpected.join('\n')}`,
      ).toEqual([]);
      expect(found.size).toBe(0);
    });
  });

  describe('daisyUI removal gate', () => {
    it('ships the primitive engine as the component-class owner', () => {
      expect(fs.existsSync(PRIMITIVES_CSS), 'styles/primitives.css is missing').toBe(true);
      const css = fs.readFileSync(PRIMITIVES_CSS, 'utf8');
      for (const root of ['.btn', '.input', '.select', '.badge', '.alert', '.modal', '.tabs', '.loading']) {
        expect(
          css,
          `primitives.css missing ${root}`,
        ).toMatch(new RegExp(`${escapeRegExp(root)}\\s*[,{}]`));
      }
    });

    it('index.css no longer loads the daisyUI plugin', () => {
      const indexCss = fs.readFileSync(path.join(STYLES_ROOT, 'index.css'), 'utf8');
      expect(indexCss.toLowerCase()).not.toContain('daisyui');
      expect(indexCss).toContain('@import "./primitives.css"');
    });

    it('package.json has no daisyui dependency', () => {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.daisyui).toBeUndefined();
      expect(pkg.devDependencies?.daisyui).toBeUndefined();
    });

    it('styles carry no daisyUI-internal fallback variables', () => {
      const files = walkFiles(STYLES_ROOT, (n) => n.endsWith('.css'));
      const hits: string[] = [];
      for (const file of files) {
        const css = stripCssComments(fs.readFileSync(file, 'utf8'));
        if (css.includes('--fallback-')) hits.push(relRenderer(file));
      }
      expect(hits, `daisyUI fallback vars in: ${hits.join(', ')}`).toEqual([]);
    });

    it('themes carry no daisyUI-only control variables', () => {
      const files = walkFiles(THEMES_ROOT, (n) => n.endsWith('.css'));
      const hits: string[] = [];
      for (const file of files) {
        const css = fs.readFileSync(file, 'utf8');
        for (const banned of ['--depth', '--noise', '--size-field', '--size-selector']) {
          if (css.includes(banned)) hits.push(`${relRenderer(file)}:${banned}`);
        }
      }
      expect(hits, `daisyUI-only vars in: ${hits.join(', ')}`).toEqual([]);
    });

    it('primitive components do not use Tailwind utility class names verbatim', () => {
      // Tailwind ships utilities whose names collide with legacy daisyUI
      // component classes. `.collapse { visibility: collapse }` lands in
      // @layer utilities, so a <details class="collapse"> renders permanently
      // hidden (issue #123: invisible MCP permission rows).
      const disclosureSource = fs.readFileSync(
        path.join(RENDERER_ROOT, 'components/ui/Disclosure.tsx'),
        'utf8',
      );
      const bareUsage = /(?:^|[\s'"`])collapse(?=[\s'"`]|$)/;
      expect(
        bareUsage.test(disclosureSource),
        `Disclosure must not use Tailwind's bare 'collapse' utility class`,
      ).toBe(false);
      const primitivesCss = fs.readFileSync(PRIMITIVES_CSS, 'utf8');
      expect(
        /(?:^|[{}@,\s])\.collapse\b/.test(stripCssComments(primitivesCss)),
        'primitives.css must not declare a bare .collapse component root',
      ).toBe(false);
    });
  });

  describe('approved dynamic style exceptions', () => {
    it('lists approved runtime style component paths', () => {
      for (const rel of APPROVED_DYNAMIC_STYLE_PATHS) {
        expect(fs.existsSync(path.join(RENDERER_ROOT, rel)), rel).toBe(true);
      }
    });

    it('does not flag inline style usage as a static class violation', () => {
      const sample = `
        export function ChatView() {
          return (
            <div
              className="chat-layout"
              style={{ ['--orchid-shell-left']: leftCol, ['--orchid-shell-right']: rightCol }}
            />
          );
        }
      `;
      const tokens = extractStaticClassStrings(sample).flatMap(findArbitraryUtilityTokens);
      expect(tokens).toEqual([]);
    });
  });

  describe('contract documentation', () => {
    it('ships styles/README.md with exception and reserved lists', () => {
      const readmePath = path.join(STYLES_ROOT, 'README.md');
      expect(fs.existsSync(readmePath)).toBe(true);
      const readme = fs.readFileSync(readmePath, 'utf8');
      expect(readme).toMatch(/class selection/i);
      expect(readme).toMatch(/approved exceptions/i);
      expect(readme).toMatch(/DaisyUI/);
      expect(readme).toMatch(/primitives\.css/);
      expect(readme).toMatch(/orchid-/);
      for (const name of REQUIRED_THEMES) {
        expect(readme).toContain(name);
      }
    });
  });

  describe('component-root drift in feature JSX', () => {
    it('does not introduce new component roots outside components/ui/ without baseline', () => {
      const { findings } = scanComponentRootDrift();
      const unexpected = findings.filter((f) => !BASELINE_COMPONENT_ROOT_HITS.has(f));
      expect(
        unexpected,
        `New component roots in feature JSX (baseline: ${BASELINE_COMPONENT_ROOT_HITS.size} hits):\n${unexpected.join('\n')}\n\nTo allowlist new drift, add entries to BASELINE_COMPONENT_ROOT_HITS. To remove drift, migrate to primitives in components/ui/.`,
      ).toEqual([]);
    });

    it('reports drift summary (informational)', () => {
      const { findings } = scanComponentRootDrift();
      const byRoot = new Map<string, number>();
      for (const f of findings) {
        const root = f.split('::')[1]!;
        byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
      }
      const summary = [...byRoot.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}: ${c}`);
      expect(findings.length, `Component-root hits outside ui/ (baseline ${BASELINE_COMPONENT_ROOT_HITS.size}):\n${summary.join('\n')}`).toBeLessThanOrEqual(BASELINE_COMPONENT_ROOT_HITS.size);
    });

    it('total component-root token occurrences do not exceed baseline', () => {
      const { totalTokens } = scanComponentRootDrift();
      expect(
        totalTokens,
        `Component-root total token occurrences (${totalTokens}) exceeded baseline (${BASELINE_COMPONENT_ROOT_TOTAL_TOKENS}). New file::root pairs or increased usage within baselined files.`,
      ).toBeLessThanOrEqual(BASELINE_COMPONENT_ROOT_TOTAL_TOKENS);
    });
  });

  describe('non-token colors in feature CSS', () => {
    it('does not introduce new raw color literals without baseline', () => {
      const found = scanNonTokenColors();
      const unexpected: string[] = [];
      for (const { key, count } of found) {
        const baseCount = BASELINE_NON_TOKEN_COLORS.get(key);
        if (baseCount === undefined) {
          unexpected.push(`${key} (new, ${count} occurrences)`);
        } else if (count > baseCount) {
          unexpected.push(`${key} (${count} > baseline ${baseCount})`);
        }
      }
      expect(
        unexpected,
        `Raw color literal violations:\n${unexpected.join('\n')}\n\nTo allowlist, add/increase in BASELINE_NON_TOKEN_COLORS. To remove, migrate to semantic tokens.`,
      ).toEqual([]);
    });
  });
});
