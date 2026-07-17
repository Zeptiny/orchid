/**
 * Renderer style contract — U8 zero-violation gate.
 *
 * Scans class-bearing source (className / class attributes) and feature CSS
 * for styling-contract violations. Arbitrary utilities and top-level reserved
 * DaisyUI redefinitions must be zero outside the approved exception registries.
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
 * (documented in styles/README.md). U8 gate: empty — use predefined utilities,
 * orchid-* composites, or dynamic CSS variables instead.
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
 * Pre-migration baseline (U1). U8 cleared this set: zero unapproved arbitrary
 * utilities remain in static class strings.
 */
export const BASELINE_ARBITRARY_UTILITIES: ReadonlySet<string> = new Set([]);

/**
 * Pre-migration reserved DaisyUI redefinitions (U1). U8 cleared this set:
 * no top-level reserved DaisyUI selector redefinitions remain.
 */
export const BASELINE_RESERVED_REDEFINITIONS: ReadonlySet<string> = new Set([]);

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

// ─── DaisyUI class-name drift in feature JSX ─────────────────────────────────

const DAISYUI_ROOT_SET = new Set<string>(RESERVED_DAISYUI_SELECTORS);

function findDaisyUIRootsInClassString(classString: string): Set<string> {
  const roots = new Set<string>();
  for (const token of classString.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('orchid-')) continue;
    if (token.startsWith('hover:') || token.startsWith('focus:') || token.startsWith('active:') || token.startsWith('disabled:')) continue;
    if (token.startsWith('sm:') || token.startsWith('md:') || token.startsWith('lg:') || token.startsWith('xl:')) {
      const inner = token.slice(token.indexOf(':') + 1);
      if (!inner) continue;
      for (const root of DAISYUI_ROOT_SET) {
        if (inner === root || inner.startsWith(`${root}-`)) {
          roots.add(root);
        }
      }
      continue;
    }
    for (const root of DAISYUI_ROOT_SET) {
      if (token === root || token.startsWith(`${root}-`)) {
        roots.add(root);
      }
    }
  }
  return roots;
}

export function scanDaisyUIDrift(rendererRoot = RENDERER_ROOT): string[] {
  const findings: string[] = [];
  const files = walkFiles(rendererRoot, (n) => /\.tsx?$/.test(n));
  for (const file of files) {
    const rel = relRenderer(file);
    if (rel.startsWith('components/ui/')) continue;
    if (rel.startsWith('themes/')) continue;
    const source = fs.readFileSync(file, 'utf8');
    const roots = new Set<string>();
    for (const classString of extractStaticClassStrings(source)) {
      for (const root of findDaisyUIRootsInClassString(classString)) {
        roots.add(root);
      }
    }
    for (const root of roots) {
      findings.push(`${rel}::${root}`);
    }
  }
  return findings.sort();
}

// ─── Non-token color scanner ─────────────────────────────────────────────────

const COLOR_RE = /\b(?:oklch|rgba?|hsla?)\s*\(|#[0-9a-fA-F]{3,8}\b/g;

export function scanNonTokenColors(stylesRoot = STYLES_ROOT): string[] {
  const findings: string[] = [];
  const files = walkFiles(stylesRoot, (n) => n.endsWith('.css'));
  for (const file of files) {
    const rel = relRenderer(file);
    if (rel === 'styles/index.css') continue;
    const css = stripCssComments(fs.readFileSync(file, 'utf8'));
    let match: RegExpExecArray | null;
    COLOR_RE.lastIndex = 0;
    while ((match = COLOR_RE.exec(css))) {
      const before = css.slice(0, match.index);
      const line = before.split('\n').length;
      findings.push(`${rel}:L${line}:${match[0]}`);
    }
  }
  return findings.sort();
}

// ─── chat.css growth guard ───────────────────────────────────────────────────

export function countChatCssLines(stylesRoot = STYLES_ROOT): number {
  const chatPath = path.join(stylesRoot, 'chat.css');
  if (!fs.existsSync(chatPath)) return 0;
  return fs.readFileSync(chatPath, 'utf8').trimEnd().split('\n').length;
}

// ─── Baselines (migration-driven shrink targets) ─────────────────────────────

const BASELINE_DAISYUI_HITS: ReadonlySet<string> = new Set([
  'components/ChatStream.tsx::btn',
  'components/ChatView.tsx::alert',
  'components/ChatView.tsx::btn',
  'components/CommandPalette.tsx::badge',
  'components/CommandPalette.tsx::input',
  'components/ConfigView.tsx::alert',
  'components/ConfigView.tsx::btn',
  'components/ConfigView.tsx::loading',
  'components/ConfigView.tsx::modal',
  'components/ConfigView.tsx::tab',
  'components/ConfigView.tsx::tabs',
  'components/ErrorBanner.tsx::alert',
  'components/ErrorBanner.tsx::btn',
  'components/Footer.tsx::btn',
  'components/Footer.tsx::dropdown',
  'components/Footer.tsx::footer',
  'components/Footer.tsx::loading',
  'components/InputArea.tsx::alert',
  'components/InputArea.tsx::btn',
  'components/LeftSidebar.tsx::btn',
  'components/LeftSidebar.tsx::status',
  'components/MessageWidget.tsx::alert',
  'components/MessageWidget.tsx::loading',
  'components/ModelPicker.tsx::btn',
  'components/ModelPicker.tsx::dropdown',
  'components/ModelPicker.tsx::input',
  'components/ModelPicker.tsx::table',
  'components/Onboarding/OnboardingScreen.tsx::alert',
  'components/Onboarding/OnboardingScreen.tsx::btn',
  'components/Onboarding/OnboardingScreen.tsx::checkbox',
  'components/Onboarding/OnboardingScreen.tsx::select',
  'components/Onboarding/OnboardingScreen.tsx::step',
  'components/Onboarding/OnboardingScreen.tsx::steps',
  'components/Preferences/AgentsTab.tsx::alert',
  'components/Preferences/AgentsTab.tsx::btn',
  'components/Preferences/AgentsTab.tsx::card',
  'components/Preferences/AgentsTab.tsx::input',
  'components/Preferences/AgentsTab.tsx::label',
  'components/Preferences/AgentsTab.tsx::loading',
  'components/Preferences/AgentsTab.tsx::select',
  'components/Preferences/AgentsTab.tsx::textarea',
  'components/Preferences/DefinitionActions.tsx::btn',
  'components/Preferences/GeneralTab.tsx::checkbox',
  'components/Preferences/GeneralTab.tsx::input',
  'components/Preferences/GeneralTab.tsx::label',
  'components/Preferences/GeneralTab.tsx::select',
  'components/Preferences/GeneralTab.tsx::textarea',
  'components/Preferences/MCPServersTab.tsx::btn',
  'components/Preferences/MCPServersTab.tsx::card',
  'components/Preferences/MCPServersTab.tsx::input',
  'components/Preferences/MCPServersTab.tsx::textarea',
  'components/Preferences/ModelAssignments.tsx::alert',
  'components/Preferences/ModelAssignments.tsx::card',
  'components/Preferences/MultiSelectList.tsx::btn',
  'components/Preferences/MultiSelectList.tsx::checkbox',
  'components/Preferences/MultiSelectList.tsx::input',
  'components/Preferences/PersonalitiesTab.tsx::alert',
  'components/Preferences/PersonalitiesTab.tsx::btn',
  'components/Preferences/PersonalitiesTab.tsx::card',
  'components/Preferences/PersonalitiesTab.tsx::input',
  'components/Preferences/PersonalitiesTab.tsx::label',
  'components/Preferences/PersonalitiesTab.tsx::loading',
  'components/Preferences/PersonalitiesTab.tsx::select',
  'components/Preferences/PersonalitiesTab.tsx::textarea',
  'components/Preferences/ProvidersTab.tsx::alert',
  'components/Preferences/ProvidersTab.tsx::btn',
  'components/Preferences/RAGTab.tsx::input',
  'components/Preferences/ScopeToggle.tsx::btn',
  'components/Preferences/ScopeToggle.tsx::join',
  'components/Preferences/SkillsTab.tsx::alert',
  'components/Preferences/SkillsTab.tsx::btn',
  'components/Preferences/SkillsTab.tsx::card',
  'components/Preferences/SkillsTab.tsx::input',
  'components/Preferences/SkillsTab.tsx::label',
  'components/Preferences/SkillsTab.tsx::loading',
  'components/Preferences/SkillsTab.tsx::select',
  'components/Preferences/SkillsTab.tsx::textarea',
  'components/Providers/ConnectionList.tsx::alert',
  'components/Providers/ConnectionList.tsx::btn',
  'components/Providers/ConnectionList.tsx::card',
  'components/Providers/ConnectionModelsDialog.tsx::alert',
  'components/Providers/ConnectionModelsDialog.tsx::badge',
  'components/Providers/ConnectionModelsDialog.tsx::btn',
  'components/Providers/ConnectionModelsDialog.tsx::input',
  'components/Providers/ConnectionModelsDialog.tsx::label',
  'components/Providers/ConnectionModelsDialog.tsx::list',
  'components/Providers/ConnectionWizard.tsx::alert',
  'components/Providers/ConnectionWizard.tsx::btn',
  'components/Providers/ConnectionWizard.tsx::checkbox',
  'components/Providers/ConnectionWizard.tsx::input',
  'components/Providers/ConnectionWizard.tsx::label',
  'components/Providers/ConnectionWizard.tsx::select',
  'components/Providers/ProviderStatus.tsx::alert',
  'components/Providers/ProviderStatus.tsx::btn',
  'components/SessionNameEditor.tsx::input',
  'components/SessionTabBar.tsx::btn',
  'components/SessionTabBar.tsx::status',
  'components/ShortcutsHelp.tsx::list',
  'components/Sidebar.tsx::btn',
  'components/Sidebar.tsx::loading',
  'components/Sidebar.tsx::progress',
  'components/ToolActivityGroup.tsx::badge',
  'components/ToolActivityGroup.tsx::loading',
  'components/ToolCallBlock.tsx::loading',
  'components/ToolWidgets/LiveCommandInline.tsx::loading',
  'components/session-activity-section.tsx::btn',
  'components/session-activity-section.tsx::status',
]);

const BASELINE_NON_TOKEN_COLORS: ReadonlySet<string> = new Set([
  'styles/chat.css:L1501:#000',
  'styles/chat.css:L1585:#000',
  'styles/chat.css:L1595:#000',
  'styles/chat.css:L585:oklch(',
  'styles/chat.css:L586:oklch(',
  'styles/chat.css:L663:oklch(',
  'styles/chat.css:L672:oklch(',
  'styles/chat.css:L674:oklch(',
  'styles/chat.css:L683:oklch(',
  'styles/chat.css:L684:oklch(',
  'styles/chat.css:L715:oklch(',
  'styles/chat.css:L723:oklch(',
  'styles/chat.css:L724:oklch(',
  'styles/chat.css:L725:oklch(',
  'styles/components.css:L38:#000',
  'styles/components.css:L726:#000',
  'styles/components.css:L734:#000',
]);

const CHAT_CSS_BASELINE_LINES = 2016;

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

    it('reports zero top-level reserved DaisyUI redefinitions after U8', () => {
      const found = scanReservedRedefinitions();
      const unexpected: string[] = [];
      for (const key of found.keys()) {
        if (BASELINE_RESERVED_REDEFINITIONS.has(key)) continue;
        unexpected.push(key);
      }
      expect(
        unexpected,
        `Reserved DaisyUI redefinitions:\n${unexpected.join('\n')}`,
      ).toEqual([]);
      expect(found.size).toBe(0);
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
      expect(readme).toMatch(/orchid-/);
      for (const name of REQUIRED_THEMES) {
        expect(readme).toContain(name);
      }
    });
  });

  describe('DaisyUI class-name drift in feature JSX', () => {
    it('does not introduce new DaisyUI roots outside components/ui/ without baseline', () => {
      const found = scanDaisyUIDrift();
      const unexpected = found.filter((f) => !BASELINE_DAISYUI_HITS.has(f));
      expect(
        unexpected,
        `New DaisyUI roots in feature JSX (baseline: ${BASELINE_DAISYUI_HITS.size} hits):\n${unexpected.join('\n')}\n\nTo allowlist new drift, add entries to BASELINE_DAISYUI_HITS. To remove drift, migrate to primitives in components/ui/.`,
      ).toEqual([]);
    });

    it('reports drift summary (informational)', () => {
      const found = scanDaisyUIDrift();
      const byRoot = new Map<string, number>();
      for (const f of found) {
        const root = f.split('::')[1]!;
        byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
      }
      const summary = [...byRoot.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}: ${c}`);
      expect(found.length, `DaisyUI hits outside ui/ (baseline ${BASELINE_DAISYUI_HITS.size}):\n${summary.join('\n')}`).toBeLessThanOrEqual(BASELINE_DAISYUI_HITS.size);
    });
  });

  describe('chat.css growth guard', () => {
    it('chat.css line count does not exceed baseline', () => {
      const lines = countChatCssLines();
      expect(
        lines,
        `chat.css grew to ${lines} lines (baseline ${CHAT_CSS_BASELINE_LINES}). Do not add new rules; migrate surfaces to components.css or primitives.`,
      ).toBeLessThanOrEqual(CHAT_CSS_BASELINE_LINES);
    });
  });

  describe('non-token colors in feature CSS', () => {
    it('does not introduce new raw color literals without baseline', () => {
      const found = scanNonTokenColors();
      const unexpected = found.filter((f) => !BASELINE_NON_TOKEN_COLORS.has(f));
      expect(
        unexpected,
        `New raw color literals in feature CSS (baseline: ${BASELINE_NON_TOKEN_COLORS.size} hits):\n${unexpected.join('\n')}\n\nTo allowlist, add to BASELINE_NON_TOKEN_COLORS. To remove, migrate to semantic tokens.`,
      ).toEqual([]);
    });
  });
});
