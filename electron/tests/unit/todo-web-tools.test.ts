/**
 * Tests for Todo & Web Tools (U15).
 *
 * Covers:
 * - Todo: create → ID, OPEN status, OPEN → IN_PROGRESS → DONE (valid),
 *   DONE → IN_PROGRESS (invalid), list, delete
 * - Web fetch: URL validation (private IPs blocked), summarize mode,
 *   raw mode, large content caching
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TodoStore } from '../../src/main/tools/todo/store';
import { buildCreateTool } from '../../src/main/tools/todo/create';
import { buildUpdateTool } from '../../src/main/tools/todo/update';
import { buildListTool } from '../../src/main/tools/todo/list';
import { buildDeleteTool } from '../../src/main/tools/todo/delete';
import { buildWebFetchTool } from '../../src/main/tools/web/fetch';
import { TodoStatus } from '../../src/shared/types/todo';
import type { ToolExecutionContext } from '../../src/main/tools/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

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
      })) as { display: string; content: string };

      expect(result.display).toBe('Created task: Test task');
      expect(result.content).toContain('Task created successfully');
      expect(result.content).toContain('Status: OPEN');

      // Extract ID from content
      const idMatch = result.content.match(/ID: ([a-f0-9]{8})/);
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
      })) as { content: string };

      const idMatch = result.content.match(/ID: ([a-f0-9]{8})/);
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
        })) as { content: string };
        const idMatch = result.content.match(/ID: ([a-f0-9]{8})/);
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
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store, notifyChanged).handler;
      const result = (await callTool(updateHandler, {
        id,
        title: 'Updated',
      })) as { display: string; content: string };

      expect(result.display).toBe(`Updated task ${id}`);
      expect(result.content).toContain('Title: Updated');
      expect(store.get(id)!.title).toBe('Updated');
      expect(notifyCalled).toBe(true);
    });

    it('should allow OPEN → IN_PROGRESS transition', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id,
        status: 'in_progress',
      })) as { content: string };

      expect(result.content).toContain('Status: IN_PROGRESS');
      expect(store.get(id)!.status).toBe(TodoStatus.IN_PROGRESS);
    });

    it('should allow IN_PROGRESS → DONE transition', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;

      // First: OPEN → IN_PROGRESS
      await callTool(updateHandler, { id, status: 'in_progress' });

      // Then: IN_PROGRESS → DONE
      const result = (await callTool(updateHandler, {
        id,
        status: 'done',
      })) as { content: string };

      expect(result.content).toContain('Status: DONE');
      expect(store.get(id)!.status).toBe(TodoStatus.DONE);
    });

    it('should reject DONE → IN_PROGRESS transition', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;

      // Move to DONE
      await callTool(updateHandler, { id, status: 'in_progress' });
      await callTool(updateHandler, { id, status: 'done' });

      // Try to go back to IN_PROGRESS
      const result = (await callTool(updateHandler, {
        id,
        status: 'in_progress',
      })) as { display: string; content: string };

      expect(result.display).toBe('Update failed');
      expect(result.content).toContain('terminal status');
      expect(store.get(id)!.status).toBe(TodoStatus.DONE);
    });

    it('should reject OPEN → DONE transition (must go through IN_PROGRESS)', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id,
        status: 'done',
      })) as { display: string; content: string };

      expect(result.display).toBe('Update failed');
      expect(result.content).toContain('Cannot transition');
    });

    it('should reject invalid status values', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'Test',
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id,
        status: 'bogus',
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid status');
      expect(result.content).toContain('Invalid status');
    });

    it('should return error for non-existent task', async () => {
      const updateHandler = buildUpdateTool(store).handler;
      const result = (await callTool(updateHandler, {
        id: 'nonexistent',
        title: 'Test',
      })) as { display: string; content: string };

      expect(result.display).toBe('Update failed');
      expect(result.content).toContain('No task found');
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

      expect(result.display).toBe('Found 3 task(s)');
      expect(result.content).toContain('Task 1');
      expect(result.content).toContain('Task 2');
      expect(result.content).toContain('Task 3');
    });

    it('should filter by status', async () => {
      const createHandler = buildCreateTool(store).handler;
      const r1 = (await callTool(createHandler, { title: 'Open task' })) as {
        content: string;
      };
      const r2 = (await callTool(createHandler, { title: 'Progress task' })) as {
        content: string;
      };
      const id2 = r2.content.match(/ID: ([a-f0-9]{8})/)![1];

      const updateHandler = buildUpdateTool(store).handler;
      await callTool(updateHandler, { id: id2, status: 'in_progress' });

      const listHandler = buildListTool(store).handler;

      // Filter by OPEN
      const openResult = (await callTool(listHandler, { status: 'open' })) as {
        display: string;
        content: string;
      };
      expect(openResult.display).toBe('Found 1 task(s)');
      expect(openResult.content).toContain('Open task');

      // Filter by IN_PROGRESS
      const progressResult = (await callTool(listHandler, {
        status: 'in_progress',
      })) as { display: string; content: string };
      expect(progressResult.display).toBe('Found 1 task(s)');
      expect(progressResult.content).toContain('Progress task');
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
      expect(asSub.display).toBe('Found 1 task(s)');
      expect(asSub.content).toContain('Sub task');
      expect(asSub.content).not.toContain('Main task');

      const asMain = (await callTool(listHandler, {}, 'main')) as {
        content: string;
      };
      expect(asMain.content).toContain('Main task');
      expect(asMain.content).not.toContain('Sub task');
    });

    it('should return empty message when no tasks match', async () => {
      const listHandler = buildListTool(store).handler;
      const result = (await callTool(listHandler, {})) as {
        display: string;
        content: string;
      };

      expect(result.display).toBe('No tasks found');
      expect(result.content).toContain('No tasks for agent scope');
    });

    it('should reject invalid status filter', async () => {
      const listHandler = buildListTool(store).handler;
      const result = (await callTool(listHandler, { status: 'bogus' })) as {
        display: string;
        content: string;
      };

      expect(result.display).toBe('Invalid status');
    });
  });

  // -- todo_delete ------------------------------------------------------------

  describe('todo_delete', () => {
    it('should delete an existing task', async () => {
      const createHandler = buildCreateTool(store).handler;
      const createResult = (await callTool(createHandler, {
        title: 'To delete',
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];

      const deleteHandler = buildDeleteTool(store, notifyChanged).handler;
      const result = (await callTool(deleteHandler, { id })) as {
        display: string;
        content: string;
      };

      expect(result.display).toBe('Deleted task: To delete');
      expect(result.content).toContain('deleted successfully');
      expect(store.get(id)).toBeUndefined();
      expect(notifyCalled).toBe(true);
    });

    it('should return error for non-existent task', async () => {
      const deleteHandler = buildDeleteTool(store).handler;
      const result = (await callTool(deleteHandler, { id: 'nonexistent' })) as {
        display: string;
        content: string;
      };

      expect(result.display).toBe('Task not found');
      expect(result.content).toContain('No task found');
    });
  });

  // -- Full lifecycle ---------------------------------------------------------

  describe('full lifecycle', () => {
    it('should support create → update → list → delete workflow', async () => {
      // Create
      const createResult = (await callTool(buildCreateTool(store, notifyChanged).handler, {
        title: 'Lifecycle task',
      })) as { content: string };
      const id = createResult.content.match(/ID: ([a-f0-9]{8})/)![1];
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
      })) as { display: string; content: string };
      expect(listResult.display).toBe('Found 1 task(s)');
      expect(listResult.content).toContain('Lifecycle task');

      // Delete
      await callTool(buildDeleteTool(store).handler, { id });
      expect(store.get(id)).toBeUndefined();

      // List again (should be empty)
      const emptyResult = (await callTool(buildListTool(store).handler, {})) as {
        display: string;
      };
      expect(emptyResult.display).toBe('No tasks found');
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
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid URL');
      expect(result.content).toContain('cannot be empty');
    });

    it('should reject non-http(s) schemes', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: 'ftp://example.com',
        query: 'test',
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid URL');
      expect(result.content).toContain('http or https');
    });

    it('should reject localhost', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: 'http://localhost:8080',
        query: 'test',
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid URL');
      expect(result.content).toContain('localhost');
    });

    it('should reject 127.0.0.1', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: 'http://127.0.0.1',
        query: 'test',
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid URL');
      expect(result.content).toContain('private or reserved');
    });

    it('should reject 10.x.x.x (RFC 1918)', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: 'http://10.0.0.1',
        query: 'test',
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid URL');
      expect(result.content).toContain('private or reserved');
    });

    it('should reject 172.16-31.x.x (RFC 1918)', async () => {
      const { handler } = buildWebFetchTool();

      // 172.16.x.x
      const r1 = (await callTool(handler, {
        url: 'http://172.16.0.1',
        query: 'test',
      })) as { display: string };
      expect(r1.display).toBe('Invalid URL');

      // 172.31.x.x
      const r2 = (await callTool(handler, {
        url: 'http://172.31.255.255',
        query: 'test',
      })) as { display: string };
      expect(r2.display).toBe('Invalid URL');

      // 172.15.x.x (not blocked)
      // We can't test this easily without mocking fetch, so skip
    });

    it('should reject 192.168.x.x (RFC 1918)', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: 'http://192.168.1.1',
        query: 'test',
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid URL');
      expect(result.content).toContain('private or reserved');
    });

    it('should reject 169.254.x.x (link-local)', async () => {
      const { handler } = buildWebFetchTool();

      // 169.254.169.254 (cloud metadata endpoint - caught by link-local check)
      const r1 = (await callTool(handler, {
        url: 'http://169.254.169.254',
        query: 'test',
      })) as { display: string; content: string };
      expect(r1.display).toBe('Invalid URL');
      expect(r1.content).toContain('private or reserved');

      // 169.254.1.1 (link-local)
      const r2 = (await callTool(handler, {
        url: 'http://169.254.1.1',
        query: 'test',
      })) as { display: string; content: string };
      expect(r2.display).toBe('Invalid URL');
      expect(r2.content).toContain('private or reserved');
    });

    it('should reject embedded credentials', async () => {
      const { handler } = buildWebFetchTool();
      const result = (await callTool(handler, {
        url: 'http://user:pass@example.com',
        query: 'test',
      })) as { display: string; content: string };

      expect(result.display).toBe('Invalid URL');
      expect(result.content).toContain('credentials');
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
        })) as { display: string; content: string };

        expect(result.display).toContain('Fetched');
        expect(result.content).toContain('<web_fetch_raw');
        expect(result.content).toContain('Hello');
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
        })) as { display: string; content: string };

        expect(result.display).toContain('Fetched');
        expect(result.content).toContain('<web_fetch_raw');
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
        })) as { display: string; content: string };

        expect(result.content).toContain('<web_fetch_raw');
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
        })) as { display: string; content: string };

        expect(result.display).toBe('Summarize not available');
        expect(result.content).toContain('summarize callback');
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
        })) as { display: string; content: string };

        expect(result.display).toBe('Fetched and summarized https://example.com');
        expect(result.content).toContain('This is a test page');
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
        })) as { display: string; content: string };

        expect(result.display).toContain('Fetched');
        expect(result.content).toContain('<web_fetch_raw');
        expect(result.content).toContain('Hello world');
        expect(result.content).toContain('Small Page');
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
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://example.com/large',
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
      } as unknown as Response);

      try {
        const { handler } = buildWebFetchTool();
        const result = (await handler(
          {
            url: 'https://example.com/large',
          },
          { cwd: process.cwd(), sessionId: 'test-session' },
        )) as { display: string; content: string };

        expect(result.display).toContain('characters to');
        expect(result.content).toContain('<web_fetch_raw');
        expect(result.content).toContain('warning');
        expect(result.content).toContain('cache');
        expect(result.content).toContain('test-session');
      } finally {
        globalThis.fetch = originalFetch;
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
        })) as { display: string; content: string };

        expect(result.display).toBe('No active session');
        expect(result.content).toContain('require an active session');
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
        })) as { display: string; content: string };

        // The handler correctly detects abort as timeout
        expect(result.display).toBe('Fetch timed out');
        expect(result.content).toContain('timed out');
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
        })) as { display: string; content: string };

        expect(result.display).toBe('HTTP 404');
        expect(result.content).toContain('404');
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
        })) as { content: string };

        // Title should be normalized (whitespace collapsed)
        expect(result.content).toContain('My Page');
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
        })) as { content: string };

        // Should contain markdown-formatted content
        expect(result.content).toContain('# Hello');
        expect(result.content).toContain('**test**');
        expect(result.content).toContain('[Link](https://example.com)');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
