/**
 * Per-agent isolation: todos, prompt context, and ownership helpers.
 *
 * Design: Sub1 must not see main or Sub2 todos (or peer bg / peer subagents
 * in the dynamic prompt). Main owns untagged todos and sees all subagents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  filterTodosForScope,
  isMainAgentScope,
  MAIN_AGENT_SCOPE_ID,
  normalizeAgentScopeId,
  todoBelongsToScope,
} from '../../src/shared/types/agent-scope';
import { resolveCreateOwner } from '../../src/main/tools/todo/create';
import { buildCreateTool } from '../../src/main/tools/todo/create';
import { buildListTool } from '../../src/main/tools/todo/list';
import { buildUpdateTool } from '../../src/main/tools/todo/update';
import { buildDeleteTool } from '../../src/main/tools/todo/delete';
import { TodoStore } from '../../src/main/tools/todo/store';
import { getSubagentManager } from '../../src/main/tools';
import {
  buildSystemPromptContext,
  __resetDirectoryTreeCacheForTests,
} from '../../src/main/llm/build-prompt-context';
import { defaults } from '../../src/main/config/schema';
import type { ToolExecutionContext } from '../../src/main/tools/types';

function ctx(scope: string): ToolExecutionContext {
  return { cwd: process.cwd(), agentScopeId: scope };
}

describe('agent-scope helpers', () => {
  it('normalizes empty to main', () => {
    expect(normalizeAgentScopeId(null)).toBe(MAIN_AGENT_SCOPE_ID);
    expect(normalizeAgentScopeId('')).toBe(MAIN_AGENT_SCOPE_ID);
    expect(normalizeAgentScopeId('sub-1')).toBe('sub-1');
    expect(isMainAgentScope(undefined)).toBe(true);
  });

  it('filters todos by owner scope', () => {
    const todos = [
      { id: '1', subagent_id: null as string | null },
      { id: '2', subagent_id: 'sub-a' },
      { id: '3', subagent_id: 'sub-b' },
      { id: '4', subagent_id: '' },
    ];
    expect(filterTodosForScope(todos, 'main').map((t) => t.id)).toEqual(['1', '4']);
    expect(filterTodosForScope(todos, 'sub-a').map((t) => t.id)).toEqual(['2']);
    expect(todoBelongsToScope({ subagent_id: 'sub-a' }, 'sub-b')).toBe(false);
  });

  it('resolveCreateOwner stamps subagent scope and main to null owner', () => {
    expect(resolveCreateOwner('sub-a')).toBe('sub-a');
    expect(resolveCreateOwner('main')).toBeUndefined();
  });
});

describe('todo tools agent isolation', () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore();
  });

  it('subagent only lists and mutates own todos', async () => {
    const create = buildCreateTool(store);
    const list = buildListTool(store);
    const update = buildUpdateTool(store);
    const del = buildDeleteTool(store);

    await create.handler({ title: 'Main task' }, ctx('main'));
    await create.handler({ title: 'SubA task' }, ctx('sub-a'));
    await create.handler({ title: 'SubB task' }, ctx('sub-b'));

    const listA = await list.handler({}, ctx('sub-a'));
    expect(listA.status).toBe('complete');
    expect(JSON.stringify(listA.data.value)).toContain('SubA task');
    expect(JSON.stringify(listA.data.value)).not.toContain('Main task');
    expect(JSON.stringify(listA.data.value)).not.toContain('SubB task');

    const listMain = await list.handler({}, ctx('main'));
    expect(listMain.status).toBe('complete');
    expect(JSON.stringify(listMain.data.value)).toContain('Main task');
    expect(JSON.stringify(listMain.data.value)).not.toContain('SubA task');

    const subATodos = store.list().filter((t) => t.subagent_id === 'sub-a');
    const subBTodos = store.list().filter((t) => t.subagent_id === 'sub-b');
    const mainTodos = store.list().filter((t) => !t.subagent_id);

    // SubA cannot update main or SubB
    const badUpdate = (await update.handler(
      { id: mainTodos[0]!.id, title: 'hacked' },
      ctx('sub-a'),
    ));
    expect(badUpdate.status).toBe('error');
    expect(String(badUpdate.data.value)).toMatch(/not owned/i);

    const badDel = (await del.handler(
      { id: subBTodos[0]!.id },
      ctx('sub-a'),
    ));
    expect(badDel.status).toBe('error');

    // SubA can update own
    const ok = (await update.handler(
      { id: subATodos[0]!.id, status: 'IN_PROGRESS' },
      ctx('sub-a'),
    ));
    expect(ok.status).toBe('complete');
  });

  it('subagent cannot forge another owner on create', async () => {
    const create = buildCreateTool(store);
    await create.handler(
      { title: 'Mine', subagent_id: 'someone-else' },
      ctx('sub-a'),
    );
    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.subagent_id).toBe('sub-a');
  });

  it('main-scope create ignores a stale subagent_id key (param removed)', async () => {
    const create = buildCreateTool(store);
    // Models holding pre-removal tool schemas may still emit subagent_id;
    // the schema strips it and ownership stays with the caller.
    await create.handler(
      { title: 'Stale', subagent_id: 'sub-9' } as never,
      ctx('main'),
    );
    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.subagent_id).toBeNull();
  });
});

describe('prompt context agent isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-scope-prompt-'));
    __resetDirectoryTreeCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    __resetDirectoryTreeCacheForTests();
  });

  it('injects only scoped todos and hides peer subagents for subagents', async () => {
    const config = defaults();
    const getTodos = () => [
      { id: '1', title: 'Main work', status: 'OPEN' },
      { id: '2', title: 'SubA work', status: 'OPEN', subagentId: 'sub-a' },
      { id: '3', title: 'SubB work', status: 'OPEN', subagentId: 'sub-b' },
    ];

    const mainCtx = await buildSystemPromptContext({
      cwd: tmpDir,
      config,
      agentScopeId: 'main',
      getTodos,
    });
    expect(mainCtx.todos?.map((t) => t.title)).toEqual(['Main work']);
    // Main may list subagents (empty without a live manager — just ensure no throw)
    expect(Array.isArray(mainCtx.subagents)).toBe(true);

    const subACtx = await buildSystemPromptContext({
      cwd: tmpDir,
      config,
      agentScopeId: 'sub-a',
      getTodos,
    });
    expect(subACtx.todos?.map((t) => t.title)).toEqual(['SubA work']);
    expect(subACtx.subagents).toEqual([]);
  });

  it('surfaces pending subagent questions only to the owning session main scope', async () => {
    const config = defaults();
    const manager = getSubagentManager();
    const sessionId = `scope-question-${Date.now()}`;
    const record = manager.spawn('question owner', 'ask parent', {
      name: 'question-worker',
      type: 'subagent',
      tier: 'bloom',
      description: 'Asks a parent-scoped question',
      allowed_tools: ['ask_question'],
      allowed_skills: [],
    }, { sessionId });
    manager.markRunning(record.id);
    const questionPromise = manager.markQuestionPending(record.id, 'tc-scope', [
      {
        type: 'single',
        title: 'Parent only?',
        options: [{ label: 'Yes' }],
      },
    ]);

    try {
      const mainCtx = await buildSystemPromptContext({
        cwd: tmpDir,
        config,
        sessionId,
        agentScopeId: 'main',
        getTodos: () => [],
      });
      const childCtx = await buildSystemPromptContext({
        cwd: tmpDir,
        config,
        sessionId,
        agentScopeId: 'subagent-peer',
        getTodos: () => [],
      });
      const otherSessionCtx = await buildSystemPromptContext({
        cwd: tmpDir,
        config,
        sessionId: `${sessionId}-other`,
        agentScopeId: 'main',
        getTodos: () => [],
      });

      expect(mainCtx.pendingSubagentQuestions).toHaveLength(1);
      expect(childCtx.pendingSubagentQuestions).toEqual([]);
      expect(otherSessionCtx.pendingSubagentQuestions).toEqual([]);
    } finally {
      manager.answerSubagentQuestion(record.id, 'tc-scope', { type: 'declined' });
      await questionPromise;
      manager.cancelOne(record.id);
    }
  });
});
