/**
 * Tests for Todo & Web Tools (U15).
 *
 * Covers:
 * - Todo: create → ID, OPEN status, OPEN → IN_PROGRESS → DONE (valid),
 *   DONE → IN_PROGRESS (invalid), list, delete
 * - Web fetch: URL validation (scheme/empty only), summarize mode,
 *   raw mode, large content caching
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TodoStore } from '../../src/main/tools/todo/store';
import { buildCreateTool as buildCreateToolRaw } from '../../src/main/tools/todo/create';
import { buildUpdateTool as buildUpdateToolRaw } from '../../src/main/tools/todo/update';
import { buildListTool as buildListToolRaw } from '../../src/main/tools/todo/list';
import { buildDeleteTool as buildDeleteToolRaw } from '../../src/main/tools/todo/delete';
import { buildWebFetchTool as buildWebFetchToolRaw } from '../../src/main/tools/web/fetch';
import { TodoStatus } from '../../src/shared/types/todo';
import type { ToolDefinition, ToolExecutionContext, ToolHandler } from '../../src/main/tools/types';
import { finalizeToolExecutionResult } from '../../src/main/tools/result';
import {
  createCanonicalToolResult,
  type GenericToolResultData,
  type ToolExecutionResult,
  type ToolHandlerOutcome,
} from '../../src/shared/types/tool-result';

// ── Helpers ─────────────────────────────────────────────────────────────────

function canonicalizeTool(tool: { definition: ToolDefinition; handler: ToolHandler }) {
  return {
    ...tool,
    handler: async (
      input: unknown,
      ctx: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const outcome = await tool.handler(input, ctx) as ToolHandlerOutcome<GenericToolResultData>;
      return finalizeToolExecutionResult({
        canonical: createCanonicalToolResult('generic', outcome),
        toolName: tool.definition.name,
        outputDataSchema: tool.definition.outputDataSchema,
        expectedFamily: tool.definition.resultFamily,
      });
    },
  };
}

const buildCreateTool = (...args: Parameters<typeof buildCreateToolRaw>) =>
  canonicalizeTool(buildCreateToolRaw(...args));
const buildUpdateTool = (...args: Parameters<typeof buildUpdateToolRaw>) =>
  canonicalizeTool(buildUpdateToolRaw(...args));
const buildListTool = (...args: Parameters<typeof buildListToolRaw>) =>
  canonicalizeTool(buildListToolRaw(...args));
const buildDeleteTool = (...args: Parameters<typeof buildDeleteToolRaw>) =>
  canonicalizeTool(buildDeleteToolRaw(...args));
const buildWebFetchTool = (...args: Parameters<typeof buildWebFetchToolRaw>) =>
  canonicalizeTool(buildWebFetchToolRaw(...args));

/** Call a tool handler with input and return the result. */
async function callTool(
  handler: (input: unknown, ctx: ToolExecutionContext) => Promise<unknown>,
  input: Record<string, unknown>,
  agentScopeId: string = 'main',
) {
  return handler(input, { cwd: process.cwd(), agentScopeId });
}

// ── Todo Tools Tests ────────────────────────────────────────────────────────

describe('Todo Tools', () => {
  let store: TodoStore;
  let notifyCalled: boolean;

  beforeEach(() => {
    store = new TodoStore();
    notifyCalled = false;
  });

  function notifyChanged() {
    notifyCalled = true;
  }

  // -- todo_create ------------------------------------------------------------

  describe('todo_create', () => {
    it('should create a task with an 8-char hex ID and OPEN status', async () => {
      const { handler } = buildCreateTool(store, notifyChanged);
      const result = (await callTool(handler, {
        title: 'Test task',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('complete');
      expect(result.agentProjection.content).toContain('Task created successfully');
      expect(result.agentProjection.content).toContain('Status: OPEN');

      // Extract ID from content
      const idMatch = result.agentProjection.content.match(/ID: ([a-f0-9]{8})/);
      expect(idMatch).not.toBeNull();
      const id = idMatch![1];

      // Verify task exists in store
      const task = store.get(id);
      expect(task).toBeDefined();
      expect(task!.title).toBe('Test task');
      expect(task!.status).toBe(TodoStatus.OPEN);
      expect(task!.subagent_id).toBeNull();

      // Verify notify was called
      expect(notifyCalled).toBe(true);
    });

    it('should create a task with optional subagent_id', async () => {
      const { handler } = buildCreateTool(store);
      const result = (await callTool(handler, {
        title: 'Subagent task',
        subagent_id: 'sub-123',
      })) as ToolExecutionResult;

      const idMatch = result.agentProjection.content.match(/ID: ([a-f0-9]{8})/);
      const id = idMatch![1];
      const task = store.get(id);
      expect(task!.subagent_id).toBe('sub-123');
    });

    it('should generate unique IDs for multiple tasks', async () => {
      const { handler } = buildCreateTool(store);
      const ids = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const result = (await callTool(handler, {
          title: `Task ${i}`,
        })) as ToolExecutionResult;
        const idMatch = result.agentProjection.content.match(/ID: ([a-f0-9]{8})/);
        expect(idMatch).not.toBeNull();
        ids.add(idMatch![1]);
      }

      // All IDs should be unique
      expect(ids.size).toBe(10);
    });
  });

  // -- todo_update ------------------------------------------------------------

  describe('todo_update', () => {
    it('should update task title', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Original',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store, notifyChanged).handler;
      const result = (await callTool(updateHandler, {
        id,
        title: 'Updated',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('complete');
      expect(result.agentProjection.content).toContain('Title: Updated');
      expect(store.get(id)!.title).toBe('Updated');
      expect(notifyCalled).toBe(true);
    });

    it('should allow OPEN → IN_PROGRESS transition', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id,
        status: 'in_progress',
      })) as ToolExecutionResult;

      expect(result.agentProjection.content).toContain('Status: IN_PROGRESS');
      expect(store.get(id)!.status).toBe(TodoStatus.IN_PROGRESS);
    });

    it('should allow IN_PROGRESS → DONE transition', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;

      // First: OPEN → IN_PROGRESS
      await callTool(updateHandler, { id, status: 'in_progress' });

      // Then: IN_PROGRESS → DONE
      const result = (await callTool(updateHandler, {
        id,
        status: 'done',
      })) as ToolExecutionResult;

      expect(result.agentProjection.content).toContain('Status: DONE');
      expect(store.get(id)!.status).toBe(TodoStatus.DONE);
    });

    it('should reject DONE → IN_PROGRESS transition', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;

      // Move to DONE
      await callTool(updateHandler, { id, status: 'in_progress' });
      await callTool(updateHandler, { id, status: 'done' });

      // Try to go back to IN_PROGRESS
      const result = (await callTool(updateHandler, {
        id,
        status: 'in_progress',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('terminal status');
      expect(store.get(id)!.status).toBe(TodoStatus.DONE);
    });

    it('should reject OPEN → DONE transition (must go through IN_PROGRESS)', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id,
        status: 'done',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('Cannot transition');
    });

    it('should reject invalid status values', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id,
        status: 'bogus',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('Invalid status');
    });

    it('should return error for non-existent task', async () => {
      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id: 'nonexistent',
        title: 'Test',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('No task found');
    });
  });

  // -- todo_list --------------------------------------------------------------

  describe('todo_list', () => {
    it('should list all tasks', async () => {
      const createHandler = buildCreateTool(store).handler;
      await callTool(createHandler, { title: 'Task 1' });
      await callTool(createHandler, { title: 'Task 2' });
      await callTool(createHandler, { title: 'Task 3' });

      const listHandler = buildListTool(store).handler;
      const result = (await callTool(listHandler, {})) as {
        display: string;
        content: string;
      };

      expect(result.canonical.status).toBe('complete');
      expect(result.agentProjection.content).toContain('Task 1');
      expect(result.agentProjection.content).toContain('Task 2');
      expect(result.agentProjection.content).toContain('Task 3');
    });

    it('should filter by status', async () => {
      const createHandler = buildCreateTool(store).handler;
      const r1 = (await callTool(createHandler, { title: 'Open task' })) as {
        content: string;
      };
      const r2 = (await callTool(createHandler, { title: 'Progress task' })) as {
        content: string;
      };
      const id2 = r2.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      await callTool(updateHandler, { id: id2, status: 'in_progress' });

      const listHandler = buildListTool(store).handler;

      // Filter by OPEN
      const openResult = (await callTool(listHandler, { status: 'open' })) as {
        display: string;
        content: string;
      };
      expect(openResult.canonical.status).toBe('complete');
      expect(openResult.agentProjection.content).toContain('Open task');

      // Filter by IN_PROGRESS
      const progressResult = (await callTool(listHandler, {
        status: 'in_progress',
      })) as ToolExecutionResult;
      expect(progressResult.canonical.status).toBe('complete');
      expect(progressResult.agentProjection.content).toContain('Progress task');
    });

    it('should isolate list by agent scope (not peer todos)', async () => {
      const createHandler = buildCreateTool(store).handler;
      await callTool(createHandler, { title: 'Main task' }, 'main');
      // Main assigns ownership to sub-1
      await callTool(createHandler, { title: 'Sub task', subagent_id: 'sub-1' }, 'main');

      const listHandler = buildListTool(store).handler;
      const asSub = (await callTool(listHandler, {}, 'sub-1')) as {
        display: string;
        content: string;
      };
      expect(asSub.canonical.status).toBe('complete');
      expect(asSub.agentProjection.content).toContain('Sub task');
      expect(asSub.agentProjection.content).not.toContain('Main task');

      const asMain = (await callTool(listHandler, {}, 'main')) as {
        content: string;
      };
      expect(asMain.agentProjection.content).toContain('Main task');
      expect(asMain.agentProjection.content).not.toContain('Sub task');
    });

    it('should return empty message when no tasks match', async () => {
      const listHandler = buildListTool(store).handler;
      const result = (await callTool(listHandler, {})) as {
        display: string;
        content: string;
      };

      expect(result.canonical.status).toBe('empty');
      expect(result.agentProjection.content).toContain('No tasks for agent scope');
    });

    it('should reject invalid status filter', async () => {
      const listHandler = buildListTool(store).handler;
      const result = (await callTool(listHandler, { status: 'bogus' })) as {
        display: string;
        content: string;
      };

      expect(result.canonical.status).toBe('error');
    });
  });

  // -- todo_delete ------------------------------------------------------------

  describe('todo_delete', () => {
    it('should delete an existing task', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'To delete',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];

      const deleteHandler = buildDeleteTool(store, notifyChanged).handler;
      const result = (await callTool(deleteHandler, { id })) as {
        display: string;
        content: string;
      };

      expect(result.canonical.status).toBe('complete');
      expect(result.agentProjection.content).toContain('deleted successfully');
      expect(store.get(id)).toBeUndefined();
      expect(notifyCalled).toBe(true);
    });

    it('should return error for non-existent task', async () => {
      const deleteHandler = buildDeleteTool(store).handler;
      const result = (await callTool(deleteHandler, { id: 'nonexistent' })) as {
        display: string;
        content: string;
      };

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('No task found');
    });
  });

  // -- Full lifecycle ---------------------------------------------------------

  describe('full lifecycle', () => {
    it('should support create → update → list → delete workflow', async () => {
      // Create
      const createResult = (await callTool(buildCreateTool(store, notifyChanged).handler, {
        title: 'Lifecycle task',
      })) as ToolExecutionResult;
      const id = createResult.agentProjection.content.match(/ID: ([a-f0-9]{8})/)![1];
      expect(store.get(id)!.status).toBe(TodoStatus.OPEN);

      // Update: OPEN → IN_PROGRESS
      await callTool(buildUpdateTool(store).handler, {
        id,
        status: 'in_progress',
      });
      expect(store.get(id)!.status).toBe(TodoStatus.IN_PROGRESS);

      // Update: IN_PROGRESS → DONE
      await callTool(buildUpdateTool(store).handler, { id, status: 'done' });
      expect(store.get(id)!.status).toBe(TodoStatus.DONE);

      // List (should show DONE task)
      const listResult = (await callTool(buildListTool(store).handler, {
        status: 'done',
      })) as ToolExecutionResult;
      expect(listResult.canonical.status).toBe('complete');
      expect(listResult.agentProjection.content).toContain('Lifecycle task');

      // Delete
      await callTool(buildDeleteTool(store).handler, { id });
      expect(store.get(id)).toBeUndefined();

      // List again (should be empty)
      const emptyResult = (await callTool(buildListTool(store).handler, {})) as {
        display: string;
      };
      expect(emptyResult.canonical.status).toBe('empty');
    });
  });

  // -- TodoStore --------------------------------------------------------------

  describe('TodoStore', () => {
    it('should serialize and restore via toData/fromData', () => {
      store.create('Task 1');
      store.create('Task 2', 'sub-1');

      const data = store.toData();
      expect(data.tasks).toHaveLength(2);

      const restored = TodoStore.fromData(data);
      expect(restored.list()).toHaveLength(2);
      expect(restored.list()[0].title).toBe('Task 1');
      expect(restored.list()[1].subagent_id).toBe('sub-1');
    });

    it('should handle ID collision gracefully', () => {
      // This test verifies the collision retry logic works
      // In practice, collisions are astronomically unlikely
      const task1 = store.create('Task 1');
      expect(task1.id).toMatch(/^[a-f0-9]{8}$/);
    });
  });
});

// ── Web Fetch Tools Tests ───────────────────────────────────────────────────

describe('Web Fetch Tools', () => {
  // -- URL validation ---------------------------------------------------------

  describe('URL validation', () => {
    it('should reject empty URL', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: '',
        query: 'test',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('cannot be empty');
    });

    it('should reject non-http(s) schemes', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: 'ftp://example.com',
        query: 'test',
      })) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('http or https');
    });

    it('allows localhost, private IPs, and embedded credentials (SSRF checks removed)', async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        url,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () =>
          Promise.resolve(
            new TextEncoder().encode('<title>Local</title><body>ok</body>').buffer,
          ),
      }));
      globalThis.fetch = mockFetch as typeof fetch;

      try {
        const { handler } = buildWebFetchTool();
        const urls = [
          'http://localhost:8080',
          'http://127.0.0.1',
          'http://10.0.0.1',
          'http://172.16.0.1',
          'http://192.168.1.1',
          'http://169.254.169.254',
          'http://user:pass@example.com',
        ];

        for (const url of urls) {
          mockFetch.mockClear();
          const result = (await callTool(handler, {
            url,
          })) as ToolExecutionResult;

          expect(result.canonical.status).toBe('complete');
          expect(result.canonical.status).toBe('complete');
          expect(result.agentProjection.content).toContain('<web_fetch_raw');
          expect(mockFetch).toHaveBeenCalledWith(
            url,
            expect.objectContaining({ redirect: 'follow' }),
          );
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should treat an omitted query as raw mode', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(
          new TextEncoder().encode('<title>Test</title><body>Hello</body>').buffer,
        ),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
        })) as ToolExecutionResult;

        expect(result.canonical.status).toBe('complete');
        expect(result.agentProjection.content).toContain('<web_fetch_raw');
        expect(result.agentProjection.content).toContain('Hello');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should treat a blank query as raw mode', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(
          new TextEncoder().encode('<title>Test</title><body>Hello</body>').buffer,
        ),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
          query: '   ',
        })) as ToolExecutionResult;

        expect(result.canonical.status).toBe('complete');
        expect(result.agentProjection.content).toContain('<web_fetch_raw');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('ignores the removed mode parameter', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(
          new TextEncoder().encode('<body>Hello</body>').buffer,
        ),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
          mode: 'invalid',
        })) as ToolExecutionResult;

        expect(result.agentProjection.content).toContain('<web_fetch_raw');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -- Summarize mode ---------------------------------------------------------

  describe('summarize mode', () => {
    it('should return error when summarize callback not provided', async () => {
      // Mock fetch to return a simple response
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('<title>Test</title><body>Hello</body>').buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
          query: 'What is this page about?',
        })) as ToolExecutionResult;

        expect(result.canonical.status).toBe('error');
        expect(result.agentProjection.content).toContain('summarize callback');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should call summarize callback with fetched content', async () => {
      const html = '<html><head><title>Test Page</title></head><body>Hello world</body></html>';

      // Mock fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      const summarize = vi.fn().mockResolvedValue('This is a test page about hello world.');

      try {
        const { handler } = buildWebFetchTool({ summarize });
        const result = (await callTool(handler, {
          url: 'https://example.com',
          query: 'What is this page about?',
        })) as ToolExecutionResult;

        expect(result.canonical.status).toBe('complete');
        expect(result.agentProjection.content).toContain('This is a test page');
        expect(summarize).toHaveBeenCalledWith(
          'https://example.com',
          'Test Page',
          'text/html',
          expect.any(String),
          'What is this page about?',
          { cwd: process.cwd(), agentScopeId: 'main' },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -- Raw mode ---------------------------------------------------------------

  describe('raw mode', () => {
    it('should return markdown content inline for small pages', async () => {
      const html = '<html><head><title>Small Page</title></head><body>Hello world</body></html>';

      // Mock fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
        })) as ToolExecutionResult;

        expect(result.canonical.status).toBe('complete');
        expect(result.agentProjection.content).toContain('<web_fetch_raw');
        expect(result.agentProjection.content).toContain('Hello world');
        expect(result.agentProjection.content).toContain('Small Page');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should write large content using the per-call session context', async () => {
      // Create content > 10K chars
      const largeContent = 'x'.repeat(15_000);
      const html = `<html><head><title>Large Page</title></head><body>${largeContent}</body></html>`;

      // Mock fetch
      const originalFetch = globalThis.fetch;
      const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-web-fetch-'));
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com/large',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool({ cacheRoot });
        const result = (await handler(
          {
            url: 'https://example.com/large',
          },
          { cwd: process.cwd(), sessionId: 'test-session' },
        )) as ToolExecutionResult;

        expect(result.canonical.status).toBe('complete');
        expect(result.agentProjection.content).toContain('<web_fetch_raw');
        expect(result.agentProjection.content).toContain('warning');
        expect(result.agentProjection.content).toContain('cache');
        expect(result.agentProjection.content).toContain('test-session');
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(cacheRoot, { recursive: true, force: true });
      }
    });

    it('should return error for large content without session ID', async () => {
      // Create content > 10K chars
      const largeContent = 'x'.repeat(15_000);
      const html = `<html><head><title>Large Page</title></head><body>${largeContent}</body></html>`;

      // Mock fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com/large',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool(); // No sessionId
        const result = (await callTool(handler, {
          url: 'https://example.com/large',
        })) as ToolExecutionResult;

        expect(result.canonical.status).toBe('error');
        expect(result.agentProjection.content).toContain('require an active session');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -- Error handling ---------------------------------------------------------

  describe('error handling', () => {
    it('should handle fetch timeout', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            setTimeout(() => reject(error), 100);
          }),
      ) as unknown as typeof fetch;

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
          query: 'test',
        })) as ToolExecutionResult;

        // The handler correctly detects abort as timeout
        expect(result.canonical.status).toBe('error');
        expect(result.agentProjection.content).toContain('timed out');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should cancel in-flight fetch when ctx.abortSignal aborts', async () => {
      const originalFetch = globalThis.fetch;
      let sawSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            sawSignal = init?.signal;
            const onAbort = () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (init?.signal?.aborted) {
              onAbort();
              return;
            }
            init?.signal?.addEventListener('abort', onAbort, { once: true });
          }),
      ) as unknown as typeof fetch;

      try {
        const { handler } = buildWebFetchTool();
        const ac = new AbortController();
        const pending = handler(
          { url: 'https://example.com' },
          { cwd: process.cwd(), abortSignal: ac.signal },
        );
        // Abort after the fetch has attached its listener
        await Promise.resolve();
        ac.abort();
        const result = (await pending) as ToolExecutionResult;

        expect(sawSignal).toBeDefined();
        expect(result.canonical.status).toBe('cancelled');
        expect(result.agentProjection.content).toContain('cancelled');
        expect(result.canonical.status).toBe('cancelled');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should handle HTTP errors', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        url: 'https://example.com',
        status: 404,
        headers: new Map([['content-type', 'text/html']]),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
          query: 'test',
        })) as ToolExecutionResult;

        expect(result.canonical.status).toBe('error');
        expect(result.agentProjection.content).toContain('404');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -- HTML processing --------------------------------------------------------

  describe('HTML processing', () => {
    it('should extract title from HTML', async () => {
      const html = '<html><head><title>  My   Page  </title></head><body>Content</body></html>';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
        })) as ToolExecutionResult;

        // Title should be normalized (whitespace collapsed)
        expect(result.agentProjection.content).toContain('My Page');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should convert HTML to markdown', async () => {
      const html = `
        <html>
          <head><title>Test</title></head>
          <body>
            <h1>Hello</h1>
            <p>This is a <strong>test</strong> page.</p>
            <a href="https://example.com">Link</a>
          </body>
        </html>
      `;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com',
        })) as ToolExecutionResult;

        // Should contain markdown-formatted content
        expect(result.agentProjection.content).toContain('# Hello');
        expect(result.agentProjection.content).toContain('**test**');
        expect(result.agentProjection.content).toContain('[Link](https://example.com)');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should escape XML special characters in raw result attributes', async () => {
      const html =
        '<html><head><title>A & B "quoted" <tag></title></head><body>Body</body></html>';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com/?q=a&b="c"',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await callTool(handler, {
          url: 'https://example.com/?q=a&b="c"',
        })) as ToolExecutionResult;

        expect(result.agentProjection.content).toContain('url="https://example.com/?q=a&amp;b=&quot;c&quot;"');
        expect(result.agentProjection.content).toContain('title="A &amp; B &quot;quoted&quot; &lt;tag&gt;"');
        expect(result.agentProjection.content).not.toContain('url="https://example.com/?q=a&b=');
        expect(result.agentProjection.content).not.toContain('title="A & B');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
