# TUI Performance Investigation

## Overview

Investigation into low interface performance in the Orchid TUI application (Textual-based terminal UI). The analysis covers widget rendering paths, timer-driven updates, session management, and DOM lifecycle patterns.

---

## Click and Scroll Sluggishness (Primary User-Facing Issue)

The most noticeable performance problem is sluggish response when **clicking** or **scrolling** the interface. This has a specific causal chain:

### Why scrolling is slow

The `#output` `ScrollableContainer` (`src/orchid/app.py:247`) holds every widget ever mounted in the session -- none are ever removed or virtualized. Each widget uses `height: auto` (27 instances across CSS files), which forces Textual to **measure the intrinsic height** of every widget during layout. On scroll, Textual recomputes layout for the entire tree, not just visible widgets.

Compounding this: `UserMessageWidget` and `AssistantMessageWidget` (`src/orchid/widgets/message_widget.py:193, 279`) inherit from `TextualMarkdown`, which internally creates a **sub-tree of child widgets** (paragraphs, code blocks, headings, lists, etc.). A single assistant response can expand into 10-20+ DOM nodes. After a long session, the DOM tree can have thousands of nodes, all participating in layout on every scroll frame.

### Why clicking is slow

Textual performs **hit-testing** by walking the widget tree from root to leaf on every click. With a large flat list of complex widgets in `#output`, each click must traverse the entire subtree to find which widget was clicked. The deeper the tree (Markdown sub-widgets, Collapsibles with their own children), the slower the hit-test.

### Timer-driven reflows during interaction

The 0.5s (`_tick_live_commands` at `app.py:683`) and 1.0s (`_tick_footer` at `app.py:569`, subagent footers at `subagent_ui.py:216`) timers call `.update()` on `Static` widgets, which triggers **layout reflows mid-scroll**. These mutations happen regardless of whether the user is currently interacting, causing frame drops and stutters during scroll/click.

### Missing `PAUSE_GC_ON_SCROLL`

Textual provides a built-in optimization flag that the app does not use:

```python
# src/orchid/app.py:188
class Orchid(App):
    PAUSE_GC_ON_SCROLL: bool = True  # Pauses Python GC during scroll
```

Without this, Python's garbage collector can run during scroll frames, causing unpredictable micro-stutters -- especially problematic given the GC pressure from `Session.messages` creating new lists every second (see finding #2 below).

### Recommended fixes for click/scroll

| Fix | Effort | Impact |
|-----|--------|--------|
| Set `PAUSE_GC_ON_SCROLL = True` on the App class | Trivial (one line) | Reduces GC-induced stutters |
| Collapse old chains into lightweight `Static` stubs after N chains | Medium | Bounds DOM tree size |
| Only expand stubs back to full widgets when scrolled into view | Medium-High | True virtualization |
| Suspend timers while the user is actively scrolling | Medium | Eliminates timer-induced reflows during interaction |
| Migrate to `ScrollView` with custom `render_line` | High (major refactor) | Full virtualization with O(1) scroll |

---

## Additional Root Causes (Streaming and Loading Performance)

### 1. Sequential `await mount()` in `mount_all_messages` (HIGH impact)

**File:** `src/orchid/app.py:780-805`

When switching sessions or reloading, every single message widget is mounted sequentially with individual `await container.mount(widget)` calls inside nested loops. For sessions with many chains and messages, this is O(n) DOM mutations, each triggering a layout pass.

```python
for chain_index, chain in enumerate(self.sessions.active.chains):
    # ...
    await container.mount(chain_container)  # layout pass
    for msg in chain.messages:
        widget = create_message_widget(msg, loaded=True)
        if widget is not None:
            await chain_container.messages_area.mount(widget)  # layout pass per msg
```

**Recommendation:** Batch-mount widgets using `await container.mount(*widgets)` to reduce layout recalculations from N to 1.

---

### 2. `Session.messages` property creates a new list on every access (HIGH impact)

**File:** `src/orchid/domain/session.py:37-38`

```python
@property
def messages(self) -> list[Message]:
    return [msg for chain in self.chains for msg in chain.messages]
```

This property is called in `_stream_response` on every LLM call and in `rerender_footer` which runs every second during streaming. Each invocation creates a brand-new list comprehension flattening all chains. As the session grows (hundreds of messages), this becomes increasingly expensive and generates GC pressure.

**Recommendation:** Cache the flattened list and invalidate on chain/message mutation, or avoid materializing it when only iteration is needed.

---

### 3. `_session_usage_totals` iterates all chains + all subagents every tick (MEDIUM impact)

**File:** `src/orchid/app.py:67-103`

Called from `rerender_footer` which runs every 1 second during streaming (`_tick_footer`). It iterates every message in every chain AND every subagent record. Combined with issue #2, this means flattening + scanning the entire session history every second.

**Recommendation:** Cache cumulative usage totals incrementally (add new usage delta instead of re-summing everything).

---

### 4. `_tick_live_commands` runs every 0.5s with sidebar rebuild (MEDIUM impact)

**File:** `src/orchid/app.py:683, 688-756`

This timer runs every 500ms and calls `sidebar.update_background_commands()`. On `_refresh_bg_cmd_display` (`sidebar.py:793`), even "structure_changed = False" iterations still loop through all children doing string formatting and widget updates. On structure changes, it does a full `remove_children()` + `mount()` cycle.

**Recommendation:** Only wake on actual changes (event-driven instead of polling), or increase the interval to 1-2 seconds.

---

### 5. `update_subagents` and `update_todos` fully rebuild on structure changes (MEDIUM impact)

**File:** `src/orchid/widgets/sidebar.py:474-575, 662-711`

Both methods do a full `await container.remove_children()` followed by `await container.mount(*entries)` when the structure changes. This tears down and recreates the entire widget subtree, triggering full relayout.

**Recommendation:** Use a diffing approach -- only add/remove changed entries rather than rebuilding the entire container.

---

### 6. `AssistantMessageWidget` uses Textual's `MarkdownStream` for every content delta (MEDIUM impact)

**File:** `src/orchid/widgets/message_widget.py:279-298`

Every content chunk from the LLM calls `await self._stream.write(delta)` which triggers markdown re-parsing and re-rendering. The underlying `TextualMarkdown` widget re-parses the entire markdown document on each write. For long responses, this becomes progressively more expensive as the content accumulates.

**Recommendation:** This is inherent to the Textual Markdown streaming API. Consider throttling updates to the markdown widget more aggressively (e.g., buffer content and flush every 200-300ms like `ThinkingMessageWidget` does).

---

### 7. `list_saved_sessions` loads and JSON-parses every session file (LOW impact, noticeable on `/sessions`)

**File:** `src/orchid/storage.py:54-71`

When listing sessions, it opens and fully parses every `.json` session file to extract metadata. For users with many sessions, this blocks the event loop.

**Recommendation:** Store an index file with metadata, or read only the first N bytes of each file to extract the header.

---

### 8. No virtualization on the `#output` ScrollableContainer (HIGH impact for click/scroll)

The `#output` container keeps all message widgets mounted in the DOM. For long sessions, the widget tree grows unbounded -- Textual still lays out and composites all widgets even if they are off-screen. This is the **primary cause of sluggish scrolling and clicking** (see detailed analysis in the "Click and Scroll Sluggishness" section above).

**Recommendation:** For very long sessions, consider unmounting off-screen widgets or collapsing old chains into stubs.

---

## Priority Summary

| Priority | Issue | Expected Impact |
|----------|-------|-----------------|
| P0 | Set `PAUSE_GC_ON_SCROLL = True` | Quick win for scroll stutter |
| P0 | Batch widget mounting in `mount_all_messages` | Major improvement on session load/switch |
| P0 | Cache `Session.messages` or avoid materialization | Reduces per-tick CPU during streaming |
| P1 | Widget virtualization / chain collapsing for `#output` | Fixes scroll/click sluggishness in long sessions |
| P1 | Incremental usage totals in footer | Eliminates O(n) scan per second |
| P1 | Event-driven live command updates | Removes constant 500ms polling overhead |
| P2 | Throttle `AssistantMessageWidget` content updates | Reduces markdown re-parse frequency |
| P2 | Sidebar diff-based updates | Avoids full teardown/rebuild cycles |
| P2 | Suspend timers during active scroll | Eliminates reflow interruptions |
| P3 | Session listing index file | Faster `/sessions` command |

---

## Timers Active During Streaming

| Timer | Interval | Source | Work Done |
|-------|----------|--------|-----------|
| `_footer_timer` | 1.0s | `app.py:569` | `_tick_footer` -> `rerender_footer` (iterates all messages) |
| `_bg_cmd_timer` | 0.5s | `app.py:683` | `_tick_live_commands` (polls store, updates sidebar) |
| subagent timer | 1.0s | `subagent_ui.py:216` | `_tick_subagent_footers` (ticks all mounted footers) |

All three timers run concurrently during active streaming, creating a cumulative load of DOM updates every 500ms at minimum.
