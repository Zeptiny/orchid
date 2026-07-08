/**
 * Filesystem tools — read, edit, write, read_directory, glob.
 *
 * Each tool exports a `ToolDefinition` and an async `ToolHandler`.
 * Register them with the `ToolRegistry` singleton.
 *
 * Post-write callbacks are shared via `./callbacks` — RAG and AST modules
 * register their update functions there.
 */
export { readDefinition, readHandler, type ReadInput } from './read';
export { editDefinition, editHandler, type EditInput } from './edit';
export { writeDefinition, writeHandler, type WriteInput } from './write';
export { readDirectoryDefinition, readDirectoryHandler, type ReadDirectoryInput } from './read-directory';
export { globDefinition, globHandler, type GlobInput } from './glob';
export {
  registerPostWriteCallback,
  unregisterPostWriteCallback,
  triggerPostWriteCallbacks,
  clearPostWriteCallbacks,
  callbackCount,
  type PostWriteCallback,
} from './callbacks';
