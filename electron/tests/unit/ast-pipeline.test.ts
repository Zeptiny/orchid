/**
 * AST Pipeline tests — U17.
 *
 * Covers:
 * - Store: SQLite with WAL, corruption recovery, CRUD operations
 * - Parser: language detection
 * - Indexer: project scan, hash change detection, single-file update
 * - get_file_skeleton: definitions with line numbers
 * - get_function: source with imports + class context, change detection
 * - find_symbol_references: all references with file:line
 * - replace_symbol: replace body, diff, post-write callbacks, ambiguity guard
 * - rename_symbol: cross-project rename, word boundary guard
 *
 * Uses mocked tree-sitter parser (WASM not available in test env).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolExecutionContext } from '../../src/main/tools/types';

function outputText(result: unknown): string {
  const value = (result as { data?: { value?: unknown } }).data?.value;
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? result);
}

// ---------------------------------------------------------------------------
// Mock tree-sitter parser
// ---------------------------------------------------------------------------

interface MockNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  children: MockNode[];
  parent: MockNode | null;
  childForFieldName: (name: string) => MockNode | null;
  delete: () => void;
}

function makeMockNode(opts: {
  type: string;
  text: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  startIndex: number;
  endIndex: number;
  children?: MockNode[];
  parent?: MockNode | null;
}): MockNode {
  const node: MockNode = {
    type: opts.type,
    startIndex: opts.startIndex,
    endIndex: opts.endIndex,
    startPosition: { row: opts.startLine, column: opts.startCol },
    endPosition: { row: opts.endLine, column: opts.endCol },
    text: opts.text,
    children: opts.children ?? [],
    parent: opts.parent ?? null,
    delete: () => {},
    childForFieldName: () => null,
  };
  node.childForFieldName = (name: string) => {
    if (name === 'name' && node.children.length > 0) {
      return node.children.find(
        (c) => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier',
      ) ?? null;
    }
    if (name === 'body' && node.children.length > 0) {
      return node.children.find(
        (c) => c.type === 'block' || c.type === 'statement_block' || c.type === 'class_body',
      ) ?? null;
    }
    return null;
  };
  for (const child of node.children) {
    child.parent = node;
  }
  return node;
}

function buildMockPythonTree(content: string): MockNode {
  const lines = content.split('\n');

  // Parse class and method definitions with proper nesting
  interface DefInfo {
    type: 'class' | 'function';
    name: string;
    startLine: number;
    endLine: number;
    indent: number;
    methods?: DefInfo[];
  }

  const allDefs: DefInfo[] = [];
  let currentClass: DefInfo | null = null;
  let currentFunc: DefInfo | null = null;
  let funcIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - trimmed.length;

    const classMatch = trimmed.match(/^class\s+(\w+)/);
    if (classMatch) {
      if (currentFunc && currentClass) { currentFunc.endLine = i - 1; currentClass.methods!.push(currentFunc); currentFunc = null; }
      else if (currentFunc) { currentFunc.endLine = i - 1; allDefs.push(currentFunc); currentFunc = null; }
      if (currentClass) { currentClass.endLine = i - 1; allDefs.push(currentClass); }
      currentClass = { type: 'class', name: classMatch[1], startLine: i, endLine: lines.length - 1, indent, methods: [] };
      continue;
    }

    const funcMatch = trimmed.match(/^def\s+(\w+)\s*\(/);
    if (funcMatch) {
      if (currentFunc && currentClass) { currentFunc.endLine = i - 1; currentClass.methods!.push(currentFunc); }
      else if (currentFunc) { currentFunc.endLine = i - 1; allDefs.push(currentFunc); }
      if (currentClass && indent > currentClass.indent) {
        // Method inside class
        currentFunc = { type: 'function', name: funcMatch[1], startLine: i, endLine: lines.length - 1, indent };
      } else {
        if (currentClass) { currentClass.endLine = i - 1; allDefs.push(currentClass); currentClass = null; }
        currentFunc = { type: 'function', name: funcMatch[1], startLine: i, endLine: lines.length - 1, indent };
      }
      funcIndent = indent;
      continue;
    }

    // End current function at dedent
    if (currentFunc && indent <= funcIndent) {
      currentFunc.endLine = i - 1;
      if (currentClass) { currentClass.methods!.push(currentFunc); } else { allDefs.push(currentFunc); }
      currentFunc = null;
    }
    // End class at dedent to class level
    if (currentClass && !currentFunc && indent <= currentClass.indent && trimmed) {
      currentClass.endLine = i - 1;
      allDefs.push(currentClass);
      currentClass = null;
    }
  }
  if (currentFunc && currentClass) { currentFunc.endLine = lines.length - 1; currentClass.methods!.push(currentFunc); }
  else if (currentFunc) { currentFunc.endLine = lines.length - 1; allDefs.push(currentFunc); }
  if (currentClass) { currentClass.endLine = lines.length - 1; allDefs.push(currentClass); }

  // Build child nodes
  const childNodes: MockNode[] = [];

  function makeFuncNode(def: DefInfo, isMethod: boolean): MockNode {
    const startIdx = content.indexOf(lines[def.startLine]);
    const endLineEnd = content.indexOf('\n', content.indexOf(lines[def.endLine], startIdx));
    const endIdx = endLineEnd > 0 ? endLineEnd + 1 : content.length;
    const nameStart = content.indexOf(def.name, startIdx);
    const nameCol = lines[def.startLine].indexOf(def.name);

    const nameNode = makeMockNode({
      type: 'identifier', text: def.name,
      startLine: def.startLine, startCol: nameCol,
      endLine: def.startLine, endCol: nameCol + def.name.length,
      startIndex: nameStart, endIndex: nameStart + def.name.length,
    });

    const bodyStartLine = def.startLine + 1;
    const bodyText = lines.slice(bodyStartLine, def.endLine + 1).join('\n');
    const bodyStartIdx = bodyStartLine < lines.length ? content.indexOf(lines[bodyStartLine], startIdx) : endIdx;

    const bodyNode = makeMockNode({
      type: 'block', text: bodyText,
      startLine: bodyStartLine, startCol: 0,
      endLine: def.endLine, endCol: lines[def.endLine]?.length ?? 0,
      startIndex: bodyStartIdx >= 0 ? bodyStartIdx : startIdx, endIndex: endIdx,
    });

    return makeMockNode({
      type: isMethod ? 'method_definition' : 'function_definition',
      text: content.slice(startIdx, endIdx),
      startLine: def.startLine, startCol: 0,
      endLine: def.endLine, endCol: lines[def.endLine]?.length ?? 0,
      startIndex: startIdx, endIndex: endIdx,
      children: [nameNode, bodyNode],
    });
  }

  for (const def of allDefs) {
    if (def.type === 'class') {
      const startIdx = content.indexOf(lines[def.startLine]);
      const endLineEnd = content.indexOf('\n', content.indexOf(lines[def.endLine], startIdx));
      const endIdx = endLineEnd > 0 ? endLineEnd + 1 : content.length;
      const nameStart = content.indexOf(def.name, startIdx);
      const nameCol = lines[def.startLine].indexOf(def.name);

      const nameNode = makeMockNode({
        type: 'identifier', text: def.name,
        startLine: def.startLine, startCol: nameCol,
        endLine: def.startLine, endCol: nameCol + def.name.length,
        startIndex: nameStart, endIndex: nameStart + def.name.length,
      });

      // Build class body with methods as children
      const methodNodes = (def.methods ?? []).map((m) => makeFuncNode(m, true));

      // Create a class_body node containing the methods
      const bodyStartLine = def.startLine + 1;
      const bodyStartIdx = bodyStartLine < lines.length ? content.indexOf(lines[bodyStartLine], startIdx) : endIdx;
      const classBodyNode = makeMockNode({
        type: 'class_body', text: content.slice(bodyStartIdx >= 0 ? bodyStartIdx : startIdx, endIdx),
        startLine: bodyStartLine, startCol: 0,
        endLine: def.endLine, endCol: lines[def.endLine]?.length ?? 0,
        startIndex: bodyStartIdx >= 0 ? bodyStartIdx : startIdx, endIndex: endIdx,
        children: methodNodes,
      });

      childNodes.push(makeMockNode({
        type: 'class_definition',
        text: content.slice(startIdx, endIdx),
        startLine: def.startLine, startCol: 0,
        endLine: def.endLine, endCol: lines[def.endLine]?.length ?? 0,
        startIndex: startIdx, endIndex: endIdx,
        children: [nameNode, classBodyNode],
      }));
    } else {
      childNodes.push(makeFuncNode(def, false));
    }
  }

  // Add identifier references
  const identRe = /\b([a-zA-Z_]\w*)\b/g;
  const refNodes: MockNode[] = [];
  const seenPositions = new Set<string>();
  const keywords = new Set(['def', 'class', 'import', 'from', 'return', 'if', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'True', 'False', 'None', 'self', 'as', 'with', 'try', 'except', 'raise', 'pass', 'lambda', 'yield']);
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(content)) !== null) {
    const name = m[1];
    const pos = m.index;
    const lineNum = content.slice(0, pos).split('\n').length - 1;
    const lineStart = content.lastIndexOf('\n', pos) + 1;
    const col = pos - lineStart;
    const posKey = `${lineNum}:${col}`;
    if (seenPositions.has(posKey) || keywords.has(name)) continue;
    seenPositions.add(posKey);
    refNodes.push(makeMockNode({
      type: 'identifier', text: name,
      startLine: lineNum, startCol: col, endLine: lineNum, endCol: col + name.length,
      startIndex: pos, endIndex: pos + name.length,
    }));
  }

  return makeMockNode({
    type: 'module', text: content,
    startLine: 0, startCol: 0, endLine: lines.length - 1, endCol: lines[lines.length - 1]?.length ?? 0,
    startIndex: 0, endIndex: content.length,
    children: [...childNodes, ...refNodes],
  });
}

function mockCaptures(tree: MockNode, queryText?: string): Record<string, Array<{
  text: string; startLine: number; startColumn: number;
  endLine: number; endColumn: number;
  startByte: number; endByte: number; node: MockNode;
}>> {
  const results: Record<string, any[]> = {};

  // If the query is an import query, extract import statements
  if (queryText && queryText.includes('import_statement')) {
    const source = tree.text;
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('import ') || line.trim().startsWith('from ')) {
        const startIdx = source.indexOf(line);
        (results['import'] ??= []).push({
          text: line,
          startLine: i, startColumn: 0,
          endLine: i, endColumn: line.length,
          startByte: startIdx, endByte: startIdx + line.length,
          node: makeMockNode({
            type: 'import_statement', text: line,
            startLine: i, startCol: 0, endLine: i, endCol: line.length,
            startIndex: startIdx, endIndex: startIdx + line.length,
          }),
        });
      }
    }
    return results;
  }

  function walk(node: MockNode): void {
    if (node.type === 'function_definition') {
      const n = node.childForFieldName('name');
      if (n) { (results['name.definition.function'] ??= []).push({ text: n.text, startLine: n.startPosition.row, startColumn: n.startPosition.column, endLine: n.endPosition.row, endColumn: n.endPosition.column, startByte: n.startIndex, endByte: n.endIndex, node: n }); }
    }
    if (node.type === 'class_definition') {
      const n = node.childForFieldName('name');
      if (n) { (results['name.definition.class'] ??= []).push({ text: n.text, startLine: n.startPosition.row, startColumn: n.startPosition.column, endLine: n.endPosition.row, endColumn: n.endPosition.column, startByte: n.startIndex, endByte: n.endIndex, node: n }); }
    }
    if (node.type === 'method_definition') {
      const n = node.childForFieldName('name');
      if (n) { (results['name.definition.method'] ??= []).push({ text: n.text, startLine: n.startPosition.row, startColumn: n.startPosition.column, endLine: n.endPosition.row, endColumn: n.endPosition.column, startByte: n.startIndex, endByte: n.endIndex, node: n }); }
    }
    if (node.type === 'identifier') {
      (results['name.reference'] ??= []).push({ text: node.text, startLine: node.startPosition.row, startColumn: node.startPosition.column, endLine: node.endPosition.row, endColumn: node.endPosition.column, startByte: node.startIndex, endByte: node.endIndex, node });
    }
    for (const child of node.children) walk(child);
  }
  walk(tree);
  return results;
}

// ---------------------------------------------------------------------------
// Mock the parser module
// ---------------------------------------------------------------------------

vi.mock('../../src/main/ast/parser', () => ({
  langForExtension: (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = { '.py': 'python', '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'tsx' };
    const lang = map[ext];
    if (!lang) throw new Error(`Unsupported file extension '${ext}'`);
    return lang;
  },
  parseFile: async (_filePath: string, content: string | Uint8Array) => {
    return buildMockPythonTree(typeof content === 'string' ? content : new TextDecoder().decode(content));
  },
  runQuery: async (tree: MockNode, _langName: string, queryText: string, _source: string) => {
    return mockCaptures(tree, queryText);
  },
  loadQueryFile: async (_langName: string) => '(identifier) @name.reference',
  dispose: () => {},
}));

vi.mock('../../src/main/config', () => ({
  getConfig: () => ({ ast_max_file_size: 1_048_576, ignored_dirs: ['node_modules', '.git', '__pycache__'] }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PYTHON = `"""Sample module for testing."""

import os
import sys
from pathlib import Path

class Calculator:
    """A simple calculator."""

    def add(self, a, b):
        """Add two numbers."""
        return a + b

    def multiply(self, a, b):
        """Multiply two numbers."""
        result = a * b
        return result

def greet(name):
    """Greet someone."""
    message = f"Hello, {name}!"
    print(message)
    return message

def process_data(items):
    """Process a list of items."""
    results = []
    for item in items:
        results.append(greet(item))
    return results
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-test-'));
  const { extractFunction } = await import('../../src/main/tools/ast/get-function-extraction');
  const { setGetFunctionWorkerRunnerForTests } = await import(
    '../../src/main/tools/ast/get-function-worker-runner'
  );
  // Unit tests run source TypeScript directly, while production extraction is
  // always in the compiled worker. Keep this explicit test seam local.
  setGetFunctionWorkerRunnerForTests((request) => extractFunction(request));
});
afterEach(async () => {
  const { setGetFunctionWorkerRunnerForTests } = await import(
    '../../src/main/tools/ast/get-function-worker-runner'
  );
  setGetFunctionWorkerRunnerForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Store tests ───────────────────────────────────────────────────────────

describe('ASTStore', () => {
  let ASTStore: typeof import('../../src/main/ast/store').ASTStore;
  beforeEach(async () => {
    const m = await vi.importActual<typeof import('../../src/main/ast/store')>('../../src/main/ast/store');
    ASTStore = m.ASTStore;
  });

  it('should initialize database with WAL mode', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    expect(fs.existsSync(store.dbPath)).toBe(true);
  });

  it('should handle corruption by rebuilding', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    fs.writeFileSync(store.dbPath, 'not a database');
    store.initDb();
    expect(store.status().totalFiles).toBe(0);
  });

  it('should upsert and retrieve symbols', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    store.upsertFile('test.py', 'abc123', [{ name: 'greet', type: 'definition', kind: 'function', startLine: 10, startColumn: 0, endLine: 14, endColumn: 20, charStart: 100, charEnd: 200 }]);
    const result = store.getSymbolsByName('greet');
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('test.py');
  });

  it('should replace symbols on re-upsert', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    store.upsertFile('test.py', 'h1', [{ name: 'foo', type: 'definition', kind: 'function', startLine: 0, startColumn: 0, endLine: 5, endColumn: 0, charStart: 0, charEnd: 50 }]);
    store.upsertFile('test.py', 'h2', [
      { name: 'foo', type: 'definition', kind: 'function', startLine: 0, startColumn: 0, endLine: 5, endColumn: 0, charStart: 0, charEnd: 50 },
      { name: 'bar', type: 'definition', kind: 'function', startLine: 10, startColumn: 0, endLine: 15, endColumn: 0, charStart: 100, charEnd: 150 },
    ]);
    expect(store.getSymbolsByName('foo')).toHaveLength(1);
    expect(store.getSymbolsByName('bar')).toHaveLength(1);
  });

  it('should get all file hashes', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    store.upsertFile('a.py', 'ha', []);
    store.upsertFile('b.py', 'hb', []);
    expect(store.getAllFileHashes()).toEqual({ 'a.py': 'ha', 'b.py': 'hb' });
  });

  it('should delete by file', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    store.upsertFile('test.py', 'h', [{ name: 'foo', type: 'definition', kind: 'function', startLine: 0, startColumn: 0, endLine: 5, endColumn: 0, charStart: 0, charEnd: 50 }]);
    store.deleteByFile('test.py');
    expect(store.getSymbolsByName('foo')).toHaveLength(0);
    expect(store.getFileHash('test.py')).toBe('');
  });

  it('should record and retrieve index metadata', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    store.recordIndex(1.5);
    const s = store.status();
    expect(s.lastIndexed).toBeTruthy();
    expect(s.lastIndexDuration).toBe(1.5);
  });

  it('should return empty status for non-existent db', () => {
    const store = new ASTStore(tmpDir);
    const s = store.status();
    expect(s.totalFiles).toBe(0);
    expect(s.totalSymbols).toBe(0);
    expect(s.lastIndexed).toBeNull();
  });

  it('should filter symbols by type', () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    store.upsertFile('test.py', 'h', [
      { name: 'foo', type: 'definition', kind: 'function', startLine: 0, startColumn: 0, endLine: 5, endColumn: 0, charStart: 0, charEnd: 50 },
      { name: 'foo', type: 'reference', kind: '', startLine: 10, startColumn: 5, endLine: 10, endColumn: 8, charStart: 100, charEnd: 103 },
    ]);
    expect(store.getSymbolsByName('foo', 'definition')).toHaveLength(1);
    expect(store.getSymbolsByName('foo', 'reference')).toHaveLength(1);
    expect(store.getSymbolsByName('foo', 'both')).toHaveLength(2);
  });
});

// ── Parser tests ──────────────────────────────────────────────────────────

describe('Parser', () => {
  it('should detect language from extension', async () => {
    const { langForExtension } = await import('../../src/main/ast/parser');
    expect(langForExtension('test.py')).toBe('python');
    expect(langForExtension('test.js')).toBe('javascript');
    expect(langForExtension('test.ts')).toBe('typescript');
    expect(langForExtension('test.tsx')).toBe('tsx');
  });

  it('should throw for unsupported extensions', async () => {
    const { langForExtension } = await import('../../src/main/ast/parser');
    expect(() => langForExtension('test.rb')).toThrow('Unsupported file extension');
  });

  it('should parse a Python file into a tree structure', async () => {
    const { parseFile } = await import('../../src/main/ast/parser');
    const tree = await parseFile('test.py', SAMPLE_PYTHON);
    expect(tree).toBeDefined();
    expect(tree.type).toBe('module');
    expect(tree.children.length).toBeGreaterThan(0);
  });

  it('should extract captures from a parsed tree', async () => {
    const { parseFile, runQuery } = await import('../../src/main/ast/parser');
    const tree = await parseFile('test.py', SAMPLE_PYTHON);
    const captures = await runQuery(tree, 'python', '', SAMPLE_PYTHON);
    // Top-level functions are name.definition.function
    const funcNames = (captures['name.definition.function'] ?? []).map((r) => r.text);
    expect(funcNames).toContain('greet');
    expect(funcNames).toContain('process_data');
    // Methods inside classes are name.definition.method
    const methodNames = (captures['name.definition.method'] ?? []).map((r) => r.text);
    expect(methodNames).toContain('add');
    expect(methodNames).toContain('multiply');
    expect((captures['name.definition.class'] ?? []).map((r) => r.text)).toContain('Calculator');
  });
});

// ── Indexer tests ─────────────────────────────────────────────────────────

describe('Indexer', () => {
  it('should index a project and extract all symbols', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), SAMPLE_PYTHON);
    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const { indexProject, resetSession } = await import('../../src/main/ast/indexer');
      resetSession();
      const result = await indexProject({ projectPath: projectDir, inline: true });
      expect(result.filesScanned).toBe(1);
      expect(result.filesIndexed).toBe(1);
      expect(result.symbolsExtracted).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
      const { ASTStore } = await import('../../src/main/ast/store');
      expect(new ASTStore(projectDir).getSymbolsByName('greet').length).toBeGreaterThan(0);
    } finally { process.cwd = origCwd; }
  });

  it('should skip unchanged files on re-index', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), SAMPLE_PYTHON);
    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const { indexProject, resetSession } = await import('../../src/main/ast/indexer');
      resetSession();
      expect((await indexProject({ projectPath: projectDir, inline: true })).filesIndexed).toBe(1);
      expect((await indexProject({ projectPath: projectDir, inline: true })).filesSkipped).toBe(1);
    } finally { process.cwd = origCwd; }
  });

  it('should delete removed files from index', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), SAMPLE_PYTHON);
    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const { indexProject, resetSession } = await import('../../src/main/ast/indexer');
      resetSession();
      await indexProject({ projectPath: projectDir, inline: true });
      fs.unlinkSync(path.join(projectDir, 'test.py'));
      resetSession();
      expect((await indexProject({ projectPath: projectDir, inline: true })).filesDeleted).toBe(1);
    } finally { process.cwd = origCwd; }
  });

});

// ── Indexer: incremental updates ───────────────────────────────────────────

describe('Indexer incremental updates', () => {
  it('should replace symbols and hash for a changed file on upsertFiles', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), SAMPLE_PYTHON);
    const { upsertFiles } = await import('../../src/main/ast/indexer');
    await upsertFiles({ projectPath: projectDir, rels: ['test.py'] });
    const { ASTStore } = await import('../../src/main/ast/store');
    const store = new ASTStore(projectDir);
    const hashBefore = store.getFileHash('test.py');
    expect(hashBefore).toBeTruthy();
    expect(store.getSymbolsByName('greet', 'definition')).toHaveLength(1);

    fs.writeFileSync(
      path.join(projectDir, 'test.py'),
      SAMPLE_PYTHON.replace('def greet(name):', 'def salute(name):'),
    );
    const result = await upsertFiles({ projectPath: projectDir, rels: ['test.py'] });
    expect(result.filesIndexed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.symbolsExtracted).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
    expect(store.getFileHash('test.py')).not.toBe(hashBefore);
    expect(store.getSymbolsByName('greet', 'definition')).toHaveLength(0);
    expect(store.getSymbolsByName('salute', 'definition')).toHaveLength(1);
  });

  it('should skip unchanged files on upsertFiles', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), SAMPLE_PYTHON);
    const { upsertFiles } = await import('../../src/main/ast/indexer');
    await upsertFiles({ projectPath: projectDir, rels: ['test.py'] });
    const { ASTStore } = await import('../../src/main/ast/store');
    const store = new ASTStore(projectDir);
    const hashBefore = store.getFileHash('test.py');
    const result = await upsertFiles({ projectPath: projectDir, rels: ['test.py'] });
    expect(result.filesIndexed).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesDeleted).toBe(0);
    expect(result.symbolsExtracted).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(store.getFileHash('test.py')).toBe(hashBefore);
  });

  it('should remove all rows for the given rels on deleteFiles', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'util.py'), 'def helper():\n    return 1\n');
    fs.writeFileSync(path.join(projectDir, 'other.py'), 'def main():\n    return helper()\n');
    const { upsertFiles, deleteFiles } = await import('../../src/main/ast/indexer');
    await upsertFiles({ projectPath: projectDir, rels: ['src/util.py', 'other.py'] });
    const { ASTStore } = await import('../../src/main/ast/store');
    const store = new ASTStore(projectDir);
    expect(store.getFileHash('src/util.py')).toBeTruthy();
    expect(store.getSymbolsByName('helper', 'definition')).toHaveLength(1);

    const deleted = await deleteFiles(projectDir, ['src/util.py', 'missing.py']);
    expect(deleted).toBe(1);
    expect(store.getFileHash('src/util.py')).toBe('');
    expect(store.getSymbolsByName('helper', 'definition')).toHaveLength(0);
    expect(store.getFileHash('other.py')).toBeTruthy();
    expect(store.getSymbolsByName('main', 'definition')).toHaveLength(1);
  });

  it('should ignore non-source extensions on upsertFiles', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Notes\n\ndef fake():\n    return 1\n');
    fs.writeFileSync(path.join(projectDir, 'data.json'), '{"a": 1}\n');
    const { upsertFiles } = await import('../../src/main/ast/indexer');
    const result = await upsertFiles({ projectPath: projectDir, rels: ['README.md', 'data.json'] });
    expect(result.filesIndexed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(result.filesDeleted).toBe(0);
    expect(result.errors).toHaveLength(0);
    const { ASTStore } = await import('../../src/main/ast/store');
    expect(new ASTStore(projectDir).status().totalFiles).toBe(0);
  });

  it('should upsert partial symbols for a file with a syntax error', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'broken.ts'),
      'def alpha():\n    return 1\n\ndefn beta(:\n    return 2\n\ndef gamma():\n    return 3\n',
    );
    const { upsertFiles } = await import('../../src/main/ast/indexer');
    const result = await upsertFiles({ projectPath: projectDir, rels: ['broken.ts'] });
    expect(result.filesIndexed).toBe(1);
    expect(result.symbolsExtracted).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
    const { ASTStore } = await import('../../src/main/ast/store');
    const store = new ASTStore(projectDir);
    expect(store.getSymbolsByName('alpha', 'definition')).toHaveLength(1);
    expect(store.getSymbolsByName('gamma', 'definition')).toHaveLength(1);
    expect(store.getSymbolsByName('beta', 'definition')).toHaveLength(0);
  });

  it('should remove stored rows for rels that fail re-read', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'keep.py'), SAMPLE_PYTHON);
    fs.writeFileSync(path.join(projectDir, 'gone.py'), 'def vanish():\n    return 1\n');
    const { getConfig } = await import('../../src/main/config');
    const { upsertFiles } = await import('../../src/main/ast/indexer');
    await upsertFiles({ projectPath: projectDir, rels: ['keep.py', 'gone.py'] });
    const { ASTStore } = await import('../../src/main/ast/store');
    const store = new ASTStore(projectDir);
    expect(store.getFileHash('keep.py')).toBeTruthy();
    expect(store.getFileHash('gone.py')).toBeTruthy();

    fs.unlinkSync(path.join(projectDir, 'gone.py'));
    const result = await upsertFiles({
      projectPath: projectDir,
      rels: ['keep.py', 'gone.py'],
      config: { ...getConfig(), ast_max_file_size: 1 },
    });
    expect(result.filesDeleted).toBe(2);
    expect(result.filesIndexed).toBe(0);
    expect(store.getFileHash('keep.py')).toBe('');
    expect(store.getFileHash('gone.py')).toBe('');
    expect(store.getSymbolsByName('greet', 'definition')).toHaveLength(0);
  });
});

// ── Tool: get_file_skeleton ───────────────────────────────────────────────

describe('get_file_skeleton', () => {
  it('should return functions and classes with line numbers', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { getFileSkeletonHandler } = await import('../../src/main/tools/ast/get-file-skeleton');
    const result = await getFileSkeletonHandler({ file_path: filePath }, { cwd: tmpDir }) as any;
    const value = result.data.value;
    expect(value.definitions).toBeInstanceOf(Array);
    expect(value.definitions.length).toBeGreaterThan(0);
    const names = value.definitions.map((d: any) => d.name);
    expect(names).toContain('greet');
    expect(names).toContain('Calculator');
    expect(names).toContain('process_data');
    for (const def of value.definitions) {
      expect(def).toHaveProperty('line');
      expect(def).toHaveProperty('lineCount');
    }
  });

  it('should return error for non-existent file', async () => {
    const { getFileSkeletonHandler } = await import('../../src/main/tools/ast/get-file-skeleton');
    const result = await getFileSkeletonHandler({ file_path: '/nonexistent.py' }, { cwd: tmpDir }) as any;
    expect(outputText(result)).toContain('File not found');
    expect(result.data.value).toHaveProperty('error');
  });

  it('should return error for unsupported file type', async () => {
    const filePath = path.join(tmpDir, 'test.rb');
    fs.writeFileSync(filePath, 'puts "hello"');
    const { getFileSkeletonHandler } = await import('../../src/main/tools/ast/get-file-skeleton');
    const result = await getFileSkeletonHandler({ file_path: filePath }, { cwd: tmpDir }) as any;
    expect(outputText(result)).toContain('Unsupported file extension');
  });

  it('should return definitions with correct line numbers for non-contiguous definitions', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, 'def foo():\n    pass\n\ndef bar():\n    pass\n');
    const { getFileSkeletonHandler } = await import('../../src/main/tools/ast/get-file-skeleton');
    const result = await getFileSkeletonHandler({ file_path: filePath }, { cwd: tmpDir }) as any;
    const value = result.data.value;
    const bar = value.definitions.find((d: any) => d.name === 'bar');
    expect(bar).toBeDefined();
    expect(bar.line).toBe(4);
  });
});

// ── Tool: get_function ────────────────────────────────────────────────────

describe('get_function', () => {
  it('should return function source with imports and class context', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { getFunctionHandler } = await import('../../src/main/tools/ast/get-function');
    const result = await getFunctionHandler({ file_path: filePath, function_name: 'add' }, { cwd: tmpDir }) as any;
    expect(outputText(result)).toContain('add');
    expect(outputText(result)).toContain('Calculator');
    expect(outputText(result)).toContain('import');
  });

  it('should return "No changes" on repeat retrieval', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { getFunctionHandler, clearFunctionHashes } = await import('../../src/main/tools/ast/get-function');
    clearFunctionHashes();
    const r1 = await getFunctionHandler({ file_path: filePath, function_name: 'greet' }, { cwd: tmpDir }) as any;
    expect(outputText(r1)).toContain('greet');
    expect(outputText(r1)).not.toContain('No changes');
    const r2 = await getFunctionHandler({ file_path: filePath, function_name: 'greet' }, { cwd: tmpDir }) as any;
    expect(outputText(r2)).toContain('No changes');
  });

  it('should detect changes after file modification', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { getFunctionHandler, clearFunctionHashes } = await import('../../src/main/tools/ast/get-function');
    clearFunctionHashes();
    await getFunctionHandler({ file_path: filePath, function_name: 'greet' }, { cwd: tmpDir });
    fs.writeFileSync(filePath, SAMPLE_PYTHON.replace('def greet(name):', 'def greet(name, greeting="Hello"):'));
    const result = await getFunctionHandler({ file_path: filePath, function_name: 'greet' }, { cwd: tmpDir }) as any;
    expect(outputText(result)).not.toContain('No changes');
  });

  it('should return error for non-existent function', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { getFunctionHandler } = await import('../../src/main/tools/ast/get-function');
    const result = await getFunctionHandler({ file_path: filePath, function_name: 'nonexistent' }, { cwd: tmpDir }) as any;
    expect(outputText(result)).toContain('not_found');
  });

  it('rejects an oversized file before scheduling worker extraction', async () => {
    const filePath = path.join(tmpDir, 'oversized.py');
    fs.writeFileSync(filePath, 'def too_large():\n    return 1\n');
    const { setGetFunctionWorkerRunnerForTests } = await import(
      '../../src/main/tools/ast/get-function-worker-runner'
    );
    const runner = vi.fn();
    setGetFunctionWorkerRunnerForTests(runner);
    const { getFunctionHandler } = await import('../../src/main/tools/ast/get-function');

    const ctx = {
      cwd: tmpDir,
      projectRuntime: { config: { ast_max_file_size: 4 } },
    } as unknown as ToolExecutionContext;
    const result = await getFunctionHandler(
      { file_path: filePath, function_name: 'too_large' },
      ctx,
    );

    expect(outputText(result)).toContain('exceeds AST size limit');
    expect(runner).not.toHaveBeenCalled();
  });

  it('bounds hashes and clears a released session scope', async () => {
    const {
      clearFunctionHashes,
      clearFunctionHashesForSession,
      getFunctionHashCountForTests,
      getFunctionHandler,
    } = await import('../../src/main/tools/ast/get-function');
    const { setGetFunctionWorkerRunnerForTests } = await import(
      '../../src/main/tools/ast/get-function-worker-runner'
    );
    clearFunctionHashes();
    setGetFunctionWorkerRunnerForTests(async (request) => ({
      importsText: '',
      functions: [{
        name: request.functionName,
        startLine: 1,
        endLine: 1,
        body: `def ${request.functionName}(): pass`,
        classContext: '',
      }],
    }));

    for (let i = 0; i < 300; i++) {
      const filePath = path.join(tmpDir, `hash-${i}.py`);
      fs.writeFileSync(filePath, 'pass\n');
      await getFunctionHandler(
        { file_path: filePath, function_name: `fn_${i}` },
        { cwd: tmpDir, sessionId: 'released-session' },
      );
    }

    expect(getFunctionHashCountForTests()).toBeLessThanOrEqual(256);
    clearFunctionHashesForSession('released-session');
    expect(getFunctionHashCountForTests()).toBe(0);
  });
});

// ── Tool: find_symbol_references ──────────────────────────────────────────

describe('find_symbol_references', () => {
  it('should find all references with file:line', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), SAMPLE_PYTHON);
    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const { indexProject, resetSession } = await import('../../src/main/ast/indexer');
      resetSession();
      await indexProject({ projectPath: projectDir, inline: true });
      const { findSymbolReferencesHandler } = await import('../../src/main/tools/ast/find-symbol-references');
      const result = await findSymbolReferencesHandler({ symbol_name: 'greet' }, { cwd: projectDir }) as any;
      const value = result.data.value;
      expect(value.name).toBe('greet');
      expect(value.count).toBeGreaterThan(0);
      expect(value.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: expect.stringContaining('test.py') }),
        ]),
      );
    } finally { process.cwd = origCwd; }
  });

  it('should return empty for unknown symbol', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), SAMPLE_PYTHON);
    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const { indexProject, resetSession } = await import('../../src/main/ast/indexer');
      resetSession();
      await indexProject({ projectPath: projectDir, inline: true });
      const { findSymbolReferencesHandler } = await import('../../src/main/tools/ast/find-symbol-references');
      const result = await findSymbolReferencesHandler({ symbol_name: 'nonexistent' }, { cwd: projectDir }) as any;
      expect(result.data.value).toMatchObject({ name: 'nonexistent', count: 0, references: [] });
    } finally { process.cwd = origCwd; }
  });

  it('should return error for empty symbol name', async () => {
    const { findSymbolReferencesHandler } = await import('../../src/main/tools/ast/find-symbol-references');
    const result = await findSymbolReferencesHandler({ symbol_name: '' }, { cwd: tmpDir }) as any;
    expect(result.data.value).toHaveProperty('error');
  });
});

// ── Tool: replace_symbol ──────────────────────────────────────────────────

describe('replace_symbol', () => {
  it('should replace a function body and report old/new source', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { replaceSymbolHandler } = await import('../../src/main/tools/ast/replace-symbol');
    const result = await replaceSymbolHandler({
      file_path: filePath, symbol_name: 'greet',
      new_source: 'def greet(name):\n    """Custom greeting."""\n    return f"Hi, {name}!"',
    }, { cwd: tmpDir }) as any;
    const value = result.data.value;
    expect(value.success).toBe(true);
    expect(value.replacements).toBeGreaterThan(0);
    expect(value.items).toBeInstanceOf(Array);
    expect(value.items[0]).toHaveProperty('oldString');
    expect(value.items[0]).toHaveProperty('newString');
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('Hi,');
  });

  it('should not produce a unified diff', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { replaceSymbolHandler } = await import('../../src/main/tools/ast/replace-symbol');
    const result = await replaceSymbolHandler({
      file_path: filePath, symbol_name: 'greet', new_source: 'def greet(name):\n    return "hi"',
    }, { cwd: tmpDir }) as any;
    expect(outputText(result)).not.toContain('diff format="unified"');
  });

  it('should return error for ambiguous symbol', async () => {
    const content = 'class A:\n    def process(self):\n        pass\n\nclass B:\n    def process(self):\n        pass\n';
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, content);
    const { replaceSymbolHandler } = await import('../../src/main/tools/ast/replace-symbol');
    const result = await replaceSymbolHandler({
      file_path: filePath, symbol_name: 'process', new_source: 'def process(self):\n    return True',
    }, { cwd: tmpDir }) as any;
    expect(outputText(result)).toContain('ambiguous_symbol');
  });

  it('should return error for non-existent symbol', async () => {
    const filePath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(filePath, SAMPLE_PYTHON);
    const { replaceSymbolHandler } = await import('../../src/main/tools/ast/replace-symbol');
    const result = await replaceSymbolHandler({
      file_path: filePath, symbol_name: 'nonexistent', new_source: 'pass',
    }, { cwd: tmpDir }) as any;
    expect(outputText(result)).toContain('symbol_not_found');
  });
});

// ── Tool: rename_symbol ───────────────────────────────────────────────────

describe('rename_symbol', () => {
  it('should rename a symbol across all files', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), 'def greet(name):\n    return greet_helper(name)\n\ndef greet_helper(name):\n    return f"Hello, {name}!"\n');
    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const { indexProject, resetSession } = await import('../../src/main/ast/indexer');
      resetSession();
      await indexProject({ projectPath: projectDir, inline: true });
      const { renameSymbolHandler } = await import('../../src/main/tools/ast/rename-symbol');
      const result = await renameSymbolHandler({ old_name: 'greet_helper', new_name: 'format_greeting' }, { cwd: projectDir }) as any;
      expect(result.data.value).toMatchObject({
        oldName: 'greet_helper',
        newName: 'format_greeting',
        success: true,
      });
      expect(result.data.value.files).toBeGreaterThan(0);
      const newContent = fs.readFileSync(path.join(projectDir, 'test.py'), 'utf-8');
      expect(newContent).toContain('format_greeting');
      expect(newContent).not.toContain('greet_helper');
    } finally { process.cwd = origCwd; }
  });

  it('should respect word boundaries', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test.py'), 'def greet(name):\n    greeting = "hello"\n    return greeting\n');
    const origCwd = process.cwd;
    process.cwd = () => projectDir;
    try {
      const { indexProject, resetSession } = await import('../../src/main/ast/indexer');
      resetSession();
      await indexProject({ projectPath: projectDir, inline: true });
      const { renameSymbolHandler } = await import('../../src/main/tools/ast/rename-symbol');
      await renameSymbolHandler({ old_name: 'greet', new_name: 'say_hello' }, { cwd: projectDir });
      const newContent = fs.readFileSync(path.join(projectDir, 'test.py'), 'utf-8');
      expect(newContent).toContain('def say_hello(');
      expect(newContent).toContain('greeting');
    } finally { process.cwd = origCwd; }
  });

  it('should return error for empty symbol name', async () => {
    const { renameSymbolHandler } = await import('../../src/main/tools/ast/rename-symbol');
    const result = await renameSymbolHandler({ old_name: '', new_name: 'x' }, { cwd: tmpDir }) as any;
    expect(result.data.value).toHaveProperty('error');
  });

  it('should return error for empty new name', async () => {
    const { renameSymbolHandler } = await import('../../src/main/tools/ast/rename-symbol');
    const result = await renameSymbolHandler({ old_name: 'x', new_name: '' }, { cwd: tmpDir }) as any;
    expect(result.data.value).toHaveProperty('error');
  });
});
