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
import { StatusBadge } from '../ui/StatusBadge';

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
familyRenderers.set('directory-entries', DirectoryToolResult);
familyRenderers.set('search-results', SearchToolResult);

const backgroundCommandValueSchema = z.object({
  commandId: z.number().int(),
  command: z.string(),
  description: z.string().optional(),
  background: z.literal(true),
  running: z.boolean(),
}).passthrough();

const STATUS_TONE: Record<string, 'success' | 'error' | 'warning' | 'neutral'> = {
  complete: 'success',
  error: 'error',
  cancelled: 'warning',
  partial: 'neutral',
  empty: 'neutral',
};

function TerminalBackgroundResult({
  command,
  status,
}: {
  command: z.infer<typeof backgroundCommandValueSchema>;
  status: string;
}) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return (
    <div className="orchid-live-command">
      <div className="orchid-live-command-title">
        <span className="font-mono text-xs min-w-0 truncate">
          $ {command.command}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <StatusBadge tone={tone} size="xs">{status}</StatusBadge>
        </span>
      </div>
      {command.description && (
        <div className="orchid-live-command-body">
          <div className="text-xs text-base-content/60 px-2 py-1">{command.description}</div>
        </div>
      )}
    </div>
  );
}

const ExecuteCommandRenderer: ToolResultRenderer = ({ canonical, isLive }) => {
  const outer = genericToolResultDataSchema.safeParse(canonical.data);
  if (!outer.success) {
    return <GenericToolResult canonical={canonical} />;
  }
  const bg = backgroundCommandValueSchema.safeParse(outer.data.value);
  if (!bg.success) {
    return <GenericToolResult canonical={canonical} />;
  }
  if (isLive) {
    return (
      <LiveCommandInline
        commandId={bg.data.commandId}
        commandText={bg.data.command}
        description={bg.data.description}
      />
    );
  }
  return <TerminalBackgroundResult command={bg.data} status={canonical.status} />;
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
