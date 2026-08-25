/**
 * Index family bindings — MCP status plus the RAG and AST index surfaces.
 * Progress events go to clients bound to the flushing project path (the
 * same gating as the Electron broadcast); untrusted projects get empty
 * statuses and no-op clears.
 */
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { resolveBoundProjectPath } from '../../session/singleton';
import { getProjectTrustState } from '../../project/trust';
import { getProjectRuntimeRegistry } from '../../project/runtime';
import { getProjectMCPManager } from '../../mcp/project-registry';
import { getStatus as getRagStatus, clearIndex, cancelIndex, indexProject, isIndexing as isRagIndexing } from '../../rag/indexer';
import { cancelProjectRefreshAsync } from '../../indexing/refresh-coordinator';
import { getWorkspaceWatcherState } from '../../indexing/watcher';
import { indexProject as indexAstProject, isIndexing as isAstIndexing } from '../../ast/indexer';
import { ASTStore } from '../../ast/store';
import { withDisposable } from '../../utils/with-disposable';
import type { HostBinding, HostBindingEntries, HostServerSurface } from './types';

export function buildIndexBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('mcp.status', (ctx) => {
    const cwd = resolveBoundProjectPath(ctx.clientId);
    if (cwd == null) return [];
    const runtime = getProjectRuntimeRegistry().get(cwd);
    return getProjectMCPManager(runtime).getStatus();
  });

  bind('rag.status', (ctx) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    if (projectPath == null || getProjectTrustState(projectPath) !== 'trusted') {
      return {
        totalChunks: 0,
        totalFiles: 0,
        lastIndexed: null,
        lastIndexDuration: null,
        lastAutoRefresh: null,
      };
    }
    const status = getRagStatus(projectPath);
    try {
      return {
        ...status,
        watcher: { watching: getWorkspaceWatcherState(projectPath).watching },
      };
    } catch {
      return status;
    }
  });

  bind('rag.index', async (ctx, params: { force?: boolean }) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    const emptyResult = (errors: string[]) => ({
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesDeleted: 0,
      chunksCreated: 0,
      errors,
      durationSeconds: 0,
    });
    if (!projectPath) return emptyResult(['No project folder selected']);
    if (getProjectTrustState(projectPath) !== 'trusted') {
      return emptyResult(['Project folder is not trusted']);
    }
    if (isRagIndexing(projectPath)) {
      return emptyResult(['Indexing already in progress']);
    }
    return indexProject(
      projectPath,
      undefined,
      params.force,
      undefined,
      (progress) => surface.emitToProject(projectPath, IPC_CHANNELS.RAG_PROGRESS, progress),
      {
        config: getProjectRuntimeRegistry().get(projectPath).config,
      },
    );
  });

  bind('rag.clear', async (ctx) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    // Untrusted projects keep their index untouched (no-op clear).
    if (projectPath != null && getProjectTrustState(projectPath) === 'trusted') {
      await cancelIndex(projectPath);
      await cancelProjectRefreshAsync(projectPath);
      clearIndex(projectPath);
    }
    return { status: 'cleared' };
  });

  bind('ast.status', (ctx) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    if (projectPath == null || getProjectTrustState(projectPath) !== 'trusted') {
      return {
        totalFiles: 0,
        totalSymbols: 0,
        lastIndexed: null,
        lastIndexDuration: null,
        lastAutoRefresh: null,
      };
    }
    return withDisposable(
      new ASTStore(projectPath),
      (store) => store.status(),
    );
  });

  bind('ast.index', async (ctx, params: { force?: boolean }) => {
    const projectPath = resolveBoundProjectPath(ctx.clientId);
    const emptyResult = (errors: string[]) => ({
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesDeleted: 0,
      symbolsExtracted: 0,
      errors,
      durationSeconds: 0,
    });
    if (!projectPath) return emptyResult(['No project folder selected']);
    if (getProjectTrustState(projectPath) !== 'trusted') {
      return emptyResult(['Project folder is not trusted']);
    }
    if (isAstIndexing(projectPath)) {
      return emptyResult(['Indexing already in progress']);
    }
    let runtimeConfig;
    try {
      runtimeConfig = getProjectRuntimeRegistry().get(projectPath).config;
    } catch {
      runtimeConfig = undefined;
    }
    return indexAstProject({
      force: params.force,
      projectPath,
      config: runtimeConfig,
      progressCallback: (progress) =>
        surface.emitToProject(projectPath, IPC_CHANNELS.AST_PROGRESS, progress),
    });
  });

  return entries;
}
