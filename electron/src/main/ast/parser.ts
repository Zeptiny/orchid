/**
 * AST Parser — tree-sitter WASM integration with lazy grammar loading.
 *
 * Uses `web-tree-sitter` (WASM) for parsing. Grammars are loaded lazily
 * on first use per language. Supports: .py, .js, .jsx, .ts, .tsx.
 *
 * Memory management: callers MUST call tree.delete() after use.
 * Query objects are cached at module level (same as Python) and cleaned
 * up via dispose().
 *
 * Ported from Python `src/orchid/ast/parser.py`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// Resolve package dirs relative to this file (works under dist/ and src/).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const requireFromHere = createRequire(__filename);

// web-tree-sitter exports Parser, Language, and Query as named exports.
// In 0.25+, queries are `new Query(language, source)` — not language.query().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Parser, Language, Query } = require('web-tree-sitter') as {
  Parser: typeof import('web-tree-sitter').Parser;
  Language: typeof import('web-tree-sitter').Language;
  Query: typeof import('web-tree-sitter').Query;
};

// The runtime types from web-tree-sitter are well-defined but the TS declarations
// use a namespace pattern that makes direct type aliasing awkward. Use the
// declaration types from tree-sitter-web.d.ts for documentation, but allow
// the compiler to infer from actual usage.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterTree = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterNode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterLanguage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterQuery = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryResult {
  text: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
  /** The raw tree-sitter SyntaxNode — available for parent traversal. */
  node: TreeSitterNode;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _parserInitialized = false;
const _languages = new Map<string, TreeSitterLanguage>();
const _parsers = new Map<string, InstanceType<typeof Parser>>();
const _compiledQueries = new Map<string, TreeSitterQuery>();
const _queryTexts = new Map<string, string>();

const QUERIES_DIR = path.join(__dirname, 'queries');

const EXT_TO_LANG: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
};

const LANG_TO_QUERY_LANG: Record<string, string> = {
  python: 'python',
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'typescript',
};

/** Filenames web-tree-sitter may request via locateFile (package renamed over versions). */
const RUNTIME_WASM_NAMES = ['web-tree-sitter.wasm', 'tree-sitter.wasm'] as const;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize web-tree-sitter WASM runtime. Idempotent.
 */
async function ensureInitialized(): Promise<void> {
  if (_parserInitialized) return;

  // Locate the runtime WASM (web-tree-sitter.wasm in current package).
  const wasmDir = findWasmDir();
  await Parser.init({
    locateFile(scriptName: string) {
      // Prefer the exact name requested; fall back to known package filenames.
      const preferred = path.join(wasmDir, scriptName);
      if (fs.existsSync(preferred)) return preferred;
      for (const name of RUNTIME_WASM_NAMES) {
        const candidate = path.join(wasmDir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
      return preferred;
    },
  });
  _parserInitialized = true;
}

/**
 * Resolve a package's install directory via require.resolve, with path fallbacks.
 */
function resolvePackageDir(packageName: string, markerFile?: string): string | null {
  try {
    const pkgJson = requireFromHere.resolve(`${packageName}/package.json`);
    return path.dirname(pkgJson);
  } catch {
    // package.json may not be in exports; try main entry
    try {
      const entry = requireFromHere.resolve(packageName);
      let dir = path.dirname(entry);
      // Walk up a couple levels looking for package.json / marker
      for (let i = 0; i < 4; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        if (markerFile && fs.existsSync(path.join(dir, markerFile))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return path.dirname(entry);
    } catch {
      // fall through to path candidates
    }
  }

  const pathCandidates = [
    path.join(__dirname, '..', '..', '..', 'node_modules', packageName),
    path.join(__dirname, '..', '..', '..', '..', 'node_modules', packageName),
  ];
  for (const dir of pathCandidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Find the directory containing the web-tree-sitter runtime WASM.
 *
 * Current packages ship `web-tree-sitter.wasm` (not the older `tree-sitter.wasm`
 * name). Falling back to __dirname caused ENOENT under dist/main/ast/.
 */
function findWasmDir(): string {
  // Prefer the package export when available (web-tree-sitter ≥0.25).
  try {
    const wasmFile = requireFromHere.resolve('web-tree-sitter/web-tree-sitter.wasm');
    if (fs.existsSync(wasmFile)) {
      return path.dirname(wasmFile);
    }
  } catch {
    // fall through
  }

  const pkgDir = resolvePackageDir('web-tree-sitter', 'web-tree-sitter.wasm');
  const candidates = [
    pkgDir,
    path.join(__dirname, '..', '..', '..', 'node_modules', 'web-tree-sitter'),
    path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'web-tree-sitter'),
  ].filter((d): d is string => Boolean(d));

  for (const dir of candidates) {
    for (const name of RUNTIME_WASM_NAMES) {
      if (fs.existsSync(path.join(dir, name))) {
        return dir;
      }
    }
  }

  throw new Error(
    `Could not find web-tree-sitter WASM runtime. Searched: ${candidates.join(', ')}. ` +
      `Install the 'web-tree-sitter' package.`,
  );
}

/**
 * Directories that may contain language grammar WASM files.
 *
 * Prefer `@vscode/tree-sitter-wasm` (built for tree-sitter 0.25+, `dylink.0`)
 * over older packages that ship `dylink`-only modules web-tree-sitter 0.26 rejects.
 */
function grammarSearchPaths(): string[] {
  const paths: string[] = [];
  const vscodeWasms = resolvePackageDir('@vscode/tree-sitter-wasm');
  if (vscodeWasms) {
    paths.push(path.join(vscodeWasms, 'wasm'));
  }
  // Legacy fallback (older dylink format — may fail on web-tree-sitter ≥0.25)
  const legacyWasms = resolvePackageDir('tree-sitter-wasms');
  if (legacyWasms) {
    paths.push(path.join(legacyWasms, 'out'));
  }
  paths.push(
    path.join(__dirname, '..', '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
    path.join(__dirname, 'grammars'),
  );
  return paths;
}

/**
 * Find a WASM grammar file for the given language name.
 */
function findGrammarWasm(langName: string): string {
  const fileName = `tree-sitter-${langName}.wasm`;
  const searchPaths = grammarSearchPaths();

  for (const searchPath of searchPaths) {
    const candidate = path.join(searchPath, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find WASM grammar for '${langName}'. ` +
      `Searched: ${searchPaths.join(', ')}. ` +
      `Install '@vscode/tree-sitter-wasm' or place ${fileName} in ast/grammars/.`,
  );
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Load a tree-sitter language grammar (lazy, cached).
 */
async function loadLanguage(langName: string): Promise<TreeSitterLanguage> {
  if (_languages.has(langName)) {
    return _languages.get(langName)!;
  }

  await ensureInitialized();

  const wasmPath = findGrammarWasm(langName);
  const language = await Language.load(wasmPath);
  _languages.set(langName, language);
  return language;
}

/**
 * Get a parser for the given language (lazy, cached).
 */
async function getParser(langName: string): Promise<InstanceType<typeof Parser>> {
  if (_parsers.has(langName)) {
    return _parsers.get(langName)!;
  }

  const language = await loadLanguage(langName);
  const parser = new Parser();
  parser.setLanguage(language);
  _parsers.set(langName, parser);
  return parser;
}

/**
 * Determine the language name from a file path's extension.
 */
export function langForExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  if (!lang) {
    throw new Error(
      `Unsupported file extension '${ext}'. ` +
      `Supported: ${Object.keys(EXT_TO_LANG).sort().join(', ')}`,
    );
  }
  return lang;
}

/**
 * Parse a file and return the syntax tree.
 *
 * IMPORTANT: Caller must call tree.delete() when done to free WASM memory.
 */
export async function parseFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<TreeSitterTree> {
  const langName = langForExtension(filePath);
  const parser = await getParser(langName);
  const source = typeof content === 'string' ? content : new TextDecoder().decode(content);
  return parser.parse(source);
}

/**
 * Run a tree-sitter query against a parsed tree.
 *
 * Returns a map of capture name -> array of QueryResult.
 *
 * IMPORTANT: Caller must call tree.delete() when done.
 */
export async function runQuery(
  tree: TreeSitterTree,
  langName: string,
  queryText: string,
  source: string,
): Promise<Record<string, QueryResult[]>> {
  const query = await compileQuery(langName, queryText);
  const matches = query.matches(tree.rootNode);

  const results: Record<string, QueryResult[]> = {};

  for (const match of matches) {
    for (const capture of match.captures) {
      const name = capture.name;
      const node = capture.node;
      const text = source.slice(node.startIndex, node.endIndex);

      if (!results[name]) {
        results[name] = [];
      }

      results[name].push({
        text,
        startLine: node.startPosition.row,
        startColumn: node.startPosition.column,
        endLine: node.endPosition.row,
        endColumn: node.endPosition.column,
        startByte: node.startIndex,
        endByte: node.endIndex,
        node,
      });
    }
  }

  return results;
}

/**
 * Load the query text for a given language name.
 */
export async function loadQueryFile(langName: string): Promise<string> {
  const queryLang = LANG_TO_QUERY_LANG[langName];
  if (!queryLang) {
    throw new Error(`No query file for language '${langName}'`);
  }

  if (_queryTexts.has(queryLang)) {
    return _queryTexts.get(queryLang)!;
  }

  const queryFile = path.join(QUERIES_DIR, `${queryLang}.scm`);
  if (!fs.existsSync(queryFile)) {
    throw new Error(`Query file not found: ${queryFile}`);
  }

  const text = fs.readFileSync(queryFile, 'utf-8');
  _queryTexts.set(queryLang, text);
  return text;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compile and cache a tree-sitter query.
 */
async function compileQuery(
  langName: string,
  queryText: string,
): Promise<TreeSitterQuery> {
  const key = `${langName}::${queryText}`;
  if (_compiledQueries.has(key)) {
    return _compiledQueries.get(key)!;
  }

  const language = await loadLanguage(langName);
  const query = new Query(language, queryText);
  _compiledQueries.set(key, query);
  return query;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Dispose of all cached parsers, languages, and queries.
 * Call on process shutdown or when AST module is no longer needed.
 */
export function dispose(): void {
  for (const parser of _parsers.values()) {
    parser.delete();
  }
  _parsers.clear();

  // Language objects don't have delete() in the WASM bindings
  _languages.clear();

  for (const query of _compiledQueries.values()) {
    query.delete();
  }
  _compiledQueries.clear();

  _queryTexts.clear();
  _parserInitialized = false;
}
