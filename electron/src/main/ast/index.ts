/**
 * AST module — public API.
 *
 * Re-exports the parser, store, and indexer for convenient access.
 */
export {
  parseFile,
  runQuery,
  loadQueryFile,
  langForExtension,
  dispose as disposeParser,
  type QueryResult,
} from './parser';

export {
  ASTStore,
  type Symbol,
  type SymbolRow,
  type StoreStatus,
  PROJECT_AST_DIR,
  AST_INDEX_DB,
} from './store';

export {
  ensureIndexed,
  updateFile,
  indexProject,
  runIndexProjectImpl,
  isIndexing,
  resetSession,
  type IndexResult,
  type ASTIndexProgressCallback,
} from './indexer';
