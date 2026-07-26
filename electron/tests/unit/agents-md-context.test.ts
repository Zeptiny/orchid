/**
 * Per-session AGENTS.md context tracker tests (U2).
 *
 * Covers the ephemeral AgentsMdContextStore (canonical-path membership,
 * order-preserving unseen(), mtime staleness, root seeding, clear) and the
 * SessionManager wiring: scope-keyed isolation so subagents start fresh (R15),
 * the active-store accessor, and the safe empty fallback for the no-session case.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentsMdContextStore } from '../../src/main/session/agents-md-context';
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';
import type { AgentsMdEntry } from '../../src/main/agents-md/resolver';

function makeEntry(
  filePath: string,
  mtimeMs = 1000,
  tier: 'root' | 'nested' = 'nested',
): AgentsMdEntry {
  return { path: filePath, displayPath: filePath, tier, sizeBytes: 42, mtimeMs };
}

describe('AgentsMdContextStore', () => {
  it('markSeen records canonical-path membership', () => {
    const store = new AgentsMdContextStore();
    const entry = makeEntry('/ws/pkg/AGENTS.md');
    expect(store.isSeen(entry.path)).toBe(false);

    store.markSeen(entry);
    expect(store.isSeen(entry.path)).toBe(true);
    expect(store.isSeen('/ws/other/AGENTS.md')).toBe(false);
    expect(store.size).toBe(1);
  });

  it('unseen returns only not-yet-seen entries, preserving input order', () => {
    const store = new AgentsMdContextStore();
    const a = makeEntry('/ws/a/AGENTS.md');
    const b = makeEntry('/ws/b/AGENTS.md');
    const c = makeEntry('/ws/c/AGENTS.md');
    const chain = [a, b, c];

    expect(store.unseen(chain)).toEqual([a, b, c]);

    store.markSeen(b);
    expect(store.unseen(chain)).toEqual([a, c]);

    store.markSeen(a);
    store.markSeen(c);
    expect(store.unseen(chain)).toEqual([]);
  });

  it('detects staleness by mtime (R16)', () => {
    const store = new AgentsMdContextStore();
    const p = '/ws/AGENTS.md';
    store.markSeen(makeEntry(p, 1000));
    expect(store.isFresh(makeEntry(p, 1000))).toBe(true);

    // Same path, newer mtime → seen but not fresh, so still returned by unseen.
    const changed = makeEntry(p, 1001);
    expect(store.isFresh(changed)).toBe(false);
    expect(store.unseen([changed])).toEqual([changed]);

    // Re-marking at the new mtime makes it fresh again.
    store.markSeen(changed);
    expect(store.isFresh(makeEntry(p, 1001))).toBe(true);
    expect(store.unseen([changed])).toEqual([]);
  });

  it('a never-seen entry is not fresh', () => {
    const store = new AgentsMdContextStore();
    expect(store.isFresh(makeEntry('/ws/AGENTS.md'))).toBe(false);
  });

  it('seedRoot marks the root seen so unseen excludes it (R13/R4)', () => {
    const store = new AgentsMdContextStore();
    const root = makeEntry('/ws/AGENTS.md', 1000, 'root');
    const nested = makeEntry('/ws/pkg/AGENTS.md', 1000, 'nested');

    store.seedRoot(root);
    expect(store.isSeen(root.path)).toBe(true);
    // Nearest-first chain: the seeded root is filtered out, the nested file remains.
    expect(store.unseen([nested, root])).toEqual([nested]);
  });

  it('clear empties the store', () => {
    const store = new AgentsMdContextStore();
    store.markSeen(makeEntry('/ws/a/AGENTS.md'));
    store.markSeen(makeEntry('/ws/b/AGENTS.md'));
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.isSeen('/ws/a/AGENTS.md')).toBe(false);
  });

  it('dedupes by canonical path regardless of displayPath (R14)', () => {
    const store = new AgentsMdContextStore();
    store.markSeen({ ...makeEntry('/ws/AGENTS.md'), displayPath: 'AGENTS.md' });
    store.markSeen({ ...makeEntry('/ws/AGENTS.md'), displayPath: '../ws/AGENTS.md' });
    expect(store.size).toBe(1);
  });
});

describe('SessionManager agents-md scope isolation (R15)', () => {
  it('main and subagent scopes get separate store instances', () => {
    const manager = new SessionManager();
    const main = manager.getAgentsMdContextStore('session-1', 'main');
    const sub = manager.getAgentsMdContextStore('session-1', 'sub-1');
    expect(main).not.toBe(sub);

    const entry = makeEntry('/ws/pkg/AGENTS.md');
    main.markSeen(entry);
    expect(main.isSeen(entry.path)).toBe(true);
    // The subagent starts fresh — parent's seen-set is not inherited.
    expect(sub.isSeen(entry.path)).toBe(false);
  });

  it('omitted scope normalizes to main (same instance as explicit main)', () => {
    const manager = new SessionManager();
    const omitted = manager.getAgentsMdContextStore('session-1');
    const explicitMain = manager.getAgentsMdContextStore('session-1', 'main');
    expect(omitted).toBe(explicitMain);
  });

  it('returns the cached instance for the same session and scope', () => {
    const manager = new SessionManager();
    const first = manager.getAgentsMdContextStore('session-1', 'sub-1');
    const second = manager.getAgentsMdContextStore('session-1', 'sub-1');
    expect(first).toBe(second);
  });

  it('isolates stores across sessions', () => {
    const manager = new SessionManager();
    const a = manager.getAgentsMdContextStore('session-1', 'main');
    const b = manager.getAgentsMdContextStore('session-2', 'main');
    expect(a).not.toBe(b);
  });
});

describe('getActiveAgentsMdContextStore', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agents-md-session-'));
    manager = new SessionManager({
      storage: { dbPath: path.join(tmpDir, 'sessions.db') },
    });
  });

  afterEach(() => {
    _clearDbCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the shared empty fallback when no session is active', () => {
    const first = manager.getActiveAgentsMdContextStore();
    const second = manager.getActiveAgentsMdContextStore();
    expect(first).toBe(second);
    expect(first.size).toBe(0);
  });

  it('returns the scope store when a session is active', () => {
    const session = manager.create('default/mimo-v2.5');

    const active = manager.getActiveAgentsMdContextStore();
    expect(active).toBe(manager.getAgentsMdContextStore(session.id, 'main'));

    const sub = manager.getActiveAgentsMdContextStore(undefined, 'sub-1');
    expect(sub).toBe(manager.getAgentsMdContextStore(session.id, 'sub-1'));
    expect(sub).not.toBe(active);
  });

  it('empty fallback is safe and reports nothing in context', () => {
    const store = manager.getActiveAgentsMdContextStore();
    const entry = makeEntry('/ws/AGENTS.md');

    expect(store.isSeen(entry.path)).toBe(false);
    expect(store.unseen([entry])).toEqual([entry]);
    expect(() => store.markSeen(entry)).not.toThrow();
    expect(() => store.isSeen(entry.path)).not.toThrow();
    expect(() => store.unseen([entry])).not.toThrow();
  });
});
