/**
 * Context snapshot telemetry is session-scoped: streamChat must only insert
 * context_snapshots rows when it runs with a sessionId. Sessionless streams
 * (e.g. renderer tool:execute surfaces) write nothing, mirroring the tool
 * attempt guard.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importESM } from '../../src/main/utils/esm-import';
import { streamChat, type StreamEvent } from '../../src/main/llm/orchestrator';
import { ToolRegistry } from '../../src/main/tools/registry';
import { defaults } from '../../src/main/config';
import {
  initializeContextSnapshotStore,
  resetContextSnapshotStore,
  type ContextSnapshotStore,
} from '../../src/main/providers/accounting/context-snapshot-store';
import type { Agent } from '../../src/shared/types/agent';

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(),
}));

const agent: Agent = {
  name: 'ctx-guard-test',
  type: 'custom' as never,
  tier: 'bloom' as never,
  description: 'test agent',
  system_prompt: '',
  allowed_tools: [],
  allowed_skills: [],
};

describe('context snapshot session guard through streamChat', () => {
  let cwd: string;
  let tmpDir: string;
  let store: ContextSnapshotStore;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-ctx-guard-cwd-'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-ctx-guard-db-'));
    store = initializeContextSnapshotStore({ dbPath: path.join(tmpDir, 'accounting.db') });
  });

  afterEach(() => {
    resetContextSnapshotStore();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function installFakeAiSdk(): void {
    async function* fakeFullStream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'finish-step',
        usage: { inputTokens: 120, outputTokens: 40 },
        finishReason: 'stop',
      };
    }
    const fakeAi = {
      streamText: vi.fn(() => ({
        fullStream: fakeFullStream(),
        finishReason: Promise.resolve('stop'),
      })),
      wrapLanguageModel: ({ model }: { model: unknown }) => model,
      isStepCount: () => () => false,
    };
    vi.mocked(importESM).mockResolvedValue(fakeAi as never);
  }

  async function runStream(sessionId: string | undefined): Promise<StreamEvent[]> {
    installFakeAiSdk();
    const registry = new ToolRegistry();
    const controller = new AbortController();
    const gen = streamChat({
      messages: [],
      agent,
      systemPrompt: 'test',
      context: { cwd },
      config: defaults(),
      registry,
      mcpManager: null,
      sessionId,
      abortSignal: controller.signal,
      modelInstance: {} as never,
    });
    const events: StreamEvent[] = [];
    for await (const event of gen) events.push(event);
    return events;
  }

  it('inserts a context snapshot when a session id is present', async () => {
    await runStream('sess-ctx-guard');

    const rows = store.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('sess-ctx-guard');
    expect(rows[0].usedTokens).toBe(160);
  });

  it('inserts nothing for a sessionless stream', async () => {
    await runStream('sess-ctx-guard');
    expect(store.listAll()).toHaveLength(1);

    await runStream(undefined);

    const rows = store.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('sess-ctx-guard');
  });
});
