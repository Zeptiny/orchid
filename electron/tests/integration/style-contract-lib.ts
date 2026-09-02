/**
 * Renderer style contract — scanners, vocabularies and baselines.
 *
 * Support library for `renderer-style-contract.test.ts`. Everything here is a
 * pure filesystem/regex scanner: the class-bearing-source extractor, the CSS
 * reserved-selector detector, the component-root drift scanner, the non-token
 * color scanner, and the registries they are checked against.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const RENDERER_ROOT = path.resolve(__dirname, '../../src/renderer');
export const STYLES_ROOT = path.join(RENDERER_ROOT, 'styles');
export const THEMES_ROOT = path.join(RENDERER_ROOT, 'themes');
export const THEMES_INDEX = path.join(THEMES_ROOT, 'index.ts');
export const PRIMITIVES_CSS = path.join(STYLES_ROOT, 'primitives.css');
export const PACKAGE_JSON = path.resolve(__dirname, '../../package.json');

/** Required theme names (R7 / plan compatibility). */
export const REQUIRED_THEMES = [
  'default',
  'light',
  'solarized-light',
  'bluey',
  'windows-xp',
  'green-terminal',
] as const;

/**
 * Component roots owned by `styles/primitives.css`. They must not be
 * redefined anywhere else in feature CSS.
 * Exact class match only unless listed in RESERVED_MODIFIER_ROOTS.
 */
export const RESERVED_COMPONENT_ROOTS = [
  'btn',
  'input',
  'select',
  'textarea',
  'alert',
  'badge',
  'status',
  'loading',
  'orchid-disclosure',
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
 * Known engine modifiers checked as `root-modifier` (e.g. btn-primary).
 * Intentionally closed-set so product classes like `.footer-left` or `.input-area`
 * are not treated as reserved redefinitions.
 */
export const RESERVED_MODIFIERS = [
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
export const RESERVED_MODIFIER_ROOTS = new Set([
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
  'orchid-disclosure',
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
 * Pre-migration reserved root redefinitions (U1). U8 cleared this set:
 * no top-level reserved component-root redefinitions remain outside
 * `styles/primitives.css`.
 */
export const BASELINE_RESERVED_REDEFINITIONS: ReadonlySet<string> = new Set([]);

// ─── Filesystem helpers ──────────────────────────────────────────────────────

function isTypeScriptFile(name: string): boolean {
  return /\.tsx?$/.test(name);
}

function isCssFile(name: string): boolean {
  return name.endsWith('.css');
}

export function walkFiles(dir: string, predicate: (name: string) => boolean, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, predicate, acc);
    else if (predicate(ent.name)) acc.push(full);
  }
  return acc;
}

export function relRenderer(filePath: string): string {
  return path.relative(RENDERER_ROOT, filePath).split(path.sep).join('/');
}

/** Renderer-relative paths for theme definitions. */
function isThemePath(rel: string): boolean {
  return rel.startsWith('themes/');
}

/** Renderer-relative path for the primitive engine itself. */
function isPrimitivesPath(rel: string): boolean {
  return rel === 'styles/primitives.css';
}

/** Renderer-relative path for the stylesheet entrypoint. */
function isStylesEntryPath(rel: string): boolean {
  return rel === 'styles/index.css';
}

/** Renderer-relative paths for the ui/ primitives that legitimately own roots. */
function isUiPrimitivePath(rel: string): boolean {
  return rel.startsWith('components/ui/');
}

// ─── Class-bearing source extraction (not all brackets in TS) ────────────────

function skipWhitespace(source: string, start: number): number {
  let i = start;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  return i;
}

function isQuoteStart(char: string): boolean {
  return char === '"' || char === "'" || char === '`';
}

function isTemplateExpressionAt(source: string, index: number): boolean {
  return source[index] === '$' && source[index + 1] === '{';
}

/** Index just past the `}` that closes the `{` block opened before `start`. */
function skipBraces(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  return i;
}

/** Index just past the quoted run that starts at `start`. */
function skipQuotedRun(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && isTemplateExpressionAt(source, i)) {
      i = skipBraces(source, i + 2);
      continue;
    }
    i += 1;
  }
  return i + 1;
}

/** Index just past the `}` closing the JSX expression brace opened before `start`. */
function skipJsxExpression(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const c = source[i]!;
    if (isQuoteStart(c)) {
      i = skipQuotedRun(source, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return i;
}

/**
 * Read a quoted literal that starts after the opening quote at `start`.
 * Escapes are kept verbatim; template expressions collapse to a single space.
 */
function readStringLiteral(
  source: string,
  start: number,
  quote: string,
): { value: string; next: number } {
  let i = start;
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
    if (quote === '`' && isTemplateExpressionAt(source, i)) {
      value += ' ';
      i = skipBraces(source, i + 2);
      continue;
    }
    value += source[i]!;
    i += 1;
  }
  return { value, next: i + 1 };
}

function stripTemplateExpressions(template: string): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    if (isTemplateExpressionAt(template, i)) {
      i = skipBraces(template, i + 2);
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
    const valueStart = skipWhitespace(source, match.index + match[0].length);
    if (valueStart >= source.length) continue;

    const first = source[valueStart]!;
    if (first === '"' || first === "'") {
      results.push(readStringLiteral(source, valueStart + 1, first).value);
      continue;
    }
    if (first !== '{') continue;

    const exprStart = skipWhitespace(source, valueStart + 1);
    const expr = source.slice(exprStart, skipJsxExpression(source, exprStart) - 1);
    let j = 0;
    while (j < expr.length) {
      const c = expr[j]!;
      if (!isQuoteStart(c)) {
        j += 1;
        continue;
      }
      const literal = readStringLiteral(expr, j + 1, c);
      const value = c === '`' ? stripTemplateExpressions(literal.value) : literal.value;
      j = literal.next;
      if (looksLikeClassString(value)) results.push(value);
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
  const files = walkFiles(rendererRoot, isTypeScriptFile);
  for (const file of files) {
    const rel = relRenderer(file);
    if (isThemePath(rel)) continue;
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

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Return one rule's declarations, including rules nested in an at-layer. */
export function findCssRuleBody(css: string, selector: string): string | null {
  const cleaned = stripCssComments(css);
  const selectorRe = new RegExp(
    `(?:^|[{},])\\s*${escapeRegExp(selector)}(?=\\s*(?:,|\\{))`,
    'm',
  );
  const match = selectorRe.exec(cleaned);
  if (!match) return null;

  const openBrace = cleaned.indexOf('{', match.index + match[0].length);
  if (openBrace < 0) return null;

  let depth = 0;
  for (let index = openBrace; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (char === '{') depth += 1;
    if (char !== '}') continue;
    depth -= 1;
    if (depth === 0) return cleaned.slice(openBrace + 1, index);
  }

  return null;
}

export function isReservedClassName(className: string): boolean {
  for (const root of RESERVED_COMPONENT_ROOTS) {
    if (className === root) return true;
    if (!RESERVED_MODIFIER_ROOTS.has(root)) continue;
    for (const mod of RESERVED_MODIFIERS) {
      if (className === `${root}-${mod}`) return true;
    }
  }
  return false;
}

/** A rule's selector text is custom (not an at-rule) only when non-empty and not `@`-prefixed. */
function isCustomRuleSelector(selectorBlock: string): boolean {
  return selectorBlock !== '' && !selectorBlock.startsWith('@');
}

function selectorPartsOf(selectorBlock: string): string[] {
  return selectorBlock.split(',').map((part) => part.trim()).filter(Boolean);
}

function leadingClassName(selectorPart: string): string | null {
  // Leading class of a top-level selector (optional leading combinator-free)
  const leading = selectorPart.match(/^\.([a-zA-Z0-9_-]+)/);
  return leading ? leading[1]! : null;
}

/**
 * Find top-level custom rules whose subject is a reserved component root.
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
    if (!isCustomRuleSelector(selBlock)) continue;
    const line = cleaned.slice(0, match.index).split('\n').length;

    for (const part of selectorPartsOf(selBlock)) {
      const className = leadingClassName(part);
      if (!className || !isReservedClassName(className)) continue;
      hits.push({ selector: part.replace(/\s+/g, ' ').slice(0, 160), line });
    }
  }

  return hits;
}

export function scanReservedRedefinitions(stylesRoot = STYLES_ROOT): Map<string, number> {
  const byKey = new Map<string, number>();
  const files = walkFiles(stylesRoot, isCssFile);
  for (const file of files) {
    const rel = relRenderer(file);
    // The primitive engine is the sole owner of reserved component roots.
    if (isPrimitivesPath(rel)) continue;
    const css = fs.readFileSync(file, 'utf8');
    for (const hit of findTopLevelReservedRedefinitions(css)) {
      const key = `${rel}::${hit.selector}`;
      byKey.set(key, hit.line);
    }
  }
  return byKey;
}

// ─── Component-root drift in feature JSX ─────────────────────────────────────

const COMPONENT_ROOT_SET = new Set<string>(RESERVED_COMPONENT_ROOTS);

/** Token prefixes that never count as component-root usage (composites, state variants). */
const UNCOUNTERED_TOKEN_PREFIXES = [
  'orchid-',
  'hover:',
  'focus:',
  'active:',
  'disabled:',
] as const;

/** Responsive prefixes stripped before checking the utility that follows them. */
const RESPONSIVE_TOKEN_PREFIXES = ['sm:', 'md:', 'lg:', 'xl:'] as const;

function hasAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function stripAnyPrefix(value: string, prefixes: readonly string[]): string {
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  return prefix ? value.slice(prefix.length) : value;
}

/** The utility part of a token that can name a component root, or null when uncounted. */
function rootCandidate(token: string): string | null {
  if (!token || hasAnyPrefix(token, UNCOUNTERED_TOKEN_PREFIXES)) return null;
  return stripAnyPrefix(token, RESPONSIVE_TOKEN_PREFIXES);
}

export function findComponentRootsInClassString(classString: string): Set<string> {
  const roots = new Set<string>();
  for (const token of classString.split(/\s+/)) {
    const candidate = rootCandidate(token);
    if (candidate === null) continue;
    for (const root of COMPONENT_ROOT_SET) {
      if (candidate === root || candidate.startsWith(`${root}-`)) {
        roots.add(root);
      }
    }
  }
  return roots;
}

export function scanComponentRootDrift(rendererRoot = RENDERER_ROOT): { findings: string[]; totalTokens: number } {
  const findings: string[] = [];
  let totalTokens = 0;
  const files = walkFiles(rendererRoot, isTypeScriptFile);
  for (const file of files) {
    const rel = relRenderer(file);
    if (isUiPrimitivePath(rel) || isThemePath(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const roots = new Set<string>();
    for (const classString of extractStaticClassStrings(source)) {
      for (const root of findComponentRootsInClassString(classString)) {
        roots.add(root);
        totalTokens++;
      }
    }
    for (const root of roots) {
      findings.push(`${rel}::${root}`);
    }
  }
  return { findings: findings.sort(), totalTokens };
}

// ─── Non-token color scanner ─────────────────────────────────────────────────

function makeColorRe(): RegExp {
  return /\b(?:oklch|rgba?|hsla?)\s*\(|#[0-9a-fA-F]{3,8}\b/g;
}

export function scanNonTokenColors(stylesRoot = STYLES_ROOT): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  const files = walkFiles(stylesRoot, isCssFile);
  for (const file of files) {
    const rel = relRenderer(file);
    if (isStylesEntryPath(rel)) continue;
    const css = stripCssComments(fs.readFileSync(file, 'utf8'));
    const colorRe = makeColorRe();
    let match: RegExpExecArray | null;
    while ((match = colorRe.exec(css))) {
      const key = `${rel}:${match[0]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
}

// ─── Baselines (migration-driven shrink targets) ─────────────────────────────

export const BASELINE_COMPONENT_ROOT_HITS: ReadonlySet<string> = new Set([
  'components/CommandPalette.tsx::input',
  'components/ConfigView.tsx::btn',
  'components/ConfigView.tsx::modal',

  'components/ContextRadialButton.tsx::footer',

  'components/InputArea.tsx::alert',
  'components/InputArea.tsx::btn',
  'components/LeftSidebar.tsx::status',

  'components/ModelPicker.tsx::dropdown',
  'components/ModelPicker.tsx::input',
  'components/ModelPicker.tsx::table',
  'components/Onboarding/OnboardingScreen.tsx::step',
  'components/Onboarding/OnboardingScreen.tsx::steps',
  'components/Preferences/AgentsTab.tsx::label',
  'components/Preferences/AgentsTab.tsx::textarea',
  'components/Preferences/DefinitionActions.tsx::btn',
  'components/Preferences/GeneralTab.tsx::label',
  'components/Preferences/GeneralTab.tsx::textarea',
  'components/Preferences/MCPServersTab.tsx::textarea',
  'components/Preferences/PersonalitiesTab.tsx::label',
  'components/Preferences/PersonalitiesTab.tsx::textarea',
  'components/Preferences/ScopeToggle.tsx::join',
  'components/Preferences/SkillsTab.tsx::label',
  'components/Preferences/SkillsTab.tsx::textarea',
  'components/Preferences/SharedPromptsTab.tsx::textarea',
  'components/Providers/ConnectionModelsDialog.tsx::label',
  'components/Providers/ConnectionModelsDialog.tsx::list',
  'components/Providers/ConnectionWizard.tsx::label',
  'components/SessionTabBar.tsx::status',
  'components/ShortcutsHelp.tsx::list',
  'components/Sidebar.tsx::progress',
  'components/session-activity-section.tsx::btn',
  'components/session-activity-section.tsx::status',
]);

/** Total component-root token occurrences captured at baseline time (count guard). */
export const BASELINE_COMPONENT_ROOT_TOTAL_TOKENS = 66;

export const BASELINE_NON_TOKEN_COLORS: ReadonlyMap<string, number> = new Map([
]);
