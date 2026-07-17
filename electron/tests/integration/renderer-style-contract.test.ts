/**
 * Renderer style contract — U1 baseline.
 *
 * Scans class-bearing source (className / class attributes) and feature CSS
 * for styling-contract violations. Existing violations are recorded as an
 * explicit baseline; the suite fails only when new violations appear.
 *
 * Zero-violation gate is mandatory after U8 cleanup, not U1.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER_ROOT = path.resolve(__dirname, '../../src/renderer');
const STYLES_ROOT = path.join(RENDERER_ROOT, 'styles');
const THEMES_ROOT = path.join(RENDERER_ROOT, 'themes');
const THEMES_INDEX = path.join(THEMES_ROOT, 'index.ts');

/** Required theme names (R7 / plan compatibility). */
export const REQUIRED_THEMES = [
  'default',
  'solarized-light',
  'bluey',
  'windows-xp',
  'green-terminal',
] as const;

/**
 * DaisyUI component roots that must not be redefined in feature CSS.
 * Exact class match only unless listed in RESERVED_MODIFIER_ROOTS.
 */
export const RESERVED_DAISYUI_SELECTORS = [
  'btn',
  'input',
  'select',
  'textarea',
  'alert',
  'badge',
  'status',
  'loading',
  'collapse',
  'modal',
  'tabs',
  'tab',
  'steps',
  'step',
  'dropdown',
  'table',
  'fieldset',
  'card',
  'kbd',
  'tooltip',
  'menu',
  'checkbox',
  'radio',
  'toggle',
  'range',
  'progress',
  'link',
  'divider',
  'avatar',
  'navbar',
  'drawer',
  'hero',
  'footer',
  'stat',
  'toast',
  'file-input',
  'label',
  'join',
  'mask',
  'stack',
  'skeleton',
  'indicator',
  'list',
  'dock',
  'fab',
  'validator',
] as const;

/**
 * Known DaisyUI-style modifiers checked as `root-modifier` (e.g. btn-primary).
 * Intentionally closed-set so product classes like `.footer-left` or `.input-area`
 * are not treated as reserved redefinitions.
 */
const RESERVED_MODIFIERS = [
  'primary',
  'secondary',
  'accent',
  'neutral',
  'info',
  'success',
  'warning',
  'error',
  'ghost',
  'link',
  'outline',
  'active',
  'disabled',
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  'circle',
  'square',
  'wide',
  'block',
  'soft',
  'dash',
  'danger',
] as const;

/** Roots that participate in root-modifier reserved checks. */
const RESERVED_MODIFIER_ROOTS = new Set([
  'btn',
  'badge',
  'alert',
  'menu',
  'tab',
  'tabs',
  'modal',
  'dropdown',
  'card',
  'kbd',
  'tooltip',
  'checkbox',
  'radio',
  'toggle',
  'loading',
  'collapse',
  'select',
  'textarea',
  'table',
  'fieldset',
  'steps',
  'step',
  'status',
  'navbar',
  'drawer',
  'hero',
  'footer',
  'stat',
  'toast',
  'join',
  'mask',
  'stack',
  'skeleton',
  'indicator',
  'list',
  'dock',
  'fab',
  'validator',
  'avatar',
  'divider',
  'link',
  'progress',
  'range',
  'label',
]);

/**
 * Approved static arbitrary utilities that remain intentionally allowed
 * (documented in styles/README.md). Empty at U1 — migration removes baseline
 * entries rather than expanding this set without review.
 */
export const APPROVED_ARBITRARY_UTILITIES: ReadonlySet<string> = new Set([
  // format: "relative/path/from/renderer::token"
]);

/**
 * Approved paths where dynamic inline styles are expected (runtime dimensions,
 * swatches, progress). Not scanned as static class violations.
 */
export const APPROVED_DYNAMIC_STYLE_PATHS: readonly string[] = [
  'components/ChatView.tsx',
  'components/InputArea.tsx',
  'components/ContextGrid.tsx',
  'components/Footer.tsx',
  'components/CommandPalette.tsx',
  'components/Preferences/ScopeToggle.tsx',
  'components/ToolWidgets/LiveCommandInline.tsx',
];

/**
 * Baseline arbitrary utilities present before migration (file::token).
 * New hits outside this set and APPROVED_ARBITRARY_UTILITIES fail the suite.
 */
export const BASELINE_ARBITRARY_UTILITIES: ReadonlySet<string> = new Set([
  'components/CommandPalette.tsx::gap-[1px]',
  'components/CommandPalette.tsx::max-h-[420px]',
  'components/CommandPalette.tsx::min-h-[30px]',
  'components/CommandPalette.tsx::min-h-[32px]',
  'components/CommandPalette.tsx::py-[5px]',
  'components/CommandPalette.tsx::rounded-[10px]',
  'components/CommandPalette.tsx::rounded-[3px]',
  'components/CommandPalette.tsx::rounded-[5px]',
  'components/CommandPalette.tsx::text-[10px]',
  'components/CommandPalette.tsx::text-[11px]',
  'components/CommandPalette.tsx::text-[12px]',
  'components/CommandPalette.tsx::text-[9px]',
  'components/CommandPalette.tsx::w-[min(520px,90%)]',
  'components/CommandPalette.tsx::z-[1000]',
  'components/ConfigView.tsx::grid-cols-[auto_minmax(460px,1fr)]',
  'components/ContextGrid.tsx::rounded-[2px]',
  'components/Preferences/ScopeToggle.tsx::max-w-[280px]',
  'components/Preferences/ScopeToggle.tsx::text-[10px]',
  'components/Providers/ConnectionList.tsx::sm:grid-cols-[auto_1fr]',
  'components/Providers/ConnectionModelsDialog.tsx::grid-cols-[minmax(0,1fr)_auto]',
]);

/**
 * Baseline top-level reserved DaisyUI selector redefinitions (file::selector).
 * Scoped overrides (e.g. `.composer .input`) are inventory-only until U8.
 * U2 removed custom `.btn*` rules (DaisyUI owns buttons in JSX) and moved menu
 * border kills into exceptions.css.
 */
export const BASELINE_RESERVED_REDEFINITIONS: ReadonlySet<string> = new Set([
  'styles/chat.css::.footer',
  'styles/exceptions.css::.menu',
  'styles/exceptions.css::.menu :where(li)',
  'styles/exceptions.css::.menu :where(li) + :where(li)',
  'styles/exceptions.css::.menu li',
]);

// ─── Filesystem helpers ──────────────────────────────────────────────────────

function walkFiles(dir: string, predicate: (name: string) => boolean, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, predicate, acc);
    else if (predicate(ent.name)) acc.push(full);
  }
  return acc;
}

function relRenderer(filePath: string): string {
  return path.relative(RENDERER_ROOT, filePath).split(path.sep).join('/');
}

// ─── Class-bearing source extraction (not all brackets in TS) ────────────────

function stripTemplateExpressions(template: string): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    if (template[i] === '$' && template[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < template.length && depth > 0) {
        if (template[i] === '{') depth += 1;
        else if (template[i] === '}') depth -= 1;
        i += 1;
      }
      out += ' ';
      continue;
    }
    out += template[i];
    i += 1;
  }
  return out;
}

function looksLikeClassString(value: string): boolean {
  const v = value.trim();
  if (!v || !/[a-zA-Z]/.test(v)) return false;
  if (/\s/.test(v)) return true;
  if (/^(?:[a-zA-Z][a-zA-Z0-9@:/._[\]%-]*)$/.test(v)) return true;
  return /(?:^|\s)(?:flex|grid|btn|badge|text-|bg-|p[xytblrse]?-|m[xytblrse]?-|w-|h-|gap-|rounded|border|items-|justify-|min-|max-|overflow|truncate|absolute|relative|fixed|inset-|z-|opacity|shadow|font-|leading-|tracking-|whitespace|cursor-|select-|transition|animate-|loading|alert|modal|collapse|input|sm:|md:|lg:|xl:|hover:|focus:|active:|disabled:)/.test(
    v,
  );
}

/**
 * Extract static class text from className / class attributes only.
 * Skips TypeScript arrays, generics, and other non-class brackets.
 */
export function extractStaticClassStrings(source: string): string[] {
  const results: string[] = [];
  const attrRe = /\bclass(?:Name)?\s*=/g;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(source))) {
    let i = match.index + match[0].length;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (i >= source.length) continue;

    const first = source[i]!;
    if (first === '"' || first === "'") {
      const quote = first;
      i += 1;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          value += source[i]!;
          i += 1;
          if (i < source.length) {
            value += source[i]!;
            i += 1;
          }
          continue;
        }
        value += source[i]!;
        i += 1;
      }
      results.push(value);
      continue;
    }

    if (first !== '{') continue;
    i += 1;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;

    let depth = 1;
    const exprStart = i;
    while (i < source.length && depth > 0) {
      const c = source[i]!;
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        i += 1;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') {
            i += 2;
            continue;
          }
          if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
            i += 2;
            let nested = 1;
            while (i < source.length && nested > 0) {
              if (source[i] === '{') nested += 1;
              else if (source[i] === '}') nested -= 1;
              i += 1;
            }
            continue;
          }
          i += 1;
        }
        i += 1;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }

    const expr = source.slice(exprStart, i - 1);
    let j = 0;
    while (j < expr.length) {
      const c = expr[j]!;
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        j += 1;
        let lit = '';
        while (j < expr.length && expr[j] !== quote) {
          if (expr[j] === '\\') {
            lit += expr[j]!;
            j += 1;
            if (j < expr.length) {
              lit += expr[j]!;
              j += 1;
            }
            continue;
          }
          if (quote === '`' && expr[j] === '$' && expr[j + 1] === '{') {
            lit += ' ';
            j += 2;
            let nested = 1;
            while (j < expr.length && nested > 0) {
              if (expr[j] === '{') nested += 1;
              else if (expr[j] === '}') nested -= 1;
              j += 1;
            }
            continue;
          }
          lit += expr[j]!;
          j += 1;
        }
        j += 1;
        const value = quote === '`' ? stripTemplateExpressions(lit) : lit;
        if (looksLikeClassString(value)) results.push(value);
      } else {
        j += 1;
      }
    }
  }

  return results;
}

/** Tailwind arbitrary-value utilities inside a static class string. */
export function findArbitraryUtilityTokens(classString: string): string[] {
  const tokens: string[] = [];
  for (const raw of classString.split(/\s+/)) {
    const token = raw.trim();
    if (!token) continue;
    // e.g. text-[10px], z-[1000], sm:grid-cols-[auto_1fr], w-[min(520px,90%)]
    if (/^(?:[a-zA-Z0-9@_-]+:)*[a-zA-Z0-9@_-]+\/?-?\[[^\]]+\]$/.test(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

export function scanArbitraryUtilities(rendererRoot = RENDERER_ROOT): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  const files = walkFiles(rendererRoot, (n) => /\.tsx?$/.test(n));
  for (const file of files) {
    const rel = relRenderer(file);
    if (rel.startsWith('themes/')) continue;
    const source = fs.readFileSync(file, 'utf8');
    const found = new Set<string>();
    for (const classString of extractStaticClassStrings(source)) {
      for (const token of findArbitraryUtilityTokens(classString)) {
        found.add(token);
      }
    }
    for (const token of found) {
      const key = `${rel}::${token}`;
      const list = byKey.get(key) ?? [];
      list.push(rel);
      byKey.set(key, list);
    }
  }
  return byKey;
}

// ─── CSS reserved selector detection ─────────────────────────────────────────

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

function isReservedClassName(className: string): boolean {
  for (const root of RESERVED_DAISYUI_SELECTORS) {
    if (className === root) return true;
    if (!RESERVED_MODIFIER_ROOTS.has(root)) continue;
    for (const mod of RESERVED_MODIFIERS) {
      if (className === `${root}-${mod}`) return true;
    }
  }
  return false;
}

/**
 * Find top-level custom rules whose subject is a reserved DaisyUI class.
 * Scoped usage (`.composer .input`) is not counted as a redefinition here.
 */
export function findTopLevelReservedRedefinitions(
  css: string,
): { selector: string; line: number }[] {
  const hits: { selector: string; line: number }[] = [];
  const cleaned = stripCssComments(css);
  const ruleRe = /([^{}@]+)\{/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRe.exec(cleaned))) {
    const selBlock = match[1]!.trim();
    if (!selBlock || selBlock.startsWith('@')) continue;

    for (const part of selBlock.split(',').map((s) => s.trim()).filter(Boolean)) {
      // Leading class of a top-level selector (optional leading combinator-free)
      const leading = part.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!leading) continue;
      const className = leading[1]!;
      if (!isReservedClassName(className)) continue;

      const line = cleaned.slice(0, match.index).split('\n').length;
      const normalized = part.replace(/\s+/g, ' ').slice(0, 160);
      hits.push({ selector: normalized, line });
    }
  }

  return hits;
}

export function scanReservedRedefinitions(stylesRoot = STYLES_ROOT): Map<string, number> {
  const byKey = new Map<string, number>();
  const files = walkFiles(stylesRoot, (n) => n.endsWith('.css'));
  for (const file of files) {
    const rel = relRenderer(file);
    const css = fs.readFileSync(file, 'utf8');
    for (const hit of findTopLevelReservedRedefinitions(css)) {
      const key = `${rel}::${hit.selector}`;
      byKey.set(key, hit.line);
    }
  }
  return byKey;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Renderer style contract', () => {
  describe('theme registry', () => {
    it('registers all five required theme names', () => {
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

    it('allows only approved or baseline arbitrary utilities', () => {
      const found = scanArbitraryUtilities();
      const unexpected: string[] = [];
      for (const key of found.keys()) {
        if (APPROVED_ARBITRARY_UTILITIES.has(key)) continue;
        if (BASELINE_ARBITRARY_UTILITIES.has(key)) continue;
        unexpected.push(key);
      }
      expect(
        unexpected,
        `New arbitrary utilities beyond baseline/approved:\n${unexpected.join('\n')}`,
      ).toEqual([]);
    });

    it('tracks baseline arbitrary utility count for migration progress', () => {
      const found = scanArbitraryUtilities();
      const baselineStillPresent = [...BASELINE_ARBITRARY_UTILITIES].filter((k) => found.has(k));
      // Soft progress signal: baseline may shrink as migration proceeds.
      expect(baselineStillPresent.length).toBeLessThanOrEqual(BASELINE_ARBITRARY_UTILITIES.size);
      expect(found.size).toBeLessThanOrEqual(
        BASELINE_ARBITRARY_UTILITIES.size + APPROVED_ARBITRARY_UTILITIES.size,
      );
    });
  });

  describe('DaisyUI reserved selector redefinitions', () => {
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

    it('allows only baseline top-level reserved redefinitions during migration', () => {
      const found = scanReservedRedefinitions();
      const unexpected: string[] = [];
      for (const key of found.keys()) {
        if (BASELINE_RESERVED_REDEFINITIONS.has(key)) continue;
        unexpected.push(key);
      }
      expect(
        unexpected,
        `New reserved DaisyUI redefinitions beyond baseline:\n${unexpected.join('\n')}`,
      ).toEqual([]);
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
              style={{ gridTemplateColumns: \`\${leftCol} minmax(460px, 1fr) \${rightCol}\` }}
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
      expect(readme).toMatch(/orchid-/);
      for (const name of REQUIRED_THEMES) {
        expect(readme).toContain(name);
      }
    });
  });
});
