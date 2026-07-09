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

// web-tree-sitter exports Parser and Language as named exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Parser, Language } = require('web-tree-sitter') as {
  Parser: typeof import('web-tree-sitter').Parser;
  Language: typeof import('web-tree-sitter').Language;
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

// WASM grammar file locations (in order of preference)
const GRAMMAR_SEARCH_PATHS = [
  // tree-sitter-wasms package (npm)
  path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
  path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
  // Local grammars directory
  path.join(__dirname, 'grammars'),
];

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize web-tree-sitter WASM runtime. Idempotent.
 */
async function ensureInitialized(): Promise<void> {
  if (_parserInitialized) return;

  // Locate the tree-sitter WASM binary
  const wasmDir = findWasmDir();
  await Parser.init({
    locateFile(scriptName: string) {
      return path.join(wasmDir, scriptName);
    },
  });
  _parserInitialized = true;
}

/**
 * Find the directory containing tree-sitter.wasm.
 */
function findWasmDir(): string {
  // Check node_modules first (most reliable)
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'node_modules', 'web-tree-sitter'),
    path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'web-tree-sitter'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'tree-sitter.wasm'))) {
      return dir;
    }
  }

  // Fallback: let web-tree-sitter try to find it
  return __dirname;
}

/**
 * Find a WASM grammar file for the given language name.
 */
function findGrammarWasm(langName: string): string {
  const fileName = `tree-sitter-${langName}.wasm`;

  for (const searchPath of GRAMMAR_SEARCH_PATHS) {
    const candidate = path.join(searchPath, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find WASM grammar for '${langName}'. ` +
    `Searched: ${GRAMMAR_SEARCH_PATHS.join(', ')}. ` +
    `Install 'tree-sitter-wasms' or place ${fileName} in ast/grammars/.`,
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
  const query = language.query(queryText);
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
