---
title: "feat: Smart auto-scroll with user scroll-lock detection"
type: feat
status: active
date: 2026-07-02
---

# feat: Smart auto-scroll with user scroll-lock detection

## Summary

Replace the unconditional `scroll_visible(animate=False)` calls with a smart auto-scroll system that automatically follows new content while the agent is working, but respects user intent when they scroll up — only resuming auto-scroll when they return to the bottom.

---

## Problem Frame

Currently, every streamed message widget calls `widget.scroll_visible(animate=False)` immediately after mounting. This means:

1. If the user scrolls up to review earlier output while the agent is still working, the next streamed chunk yanks them back to the bottom.
2. There is no concept of "user is reading history" vs "user is following live output."

This is a common UX pattern in terminals and chat apps: auto-scroll to bottom on new content unless the user has intentionally scrolled away, then resume auto-scroll only when the user returns to the bottom.

---

## Requirements

- R1. Auto-scroll to the bottom on new content while the agent is streaming, when the user has not scrolled away
- R2. Detect when the user manually scrolls up (away from the bottom) and pause auto-scroll
- R3. Resume auto-scroll when the user scrolls back to the bottom (within a small tolerance threshold)
- R4. On user message submission, always scroll to bottom and re-engage auto-scroll
- R5. The system must not interfere with non-streaming states (browsing history when idle)

---

## Scope Boundaries

- No horizontal scroll management — only vertical auto-scroll
- No "scroll to bottom" button (could be a future enhancement)
- No per-message scroll anchoring — this is purely "follow tail" vs "user is reading"

### Deferred to Follow-Up Work

- Floating "scroll to bottom" indicator/button when user has scrolled away during active streaming
- Smooth scroll animation options

---

## Context & Research

### Relevant Code and Patterns

- `src/orchid/app.py:302` — `ScrollableContainer(id="output")` is the main chat scroll container
- `src/orchid/app.py:612-616` — `_mount_in_chain` calls `widget.scroll_visible(animate=False)` unconditionally
- `src/orchid/widgets/message_widget.py:523-578` — `mount_streamed_message()` calls `scroll_visible` on every widget mount (6 call sites)
- Textual's `ScrollableContainer` exposes `scroll_y`, `max_scroll_y`, `scroll_visible()`, and `scroll_end()`
- Textual's `ScrollableContainer` posts `ScrollUp`/`ScrollDown` messages on user scroll events

### Key Textual API surface

- `container.scroll_y` — current vertical scroll offset
- `container.max_scroll_y` — maximum scroll offset (i.e., fully scrolled to bottom)
- `container.scroll_end(animate=False)` — programmatically scroll to the end
- `ScrollableContainer` inherits from `ScrollView` which has scroll event handling

---

## Key Technical Decisions

- **Track "at bottom" state on the `#output` container itself**: Rather than tracking scroll state in `app.py` with external variables, subclass or compose a wrapper that owns the `_auto_scroll` flag. This keeps scroll logic co-located and testable.
- **Threshold-based bottom detection**: Use a small pixel tolerance (e.g., 5px) when checking if the user is "at the bottom" — exact-pixel matches are fragile due to rounding and content height changes.
- **Replace `scroll_visible` with conditional `scroll_end`**: Instead of scrolling individual widgets into view, scroll the container to the end — this is semantically what "follow the tail" means and avoids partial-visibility jank.
- **User scroll detection via `on_scroll` watch or Textual message**: Hook into the container's scroll change events to detect user-initiated scrolls vs programmatic scrolls.

---

## Open Questions

### Resolved During Planning

- **How to distinguish user scroll from programmatic scroll?**: Use a flag (`_programmatic_scroll`) that is set `True` before calling `scroll_end` and cleared after. Any scroll event fired while the flag is `False` is user-initiated.

### Deferred to Implementation

- **Exact pixel threshold for "at bottom" detection**: Start with 5px, tune if needed based on testing
- **Whether Textual batches scroll events during `mount`**: May need to verify that `on_scroll` fires reliably after widget mounts

---

## Implementation Units

- U1. **Create SmartScrollContainer widget**

**Goal:** Replace the plain `ScrollableContainer` with a subclass that tracks auto-scroll state and exposes a `maybe_scroll_to_end()` method.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Create: `src/orchid/widgets/smart_scroll.py`
- Modify: `src/orchid/app.py`
- Modify: `src/orchid/main.tcss`
- Test: `tests/test_smart_scroll.py`

**Approach:**
- Subclass `ScrollableContainer` as `SmartScrollContainer`
- Add `_auto_scroll: bool = True` (engaged by default)
- Add `_programmatic_scroll: bool = False` (guards against self-triggered scroll events)
- Override or watch scroll events: when a scroll occurs and `_programmatic_scroll` is `False`, check if the user is now at the bottom (within threshold) — if yes, re-enable `_auto_scroll`; if no, disable it
- Expose `maybe_scroll_to_end()`: if `_auto_scroll` is True, call `self.scroll_end(animate=False)` wrapped in the programmatic guard
- Expose `force_scroll_to_end()`: always scroll to end and re-enable `_auto_scroll` (for user message submission)

**Patterns to follow:**
- Textual widget subclassing pattern used in `InputTextArea` in `app.py`
- Textual's `watch_scroll_y` reactive watcher for detecting scroll changes

**Test scenarios:**
- Happy path: container starts with auto-scroll enabled; calling `maybe_scroll_to_end()` scrolls to bottom
- Happy path: `force_scroll_to_end()` always scrolls and re-enables auto-scroll regardless of current state
- Edge case: user scrolls up → auto-scroll disables → `maybe_scroll_to_end()` becomes a no-op
- Edge case: user scrolls back to bottom (within threshold) → auto-scroll re-enables
- Edge case: programmatic scroll (via `maybe_scroll_to_end`) does not disable auto-scroll

**Verification:**
- Unit tests pass demonstrating state transitions
- Widget can be instantiated and composed in a Textual app context

---

- U2. **Wire SmartScrollContainer into the app**

**Goal:** Replace `ScrollableContainer(id="output")` with `SmartScrollContainer` and update all scroll call sites.

**Requirements:** R1, R4, R5

**Dependencies:** U1

**Files:**
- Modify: `src/orchid/app.py`
- Modify: `src/orchid/widgets/message_widget.py`

**Approach:**
- In `app.py:compose()`, replace `ScrollableContainer(id="output")` with `SmartScrollContainer(id="output")`
- In `_mount_in_chain()`, replace `widget.scroll_visible(animate=False)` with `self.query_one("#output", SmartScrollContainer).maybe_scroll_to_end()`
- In `mount_streamed_message()`, the function receives `container` as an argument — but the scroll calls should target the **parent scroll container**, not the chain's messages area. Refactor so that `mount_streamed_message` either:
  - Accepts an optional scroll container reference, or
  - Returns without scrolling, and the caller (`_stream_response`) triggers scroll after each mount
- In `action_submit_input()`, call `force_scroll_to_end()` when the user submits a message (R4)
- Remove all `scroll_visible(animate=False)` calls from `mount_streamed_message`

**Patterns to follow:**
- The existing pattern where `_stream_response` already has access to the `#output` container via `self.query_one`

**Test scenarios:**
- Happy path: submitting a user message scrolls to bottom and re-enables auto-scroll
- Happy path: during streaming, new messages trigger `maybe_scroll_to_end` which scrolls when auto-scroll is active
- Edge case: user scrolls up during streaming → new messages mount but container stays where user scrolled
- Edge case: user scrolls back to bottom during streaming → auto-scroll re-engages, subsequent messages scroll to end
- Integration: loading a session history (`mount_all_messages`) should NOT auto-scroll during mount — only scroll to end once at the end

**Verification:**
- Agent streaming output auto-follows to the bottom
- Scrolling up during streaming keeps position stable
- Scrolling back to bottom during streaming resumes auto-follow
- Submitting a new message always scrolls to bottom

---

- U3. **Handle edge cases for mount_all_messages and session switching**

**Goal:** Ensure session load and switch correctly manages scroll state.

**Requirements:** R5

**Dependencies:** U2

**Files:**
- Modify: `src/orchid/app.py`

**Approach:**
- In `mount_all_messages()`, suppress auto-scroll during bulk mount (set `_auto_scroll = False` temporarily or just don't call `maybe_scroll_to_end` during history replay)
- After all messages are mounted, call `force_scroll_to_end()` once to land at the bottom of the loaded session
- This ensures loading a long session doesn't trigger hundreds of intermediate scroll operations

**Patterns to follow:**
- The existing `mount_all_messages` loop structure

**Test scenarios:**
- Happy path: loading a session with 50 messages scrolls to the bottom once at the end
- Edge case: switching sessions resets auto-scroll state to engaged
- Edge case: empty session (no messages) doesn't error on scroll

**Verification:**
- Session switching lands at the bottom of the new session
- No visual jank or hundreds of scroll operations during session load

---

## System-Wide Impact

- **Interaction graph:** Only the `#output` ScrollableContainer and the message-mounting code paths are affected. Subagent tab scroll containers are separate and unaffected.
- **Error propagation:** Scroll failures are non-critical — if `maybe_scroll_to_end` throws, the app should continue functioning without auto-scroll rather than crashing.
- **State lifecycle risks:** The `_auto_scroll` flag must reset correctly on session switch to avoid stale state from a previous session's scroll position leaking.
- **Unchanged invariants:** The streaming pipeline, message model, and all tool/thinking/assistant widget rendering remain unchanged. Only the "where to scroll after mount" behavior changes.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Textual's scroll event fires unreliably during rapid widget mounts | Use `watch_scroll_y` reactive rather than DOM event; test with rapid content |
| Threshold too small → auto-scroll re-engages before user reaches true bottom | Start at 5px, tune empirically; err on the generous side |
| `max_scroll_y` updates lag behind widget mounts (content size not yet computed) | Call `maybe_scroll_to_end` with `call_after_refresh` or on next frame if needed |

---

## Sources & References

- Textual ScrollableContainer docs: https://textual.textualize.io/widgets/scrollable_container/
- Related pattern: VS Code terminal auto-scroll, Discord chat auto-scroll
