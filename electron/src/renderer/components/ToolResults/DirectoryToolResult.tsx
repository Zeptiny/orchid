import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  directoryEntriesDataSchema,
  type DirectoryEntriesData,
  type DirectoryEntry,
} from '../../../shared/types/tool-result-filesystem';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { Alert } from '../ui/Alert';
import { StatusBadge } from '../ui/StatusBadge';

export interface DirectoryToolResultProps {
  canonical: CanonicalToolResult;
}

export interface DirectoryTreeNode {
  entry: DirectoryEntry;
  children: DirectoryTreeNode[];
}

function parentPath(entry: DirectoryEntry): string {
  if (entry.parentPath !== undefined) return entry.parentPath;
  const separator = entry.relativePath.lastIndexOf('/');
  return separator < 0 ? '' : entry.relativePath.slice(0, separator);
}

/** Build a stable tree without sorting or dropping persisted entries. */
export function buildDirectoryTree(data: DirectoryEntriesData): DirectoryTreeNode[] {
  const nodes = new Map<string, DirectoryTreeNode>();
  const order = new Map<string, number>();
  data.entries.forEach((entry, index) => {
    // A duplicate path is still a persisted fact. Keep the first node's path
    // as the identity and use an index suffix for the later row.
    let identity = entry.relativePath;
    while (nodes.has(identity)) identity = `${entry.relativePath}#${index}`;
    nodes.set(identity, { entry, children: [] });
    order.set(identity, index);
  });

  const roots: DirectoryTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentPath(node.entry);
    const parentNode = [...nodes.entries()].find(([candidate]) => candidate === parent)?.[1];
    if (parentNode && parentNode.entry.kind === 'directory') parentNode.children.push(node);
    else roots.push(node);
  }

  const sortByPersistedOrder = (left: DirectoryTreeNode, right: DirectoryTreeNode) => {
    const leftIndex = order.get(left.entry.relativePath) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.entry.relativePath) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  };
  const sortChildren = (node: DirectoryTreeNode) => {
    node.children.sort(sortByPersistedOrder);
    node.children.forEach((child) => sortChildren(child));
  };
  roots.sort(sortByPersistedOrder);
  roots.forEach(sortChildren);
  return roots;
}

function kindLabel(kind: DirectoryEntry['kind']): string {
  return kind === 'directory' ? 'directory' : kind;
}

function metadata(entry: DirectoryEntry): ReactNode {
  return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-base-content/65">
        <StatusBadge tone="ghost" size="xs">{kindLabel(entry.kind)}</StatusBadge>
      <span>depth {entry.depth}</span>
      {entry.size !== undefined && <span>{entry.size} bytes</span>}
      {entry.modifiedAt && <time className="break-all" dateTime={entry.modifiedAt}>{entry.modifiedAt}</time>}
    </span>
  );
}

function statusNotice(canonical: CanonicalToolResult, data: DirectoryEntriesData) {
  if (canonical.status === 'error') {
    return <Alert tone="error" variant="soft" className="mb-2 text-sm">{canonical.error.message}</Alert>;
  }
  if (canonical.status === 'cancelled') {
    return <Alert tone="warning" variant="soft" role="status" className="mb-2 text-sm">Directory listing was cancelled before completion.</Alert>;
  }
  if (canonical.status === 'empty' || data.entries.length === 0) {
    return <Alert tone="info" variant="soft" role="status" className="mb-2 text-sm">The directory is empty.</Alert>;
  }
  if (canonical.status === 'partial' || data.depthLimitReached) {
    return (
      <Alert tone="warning" variant="soft" role="status" className="mb-2 text-sm">
        Depth limit {data.depthLimit} reached; deeper entries may be available.
        {canonical.status === 'partial' && canonical.retrieval && (
          <span className="ml-1" data-retrieval-kind={canonical.retrieval.kind}>
            Retrieve more with {canonical.retrieval.kind === 'rerun' ? 'the directory listing' : 'the stored result'}.
          </span>
        )}
      </Alert>
    );
  }
  return null;
}

interface TreeNodeProps {
  node: DirectoryTreeNode;
  level: number;
  position: number;
  setSize: number;
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
}

function TreeNode({ node, level, position, setSize, expanded, toggle }: TreeNodeProps) {
  const path = node.entry.relativePath;
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && expanded.has(path);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hasChildren) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle(path);
    } else if (event.key === 'ArrowRight' && !isExpanded) {
      event.preventDefault();
      toggle(path);
    } else if (event.key === 'ArrowLeft' && isExpanded) {
      event.preventDefault();
      toggle(path);
    }
  };

  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-setsize={setSize}
      aria-posinset={position}
      aria-expanded={hasChildren ? isExpanded : undefined}
      data-entry-path={path}
      data-entry-kind={node.entry.kind}
      data-entry-depth={node.entry.depth}
      data-depth={node.entry.depth}
      className="min-w-0"
    >
      <button
        type="button"
        className="flex min-w-0 w-full items-start gap-2 rounded-box px-2 py-1 text-left hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ paddingInlineStart: `${Math.min(8, Math.max(0, node.entry.depth)) * 0.75 + 0.5}rem` }}
        onClick={() => hasChildren && toggle(path)}
        onKeyDown={onKeyDown}
        aria-label={`${node.entry.kind} ${path}`}
      >
        <span aria-hidden className="mt-0.5 w-3 shrink-0 text-base-content/60">{hasChildren ? (isExpanded ? '▾' : '▸') : '·'}</span>
        <span title={path} className="min-w-0 flex-1 break-all font-mono text-sm text-base-content/90">{node.entry.name}</span>
        {metadata(node.entry)}
      </button>
      {hasChildren && isExpanded && (
        <div role="group" className="min-w-0">
          {node.children.map((child, index) => (
            <TreeNode
              key={`${child.entry.relativePath}:${index}`}
              node={child}
              level={level + 1}
              position={index + 1}
              setSize={node.children.length}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Complete directory facts as a keyboard-expandable, bounded tree. */
export function DirectoryToolResult({ canonical }: DirectoryToolResultProps) {
  const parsed = directoryEntriesDataSchema.safeParse(canonical.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const tree = useMemo(() => buildDirectoryTree(data), [data]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(data.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.relativePath)),
  );
  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="min-w-0 space-y-2" data-result-family="directory-entries">
      {statusNotice(canonical, data)}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <code className="min-w-0 max-w-full break-all text-sm">{data.root}</code>
        <StatusBadge tone="neutral" outline size="xs">{data.totalEntries} entries</StatusBadge>
        <span className="text-base-content/70">depth {data.depthLimit}</span>
      </div>
      <div role="tree" aria-label={`Directory entries for ${data.root}`} className="min-w-0 max-w-full overflow-x-auto rounded-box border border-base-300/70 py-1">
        {tree.length > 0 ? tree.map((node, index) => (
          <TreeNode key={`${node.entry.relativePath}:${index}`} node={node} level={1} position={index + 1} setSize={tree.length} expanded={expanded} toggle={toggle} />
        )) : <div className="px-3 py-2 text-sm text-base-content/70">No entries returned.</div>}
      </div>
    </div>
  );
}
