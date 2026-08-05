import type { ComponentType } from 'react';
import { z } from 'zod';
import type { CanonicalToolResult, ToolResultFamily } from '../../../shared/types/tool-result';
import { genericToolResultDataSchema } from '../../../shared/types/tool-result';
import { GenericToolResult } from './GenericToolResult';
import { FileChangeToolResult } from './FileChangeToolResult';
import { FileWriteToolResult } from './FileWriteToolResult';
import { FileContentToolResult } from './FileContentToolResult';
import { DirectoryToolResult } from './DirectoryToolResult';
import { SearchToolResult } from './SearchToolResult';
import { ApplyPatchToolResult } from './ApplyPatchToolResult';
import { AskQuestionToolResult } from './AskQuestionToolResult';
import { LiveCommandInline } from '../ToolWidgets/LiveCommandInline';

export interface ToolResultRendererProps {
  canonical: CanonicalToolResult;
  toolName: string;
  /** True only for a live in-flight call. */
  isLive?: boolean;
  /**
   * Owning session live command widgets resolve visibility against. Widget
   * liveness follows the process, not the tool call: replayed background
   * results may poll until the first snapshot reports exited/unavailable,
   * then stop (long-dead sessions cost one snapshot per widget).
   */
  sessionId?: string | null;
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
familyRenderers.set('directory-entries', DirectoryToolResult);
familyRenderers.set('search-results', SearchToolResult);

const backgroundCommandValueSchema = z.object({
  commandId: z.number().int(),
  command: z.string(),
  description: z.string().optional(),
  background: z.literal(true),
  running: z.boolean(),
  // Persisted spawn time (epoch ms) used to detect commandId reuse after an
  // app restart; absent on facts written before the field existed.
  createdAt: z.number().int().optional(),
}).passthrough();

const ExecuteCommandRenderer: ToolResultRenderer = ({ canonical, sessionId }) => {
  const outer = genericToolResultDataSchema.safeParse(canonical.data);
  if (!outer.success) {
    return <GenericToolResult canonical={canonical} />;
  }
  const bg = backgroundCommandValueSchema.safeParse(outer.data.value);
  if (!bg.success) {
    return <GenericToolResult canonical={canonical} />;
  }
  // Liveness follows the process, not the tool call: a replayed background
  // result still renders the live widget, which freezes once the first
  // snapshot reports the command exited or unavailable. Stop propagation so
  // the widget's own controls never collapse the enclosing tool shell.
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <LiveCommandInline
        target={{ commandId: bg.data.commandId }}
        sessionId={sessionId ?? null}
        commandText={bg.data.command}
        description={bg.data.description}
        expectedCreatedAt={bg.data.createdAt}
      />
    </div>
  );
};

toolRenderers.set('execute_command', ExecuteCommandRenderer);
toolRenderers.set('edit', FileChangeToolResult);
toolRenderers.set('write', FileWriteToolResult);
// `read` resolves by family: file-content → FileContentToolResult,
// directory-entries → DirectoryToolResult (read on a directory).
toolRenderers.set('read_directory', DirectoryToolResult);
toolRenderers.set('glob', SearchToolResult);
toolRenderers.set('grep', SearchToolResult);
toolRenderers.set('apply_patch', ApplyPatchToolResult);
toolRenderers.set('ask_question', AskQuestionToolResult);
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
