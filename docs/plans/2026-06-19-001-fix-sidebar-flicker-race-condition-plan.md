# fix: Sidebar subagent display flickers from concurrent update race condition

## Problem Frame

The sidebar subagent section flickers every ~1 second — sometimes showing duplicate entries, sometimes empty, sometimes stale. The root cause is **uncoordinated concurrent async calls** to `_refresh_subagent_display()` that interleave at `await` points in the DOM rebuild cycle.

### Call sites (all fire independently)

| Caller | File:Line | Trigger |
|--------|-----------|---------|
| `on_spawn` | `src/stupidex/widgets/subagent_ui.py:50` | `_fire_and_forget` from manager |
| `on_state_change` | `src/stupidex/widgets/subagent_ui.py:98` | `_fire_and_forget` from manager |
| `_tick_timer` | `src/stupidex/widgets/subagent_ui.py:150` | 1-second interval timer |
| session switch | `src/stupidex/app.py:553` | User switches session |

### The non-atomic rebuild

`_refresh_subagent_display` (`sidebar.py:386-482`) performs three sequential `await` calls:

```python
await container.remove_children()       # yields → another caller can run
await container.mount(*active_entries)  # yields → another caller can run
await container.mount(collapse)         # yields → another caller can run
```

Between each `await`, other pending `update_sidebar` calls can execute, causing:
- **Duplicates**: Two concurrent mounts both succeed on the same container
- **Empty state**: One call's `remove_children()` wipes another's partially-mounted content
- **Flicker**: Every 1-second tick triggers a full rebuild even when only elapsed-time labels changed

### Contributing factor: `structure_changed` is order-sensitive

At `sidebar.py:422-423`, `active_ids != current_active_ids` compares lists. Since `active_records` is built from `reversed(running + pending)`, if the ordering of records changes between concurrent calls (e.g., a subagent transitions state), this triggers the full `remove_children` → `mount` path unnecessarily, worsening the flicker.

## Approach

Add an `asyncio.Lock` in `SubagentUIManager.update_sidebar()` with a **coalescing dirty flag**. When a request arrives while another is already running, it sets a dirty flag instead of queuing. The running request re-checks after finishing and runs once more if dirty. This guarantees:

1. At most one rebuild runs at a time (no interleaving)
2. Stale requests are collapsed (no queue buildup)
3. The most recent state always wins

### Why coalescing, not a plain lock

A plain lock would serialize all callers — if `on_state_change` holds the lock, the 1-second timer blocks behind it. With coalescing, the timer's request merges into the current in-flight update, avoiding unnecessary sequential rebuilds.

## Implementation Units

### U1. Add lock and coalescing to `SubagentUIManager.update_sidebar`

**Goal:** Serialize concurrent sidebar refresh requests and collapse redundant ones.

**Files:**
- `src/stupidex/widgets/subagent_ui.py` (modify)
- `src/stupidex/widgets/sidebar.py` (no change needed)

**Approach:**

1. In `SubagentUIManager.__init__`, add:
   - `self._sidebar_lock: asyncio.Lock` — serializes DOM rebuilds
   - `self._sidebar_refresh_pending: bool` — dirty flag for coalescing

2. Rewrite `update_sidebar()` to use the lock+coalescing pattern:
   - If lock is not held: acquire it, do the update, then loop to check if dirty was set during the update (re-run once if so)
   - If lock is already held: set `_sidebar_refresh_pending = True` and return immediately (caller is dropped; the in-flight caller will re-run)

3. Keep `_manage_timer()` outside the lock — it's synchronous, doesn't touch the DOM, and only reads `has_running` to arm/disarm the timer.

**Pseudo-code:**

```python
async def update_sidebar(self) -> None:
    if self._sidebar_lock.locked():
        self._sidebar_refresh_pending = True
        return

    async with self._sidebar_lock:
        while True:
            self._sidebar_refresh_pending = False
            await self._do_sidebar_refresh()
            if not self._sidebar_refresh_pending:
                break
    self._manage_timer()
```

Where `_do_sidebar_refresh()` contains the current body of `update_sidebar` (the `query_one` + `update_subagents` call). Extract it to keep the lock logic clean.

**Test scenarios:**
- Single update: sidebar renders correctly (regression guard)
- Two concurrent updates: only one full rebuild executes; final state reflects the latest data
- Timer tick during structure change: no duplicates, no empty state

### U2. Add concurrency test for sidebar update

**Goal:** Verify the lock prevents interleaved DOM mutations.

**Files:**
- `tests/test_sidebar_collapsible.py` (extend)

**Approach:**

Using the existing `_SidebarApp` and `_record` helpers in the test file:

1. Create test that launches two concurrent `update_sidebar` calls with structure-changing records (e.g., one adds a running agent, another adds a completed agent). Verify the final DOM has exactly one set of entries — no duplicates.

2. Create test that verifies coalescing: fire several rapid `update_sidebar` calls and assert the lock was acquired fewer times than the number of calls (i.e., some were coalesced).

**Test scenarios:**
- Concurrent updates produce correct final DOM (no duplicates, no empty state)
- Coalescing drops intermediate requests

## Risks

- **Lock held during long DOM operations**: If Textual's `mount()` or `remove_children()` is slow (e.g., many entries), the lock could be held for a while. This is acceptable because: (a) the sidebar typically has few entries, and (b) the coalescing ensures dropped callers don't wait — they just mark dirty and return.

- **Deadlock**: Not possible — `update_sidebar` is the only lock holder and it never awaits anything that calls back into `update_sidebar` (the `await` calls are to Textual's DOM API, which doesn't re-enter our code).

## Verification

1. Run existing tests: `pytest tests/test_sidebar_collapsible.py` — all should pass
2. Run new concurrency tests
3. Manual verification: spawn multiple subagents, observe sidebar for 10+ seconds — no flicker, duplicates, or empty states
