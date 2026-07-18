import type { ComponentType } from 'react';
import type { CanonicalToolResult, ToolResultFamily } from '../../../shared/types/tool-result';
import { GenericToolResult } from './GenericToolResult';
import { FileChangeToolResult } from './FileChangeToolResult';
import { FileWriteToolResult } from './FileWriteToolResult';
import { FileContentToolResult } from './FileContentToolResult';
import { LiveCommandInline } from '../ToolWidgets/LiveCommandInline';

export interface ToolResultRendererProps {
  canonical: CanonicalToolResult;
  toolName: string;
  /** True only for a live in-flight call; replayed terminal results must not poll. */
  isLive?: boolean;
}

export type ToolResultRenderer = ComponentType<ToolResultRendererProps>;

const familyRenderers = new Map<ToolResultFamily, ToolResultRenderer>();
const toolRenderers = new Map<string, ToolResultRenderer>();
const FAMILY_KEYS = new Set<ToolResultFamily>([
  'file-change', 'file-write', 'file-content', 'directory-entries', 'search-results', 'generic',
]);

for (const family of ['file-change', 'file-write', 'file-content', 'directory-entries', 'search-results', 'generic'] as const) {
  familyRenderers.set(family, GenericToolResult);
}

familyRenderers.set('file-change', FileChangeToolResult);
familyRenderers.set('file-write', FileWriteToolResult);
familyRenderers.set('file-content', FileContentToolResult);

const ExecuteCommandRenderer: ToolResultRenderer = ({ canonical, isLive }) => {
  const value = canonical.data && typeof canonical.data === 'object' && !Array.isArray(canonical.data)
    ? (canonical.data as { value?: unknown }).value
    : null;
  const command = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const commandId = command && typeof command.commandId === 'number'
    ? command.commandId
    : command && typeof command.command_id === 'number'
      ? command.command_id
      : null;
  const commandText = command && typeof command.command === 'string' ? command.command : '';
  const description = command && typeof command.description === 'string' ? command.description : undefined;
  if (isLive && commandId !== null) {
    return <LiveCommandInline commandId={commandId} commandText={commandText} description={description} />;
  }
  return <GenericToolResult canonical={canonical} />;
};

toolRenderers.set('execute_command', ExecuteCommandRenderer);
toolRenderers.set('edit', FileChangeToolResult);
toolRenderers.set('write', FileWriteToolResult);
toolRenderers.set('read', FileContentToolResult);
const builtInToolRenderers = new Map(toolRenderers);

export function registerToolResultRenderer(
  key: string,
  renderer: ToolResultRenderer,
): () => void {
  const normalized = key.toLowerCase();
  const target = FAMILY_KEYS.has(normalized as ToolResultFamily) ? familyRenderers : toolRenderers;
  const previous = target.get(normalized as never);
  target.set(normalized as never, renderer as never);
  return () => {
    if (previous) target.set(normalized as never, previous as never);
    else target.delete(normalized as never);
  };
}

export function resolveToolResultRenderer(
  toolName: string,
  family: ToolResultFamily,
): ToolResultRenderer {
  return toolRenderers.get(toolName.toLowerCase())
    ?? familyRenderers.get(family)
    ?? GenericToolResult;
}

export function clearToolResultRendererRegistry(): void {
  toolRenderers.clear();
  for (const [key, renderer] of builtInToolRenderers) toolRenderers.set(key, renderer);
}

export function rendererRegistrySnapshot(): { tools: string[]; families: string[] } {
  return { tools: [...toolRenderers.keys()], families: [...familyRenderers.keys()] };
}
