/**
 * Unit tests for compact tool-activity grouping helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  foldActivityRuns,
  foldConsecutiveGroupableTools,
  isGroupableTool,
  summarizeToolGroup,
  toolFamily,
  type ActivityClassify,
  type ToolGroupMember,
} from '../../src/renderer/utils/tool-grouping';

function member(
  id: string,
  toolName: string,
  status: string = 'completed',
): ToolGroupMember {
  return { id, toolName, status };
}

describe('isGroupableTool / toolFamily', () => {
  it('marks explore tools as groupable (scheme B)', () => {
    expect(isGroupableTool('grep')).toBe(true);
    expect(isGroupableTool('glob')).toBe(true);
    expect(isGroupableTool('rag_search')).toBe(true);
    expect(isGroupableTool('read')).toBe(true);
    expect(isGroupableTool('read_directory')).toBe(true);
    expect(isGroupableTool('web_fetch')).toBe(true);
    expect(isGroupableTool('find_symbol_references')).toBe(true);
    expect(isGroupableTool('get_function')).toBe(true);
    expect(isGroupableTool('get_file_skeleton')).toBe(true);
    expect(isGroupableTool('GREP')).toBe(true);
  });

  it('keeps mutations solo (not groupable)', () => {
    expect(isGroupableTool('edit')).toBe(false);
    expect(isGroupableTool('write')).toBe(false);
    expect(isGroupableTool('execute_command')).toBe(false);
    expect(isGroupableTool('todo_create')).toBe(false);
    expect(isGroupableTool('replace_symbol')).toBe(false);
    expect(isGroupableTool('rename_symbol')).toBe(false);
    expect(isGroupableTool('rag_index')).toBe(false);
  });

  it('maps families (scheme B)', () => {
    expect(toolFamily('grep')).toBe('search');
    expect(toolFamily('glob')).toBe('search');
    expect(toolFamily('rag_search')).toBe('search');
    expect(toolFamily('read')).toBe('read');
    expect(toolFamily('read_directory')).toBe('read');
    expect(toolFamily('web_fetch')).toBe('fetch');
    expect(toolFamily('find_symbol_references')).toBe('ast');
    expect(toolFamily('get_function')).toBe('ast');
    expect(toolFamily('get_file_skeleton')).toBe('ast');
    expect(toolFamily('edit')).toBe('other');
  });
});

describe('summarizeToolGroup', () => {
  it('builds Searched / Read copy with invocation counts', () => {
    const summary = summarizeToolGroup([
      member('1', 'grep'),
      member('2', 'grep'),
      member('3', 'glob'),
      member('4', 'read'),
      member('5', 'read'),
    ]);
    expect(summary.title).toBe('Searched 3 patterns · Read 2 files');
    expect(summary.searchCount).toBe(3);
    expect(summary.readCount).toBe(2);
    expect(summary.failedCount).toBe(0);
    expect(summary.hasActive).toBe(false);
  });

  it('builds finer B families: fetch + ast separate from read', () => {
    const summary = summarizeToolGroup([
      member('1', 'rag_search'),
      member('2', 'read'),
      member('3', 'web_fetch'),
      member('4', 'web_fetch'),
      member('5', 'get_function'),
      member('6', 'find_symbol_references'),
    ]);
    expect(summary.title).toBe(
      'Searched 1 pattern · Read 1 file · Fetched 2 URLs · Inspected 2 symbols',
    );
    expect(summary.searchCount).toBe(1);
    expect(summary.readCount).toBe(1);
    expect(summary.fetchCount).toBe(2);
    expect(summary.astCount).toBe(2);
  });

  it('appends failed count', () => {
    const summary = summarizeToolGroup([
      member('1', 'grep', 'failed'),
      member('2', 'read', 'completed'),
      member('3', 'read', 'failed'),
    ]);
    expect(summary.title).toBe('Searched 1 pattern · Read 2 files · 2 failed');
    expect(summary.hasFailed).toBe(true);
    expect(summary.failedCount).toBe(2);
  });

  it('singular forms', () => {
    expect(summarizeToolGroup([member('1', 'grep')]).title).toBe(
      'Searched 1 pattern',
    );
    expect(summarizeToolGroup([member('1', 'read')]).title).toBe('Read 1 file');
    expect(summarizeToolGroup([member('1', 'web_fetch')]).title).toBe(
      'Fetched 1 URL',
    );
    expect(summarizeToolGroup([member('1', 'get_function')]).title).toBe(
      'Inspected 1 symbol',
    );
  });
});

describe('foldConsecutiveGroupableTools', () => {
  type Item =
    | { kind: 'msg'; text: string }
    | { kind: 'tool'; id: string; toolName: string }
    | { kind: 'group'; ids: string[] };

  function fold(items: Item[]): Item[] {
    return foldConsecutiveGroupableTools(items, {
      asTool: (item) =>
        item.kind === 'tool'
          ? { id: item.id, toolName: item.toolName, status: 'completed' }
          : null,
      makeTool: (_m, source) => source,
      makeGroup: (members) => ({
        kind: 'group',
        ids: members.map((m) => m.id),
      }),
    });
  }

  it('groups consecutive groupable tools (n >= 2)', () => {
    const result = fold([
      { kind: 'msg', text: 'hi' },
      { kind: 'tool', id: 'a', toolName: 'grep' },
      { kind: 'tool', id: 'b', toolName: 'read' },
      { kind: 'tool', id: 'c', toolName: 'read' },
      { kind: 'msg', text: 'done' },
    ]);
    expect(result).toEqual([
      { kind: 'msg', text: 'hi' },
      { kind: 'group', ids: ['a', 'b', 'c'] },
      { kind: 'msg', text: 'done' },
    ]);
  });

  it('does not group a single groupable tool', () => {
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'read' },
      { kind: 'msg', text: 'x' },
    ]);
    expect(result).toEqual([
      { kind: 'tool', id: 'a', toolName: 'read' },
      { kind: 'msg', text: 'x' },
    ]);
  });

  it('breaks groups on mutations (solo)', () => {
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'grep' },
      { kind: 'tool', id: 'b', toolName: 'read' },
      { kind: 'tool', id: 'c', toolName: 'edit' },
      { kind: 'tool', id: 'd', toolName: 'read' },
      { kind: 'tool', id: 'e', toolName: 'read' },
    ]);
    expect(result).toEqual([
      { kind: 'group', ids: ['a', 'b'] },
      { kind: 'tool', id: 'c', toolName: 'edit' },
      { kind: 'group', ids: ['d', 'e'] },
    ]);
  });

  it('breaks groups on assistant text between tools', () => {
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'grep' },
      { kind: 'tool', id: 'b', toolName: 'grep' },
      { kind: 'msg', text: 'mid' },
      { kind: 'tool', id: 'c', toolName: 'read' },
      { kind: 'tool', id: 'd', toolName: 'read' },
    ]);
    expect(result).toEqual([
      { kind: 'group', ids: ['a', 'b'] },
      { kind: 'msg', text: 'mid' },
      { kind: 'group', ids: ['c', 'd'] },
    ]);
  });
});

describe('foldActivityRuns (settled only; active stays solo)', () => {
  type Item =
    | { kind: 'text'; text: string }
    | { kind: 'thought'; id: string; streaming?: boolean }
    | {
        kind: 'tool';
        id: string;
        toolName: string;
        status?: 'completed' | 'failed' | 'running' | 'generating' | 'pending';
      }
    | { kind: 'group'; parts: string[] };

  function fold(items: Item[]): Item[] {
    return foldActivityRuns(items, {
      classify: (item): ActivityClassify => {
        if (item.kind === 'thought') {
          return item.streaming ? 'active' : 'settled-thought';
        }
        if (item.kind === 'tool' && isGroupableTool(item.toolName)) {
          const status = item.status ?? 'completed';
          if (
            status === 'running' ||
            status === 'generating' ||
            status === 'pending'
          ) {
            return 'active';
          }
          return 'settled-tool';
        }
        return 'break';
      },
      makeGroup: (sources) => ({
        kind: 'group',
        parts: sources.map((s) => {
          if (s.kind === 'thought') return `t:${s.id}`;
          if (s.kind === 'tool') return `tool:${s.id}`;
          return '?';
        }),
      }),
    });
  }

  it('merges finished thoughts + tools (screenshot case when all done)', () => {
    const result = fold([
      { kind: 'thought', id: '1' },
      { kind: 'tool', id: 'g1', toolName: 'grep' },
      { kind: 'tool', id: 'r1', toolName: 'read' },
      { kind: 'thought', id: '2' },
      { kind: 'tool', id: 'r2', toolName: 'read' },
      { kind: 'tool', id: 'r3', toolName: 'read' },
      { kind: 'thought', id: '3' },
    ]);
    expect(result).toEqual([
      {
        kind: 'group',
        parts: ['t:1', 'tool:g1', 'tool:r1', 't:2', 'tool:r2', 'tool:r3', 't:3'],
      },
    ]);
    expect(
      summarizeToolGroup([
        member('g1', 'grep'),
        member('r1', 'read'),
        member('r2', 'read'),
        member('r3', 'read'),
      ]).title,
    ).toBe('Searched 1 pattern · Read 3 files');
  });

  it('does not group finished tool with running tool', () => {
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'read', status: 'completed' },
      { kind: 'tool', id: 'b', toolName: 'read', status: 'running' },
    ]);
    expect(result).toEqual([
      { kind: 'tool', id: 'a', toolName: 'read', status: 'completed' },
      { kind: 'tool', id: 'b', toolName: 'read', status: 'running' },
    ]);
  });

  it('groups two finished tools', () => {
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'read', status: 'completed' },
      { kind: 'tool', id: 'b', toolName: 'read', status: 'completed' },
    ]);
    expect(result).toEqual([
      { kind: 'group', parts: ['tool:a', 'tool:b'] },
    ]);
  });

  it('keeps streaming reasoning solo (does not group)', () => {
    const result = fold([
      { kind: 'thought', id: '1', streaming: true },
      { kind: 'tool', id: 'a', toolName: 'read', status: 'completed' },
    ]);
    // Streaming thought flushes before settled tool; single tool alone → no group
    expect(result).toEqual([
      { kind: 'thought', id: '1', streaming: true },
      { kind: 'tool', id: 'a', toolName: 'read', status: 'completed' },
    ]);
  });

  it('groups finished tools + finished thoughts; leaves running tool solo', () => {
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'grep', status: 'completed' },
      { kind: 'tool', id: 'b', toolName: 'read', status: 'completed' },
      { kind: 'thought', id: '1' },
      { kind: 'tool', id: 'c', toolName: 'read', status: 'running' },
    ]);
    expect(result).toEqual([
      { kind: 'group', parts: ['tool:a', 'tool:b', 't:1'] },
      { kind: 'tool', id: 'c', toolName: 'read', status: 'running' },
    ]);
  });

  it('leaves generating tool solo', () => {
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'grep', status: 'completed' },
      { kind: 'tool', id: 'b', toolName: 'grep', status: 'generating' },
    ]);
    expect(result).toEqual([
      { kind: 'tool', id: 'a', toolName: 'grep', status: 'completed' },
      { kind: 'tool', id: 'b', toolName: 'grep', status: 'generating' },
    ]);
  });

  it('after running tool finishes, consecutive finished tools group', () => {
    // Same sequence once b completes
    const result = fold([
      { kind: 'tool', id: 'a', toolName: 'read', status: 'completed' },
      { kind: 'tool', id: 'b', toolName: 'read', status: 'completed' },
    ]);
    expect(result).toEqual([
      { kind: 'group', parts: ['tool:a', 'tool:b'] },
    ]);
  });

  it('groups single finished tool when flanked by finished thoughts', () => {
    const result = fold([
      { kind: 'thought', id: '1' },
      { kind: 'tool', id: 'r1', toolName: 'read' },
    ]);
    expect(result).toEqual([
      { kind: 'group', parts: ['t:1', 'tool:r1'] },
    ]);
  });

  it('leaves thought-only runs ungrouped', () => {
    const result = fold([
      { kind: 'thought', id: '1' },
      { kind: 'thought', id: '2' },
      { kind: 'text', text: 'answer' },
    ]);
    expect(result).toEqual([
      { kind: 'thought', id: '1' },
      { kind: 'thought', id: '2' },
      { kind: 'text', text: 'answer' },
    ]);
  });

  it('breaks on mutations and assistant text', () => {
    const result = fold([
      { kind: 'thought', id: '1' },
      { kind: 'tool', id: 'r1', toolName: 'read' },
      { kind: 'tool', id: 'r2', toolName: 'read' },
      { kind: 'tool', id: 'e1', toolName: 'edit' },
      { kind: 'thought', id: '2' },
      { kind: 'tool', id: 'r3', toolName: 'read' },
      { kind: 'text', text: 'mid' },
      { kind: 'tool', id: 'g1', toolName: 'grep' },
      { kind: 'tool', id: 'g2', toolName: 'grep' },
    ]);
    expect(result).toEqual([
      { kind: 'group', parts: ['t:1', 'tool:r1', 'tool:r2'] },
      { kind: 'tool', id: 'e1', toolName: 'edit' },
      { kind: 'group', parts: ['t:2', 'tool:r3'] },
      { kind: 'text', text: 'mid' },
      { kind: 'group', parts: ['tool:g1', 'tool:g2'] },
    ]);
  });
});
