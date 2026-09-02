import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainRoot = resolve(import.meta.dirname, '../../src/main');

const managedStoreFiles = [
  // U5: the one-shot AST status read moved from ipc/ast.ts into the host
  // binding that the handler now routes to.
  'host/server.ts',
  'rag/indexer.ts',
  'ast/indexer.ts',
  'tools/rag/search.ts',
  'tools/ast/find-symbol-references.ts',
  'tools/ast/rename-symbol.ts',
];

describe('RAG/AST one-shot store ownership', () => {
  it.each(managedStoreFiles)('%s manages every store through the disposal helper', (file) => {
    const source = readFileSync(resolve(mainRoot, file), 'utf8');
    const constructors = source.match(/new (?:RAG|AST)Store\(/g) ?? [];
    const managedConstructors = source.match(
      /withDisposable(?:Async)?\(\s*new (?:RAG|AST)Store\(/g,
    ) ?? [];

    expect(constructors.length).toBeGreaterThan(0);
    expect(managedConstructors).toHaveLength(constructors.length);
  });
});
