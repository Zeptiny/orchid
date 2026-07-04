---
title: "feat&refactor: TUI polish — context viewer, footer fixes, compact paths, interrupt hiding, sidebar spacing, key hints, and theme compat"
type: feat
status: active
date: 2026-07-02
---

# TUI Polish: Context Viewer, Footer Fixes, Compact Paths, and Theme Compatibility

## Summary

Polish the Orchid TUI with eight focused improvements: a Claude Code–style `/context` breakdown viewer, a proper footer layout that eliminates the margin-right hack, relative path shortening in tool result titles, hidden interrupt system messages, consistent sidebar section spacing, discoverable keyboard shortcut hints in the footer, theme-safe message backgrounds, and an extracted sidebar stylesheet.

---

## Problem Frame

The current TUI has several papercuts that degrade readability and maintainability: the footer uses a fragile `margin-right: 31` hack to avoid the sidebar; tool result titles show full absolute paths that waste horizontal space; interrupt messages leak implementation state to the user; sidebar sections crowd together without visual breathing room; keyboard shortcuts are invisible unless the user discovers them by trial and error; `UserMessageWidget` hardcodes `#333333` which breaks on light themes; and the sidebar's 170-line inline `DEFAULT_CSS` is hard to iterate on.

---

## Requirements

- **R1.** A `/context` command (or sidebar view toggle) renders a detailed token-usage breakdown: System prompt, System tools, Tool use & results, Messages, and Free space — with percentages, similar to Claude Code's `/context`.
- **R2.** The footer layout is independent of sidebar width: no `margin-right` hack; the sidebar occupies its own docked pane and the footer spans the remaining width naturally.
- **R3.** Tool result titles (`msg.display`) render paths relative to the current working directory when the title contains an absolute path prefix.
- **R4.** Agent and subagent interruption no longer mounts a visible "[Interrupted by user]" message in the chat; the interrupt is recorded silently in the chain for persistence.
- **R5.** Each sidebar section (Tokens, Subagents, Background Commands, MCP Servers, Todos, AST, RAG) is separated by at least one blank line's worth of vertical space.
- **R6.** The footer displays active keyboard shortcut hints contextually: e.g. `Esc: interrupt | Ctrl+P: commands | Ctrl+S: submit` while streaming, and `Ctrl+P: commands` when idle.
- **R7.** `UserMessageWidget` background uses a theme variable (`$surface-darken-1` or `$panel`) instead of `#333333`, so it adapts to light themes.
- **R8.** Sidebar styles move from an inline `DEFAULT_CSS` string into a dedicated `sidebar.tcss` file, referenced via `CSS_PATH` or imported stylesheet.

---

## Scope Boundaries

- **Context viewer is a sidebar feature, not a new screen.** It replaces or augments the existing "Context: X" line rather than opening a modal or overlay.
- **Path shortening is best-effort.** If the path does not start with the working directory, it falls back to the full path. Paths inside tool `content` (not `display`) are not shortened.
- **Interrupt message hiding affects display only.** The message is still appended to `chain.messages` for session save/load consistency.
- **Key hints are static strings, not dynamic binding discovery.** Textual's `BINDINGS` list is not introspected at runtime; a curated hint string is updated in the footer based on app state.
- **Sidebar CSS extraction does not refactor layout logic.** Only the stylesheet moves; `compose()` and widget classes stay in `sidebar.py`.
- **Deferred:** A full `/context` modal with scrollable per-message breakdown (like Claude Code's full pop-up) — the sidebar-integrated version satisfies R1.

---

## Context & Research

### Relevant Code and Patterns

- `src/orchid/app.py` — footer compose (lines 269-273), `rerender_footer` (880-915), interrupt paths (508-525, 358-378), `_format_session_model_label`.
- `src/orchid/main.tcss` — `#footer` margin-right hack, `UserMessageWidget` background, `#interrupt-hint`.
- `src/orchid/widgets/sidebar.py` — `Sidebar.DEFAULT_CSS` (lines 109-281), compose order (299-317), `_flush_token_update`, `_usage_by_view`.
- `src/orchid/widgets/message_widget.py` — `get_tool_result_title`, `ChainFooterWidget`, `_build_text`.
- `src/orchid/themes/registry.py` — registered themes and available variables.
- `src/orchid/llm/client.py` — tool execution returns `ExecutorResult(display=...)` which becomes `Message.display`.
- `TODO.md` line 57: "Não mostrar [interrupted by user]"; line 59: MCP spacing issue.

### Institutional Learnings

- The sidebar already has per-view token tracking (`_usage_by_view`) and throttling (`_TOKEN_THROTTLE_INTERVAL = 0.5`). Any new token display should reuse `update_tokens` or extend `_flush_token_update`.
- `ChainFooterWidget._build_text` and `Chain.format_tokens` were recently added for per-chain token display (see `2026-06-22-001-feat-token-usage-display-plan.md`). The formatter helpers should be reused for the context viewer.

---

## Key Technical Decisions

- **Context viewer lands in the sidebar, not a modal.** Rationale: the sidebar is the designated information pane; adding a context breakdown there avoids a new screen and keeps the chat unobstructed.
- **Context viewer is always visible (not collapsible).** Rationale: the user wants constant awareness of where tokens are going. A multi-line `Static` replaces the single "Context: X" line.
- **Context breakdown is session-wide.** Rationale: context limits are a session-level constraint, not per-chain. The breakdown aggregates across all chains and subagents in the active session.
- **Token attribution uses character-based proportional allocation.** Rationale: exact per-category token counts are not available from the provider. By counting characters in each category and allocating the known `prompt_tokens` proportionally, we get a good estimate without tokenizer dependencies. The proportions cancel out the unknown "chars per token" rate.
- **Tool schema size is cached and invalidated on MCP changes.** Rationale: core tool definitions are static per session, but MCP servers can add tools dynamically. The sidebar/app caches `tools_char_count` and recomputes when the tool registry detects new MCP entries.
- **Path shortening happens at render time, not at tool creation.** Rationale: the working directory can change between tool execution and display (restored sessions, `cd` commands). Shortening in `get_tool_result_title` uses the current `app.working_dir` or `os.getcwd()`.
- **Interrupt message suppression is display-only, not data-layer.** Rationale: session persistence must keep the interrupt marker for replay correctness, but `create_message_widget` skips rendering messages with `hidden=True`.
- **Key hints are a new `#shortcuts` Static in the footer.** Rationale: Textual's built-in footer is too minimal for contextual hints. A curated string updated by `rerender_footer` based on `_interrupt_state` and streaming status is simplest.
- **Sidebar CSS extraction uses `CSS_PATH` on `Sidebar`.** Rationale: Textual supports `CSS_PATH` on any widget; moving the 170-line string to `src/orchid/widgets/sidebar.tcss` and setting `CSS_PATH = "sidebar.tcss"` on `Sidebar` keeps styles editable without re-importing the module.
- **UserMessageWidget background: `$panel`.** Rationale: `$panel` is the Textual variable for "raised surface behind content" and works across both dark and light themes. `$surface-darken-1` may be too subtle on some themes.

---

## Open Questions

### Resolved During Planning

- **Where to put the context viewer?** Resolved: augment the existing sidebar token area rather than a new modal. Always visible as a multi-line `Static` block.
- **Should path shortening use `os.path.relpath` or string prefix removal?** Resolved: `os.path.relpath` with a fallback to prefix removal, since `relpath` handles `..` gracefully and is the standard pattern already used in `tools/search.py`.
- **Should the interrupt message be removed from `chain.messages` entirely?** Resolved: no — keep it in the data model for replay/persistence, but skip mounting it in the UI using the new `Message.hidden` field.
- **Which theme variable replaces `#333333`?** Resolved: `$panel` — it is semantically "background for content panels" and adapts across themes. `$surface-darken-1` is too close to the main background on some dark themes.
- **How to attribute tokens to categories without API support?** Resolved: character-based proportional allocation. Count characters per category, then allocate the known `prompt_tokens` proportionally. This avoids tokenizer dependencies while giving a useful directional breakdown.
- **Should the breakdown be per-chain or session-wide?** Resolved: session-wide. Context limits apply to the entire session, so the breakdown aggregates all chains and subagents.
- **How to handle dynamic MCP tool additions?** Resolved: cache `tools_char_count` on the sidebar/app; invalidate when the tool registry detects new MCP entries. Core tools are static, MCP tools arrive asynchronously.

### Deferred to Implementation

- Whether key hints should also appear in a `HelpScreen` accessible via `?` or `F1`. A help screen is a nice-to-have beyond R6.

---

## Implementation Units

- U1. **Extract sidebar CSS to `sidebar.tcss`**

**Goal:** Move the 170-line `DEFAULT_CSS` string from `sidebar.py` into a dedicated stylesheet file.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Create: `src/orchid/widgets/sidebar.tcss`
- Modify: `src/orchid/widgets/sidebar.py` (remove `DEFAULT_CSS`, add `CSS_PATH`)

**Approach:**
- Copy `DEFAULT_CSS` content (lines 109-281) into `src/orchid/widgets/sidebar.tcss`, removing the triple-quote wrapper.
- Add `CSS_PATH = "sidebar.tcss"` to the `Sidebar` class.
- Verify no syntax errors by running the app briefly or relying on Textual's CSS validation.

**Patterns to follow:**
- `main.tcss` is already an external stylesheet loaded via `CSS_PATH` on the `App` class.

**Test scenarios:**
- App launches without CSS parse errors.
- Sidebar styling is visually identical to before (colors, widths, hover states).

**Verification:**
- `python -m orchid` starts; sidebar renders correctly.

---

- U2. **Replace `UserMessageWidget` hardcoded background with theme variable**

**Goal:** Make user message backgrounds theme-safe.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `src/orchid/main.tcss` (line 65: `background: #333333` → `background: $panel`)
- Modify: `src/orchid/themes/registry.py` (ensure `$panel` is defined in custom themes if not inheriting)

**Approach:**
- Replace `background: #333333` with `background: $panel` in `main.tcss`.
- Verify `bluey`, `windows_xp`, and `green_terminal` themes define `$panel` or inherit it from Textual's base. The custom themes in `registry.py` pass `panel` explicitly; if any omit it, add a sensible value.

**Patterns to follow:**
- Textual theme variables (`$primary`, `$surface`, etc.) already used elsewhere in `main.tcss`.

**Test scenarios:**
- Launch with `default` theme — user messages have a distinguishable background.
- Launch with `solarized-light` theme — background is light-appropriate, not dark gray.
- Launch with `bluey` theme — background blends with the theme's palette.

**Verification:**
- Switch themes via settings; user message background changes appropriately.

---

- U3. **Fix footer layout: remove margin-right hack**

**Goal:** Eliminate the `margin-right: 31` coupling between footer and sidebar width.

**Requirements:** R2

**Dependencies:** U1 (cleaner to do after CSS extraction, but not strictly blocked)

**Files:**
- Modify: `src/orchid/main.tcss` (remove `#footer { margin-right: 31; }`)
- Modify: `src/orchid/app.py` (restructure footer/sidebar container relationship)

**Approach:**
- Remove `margin-right: 31` from `#footer` in `main.tcss`.
- Restructure the app layout so the footer is inside a left-hand container that excludes the sidebar, or use Textual's `Horizontal` layout with the sidebar as a sibling rather than a docked overlay.
- The simplest fix: wrap `#output`, `#command-picker`, `#input`, and `#footer` in a `Vertical` container with `width: 1fr`, while the sidebar remains `dock: right`. Textual's layout engine will make the `1fr` container occupy the remaining space, so the footer naturally fits without margin hacks.
- In `app.py:compose()`, wrap the non-sidebar content in a `Vertical(id="main-pane")`.
- In `main.tcss`, set `#main-pane { width: 1fr; }` and `#footer { width: 100%; }`.

**Patterns to follow:**
- Textual's `dock` + `1fr` sibling pattern is standard for sidebar layouts.

**Test scenarios:**
- Footer spans full width of the main pane, not overlapping the sidebar.
- Resizing the terminal does not break footer alignment.
- Sidebar width can be changed without touching footer CSS.

**Verification:**
- Visual inspection: footer text ends at the left edge of the sidebar, not 31 cols before the right screen edge.

---

- U4. **Hide "[Interrupted by user]" messages from display**

**Goal:** Interrupt markers persist in data but are not shown in the chat.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/orchid/app.py` (interrupt paths at lines 508-525 and 358-378)
- Modify: `src/orchid/widgets/message_widget.py` (`create_message_widget` factory)

**Approach:**
- Option A (display-filter): In `create_message_widget`, skip rendering messages whose `content.strip() == "[Interrupted by user]"`.
- Option B (don't mount): In `app.py`, append to `chain.messages` but do not call `mount_message` for the interrupt marker.
- **Chosen: Option A** — keeps all mount paths uniform and centralizes the suppression in one place. If subagents or other code paths also emit these markers, they are all filtered.
- Also filter `[Subagents interrupted by user: ...]` via prefix match.

**Patterns to follow:**
- `create_message_widget` is the existing factory gate for message rendering.

**Test scenarios:**
- Interrupt a running agent — no "[Interrupted by user]" message appears in the chat.
- The chain still contains the interrupt message (inspect via session save/load).
- Interrupt with running subagents — no "[Subagents interrupted by user]" message appears.

**Verification:**
- Trigger an interrupt; chat shows the previous assistant message and then the user's next input, with no interrupt marker between them.

---

- U5. **Compact tool result paths relative to working directory**

**Goal:** Shorten absolute paths in tool result titles to be relative to the current working directory.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/orchid/widgets/message_widget.py` (`get_tool_result_title`)
- Modify: `src/orchid/app.py` (pass working directory context, or use `os.getcwd()`)

**Approach:**
- Add a helper `_shorten_path(title: str, cwd: str) -> str` that scans `title` for absolute paths (starting with `/` or a drive letter on Windows) and replaces occurrences of `cwd + "/"` or `cwd` with `./` or a relative path via `os.path.relpath`.
- `get_tool_result_title` calls this helper with `os.getcwd()` as the base.
- Handle edge cases: when `cwd` is `/`, don't replace everything; when path is outside `cwd`, `relpath` produces `../../..` which may or may not be desirable — cap at a max depth or keep absolute if `relpath` starts with `..`.

**Patterns to follow:**
- `tools/search.py` already uses `os.path.relpath(file_path, base_path)`.

**Test scenarios:**
- Title `"Edited /home/user/project/src/main.py"` with cwd `/home/user/project` → `"Edited src/main.py"`.
- Title `"Read /home/user/project/src/main.py lines 1-243"` → `"Read src/main.py lines 1-243"`.
- Path outside cwd (`"/etc/passwd"`) with cwd `/home/user/project` → falls back to `"/etc/passwd"` (or `../../etc/passwd` if relative mode chosen).
- Title with no path — unchanged.

**Verification:**
- Run a tool that edits a file; the collapsible title shows a relative path.

---

- U6. **Add one-line gap between sidebar sections**

**Goal:** Improve sidebar scannability with consistent vertical spacing.

**Requirements:** R5

**Dependencies:** U1 (extract CSS first, then modify the stylesheet)

**Files:**
- Modify: `src/orchid/widgets/sidebar.tcss` (or `sidebar.py` `DEFAULT_CSS` if U1 not done first)
- Modify: `src/orchid/widgets/sidebar.py` (compose order if spacers are widgets)

**Approach:**
- Add `margin-top: 1` to each section label in the sidebar CSS: `#sidebar-tokens-label`, `#sidebar-subagents-label`, `#sidebar-bg-cmds-label`, `#sidebar-mcp-label`, `#sidebar-todos-label`, `#sidebar-ast-label`, `#sidebar-rag-label`.
- Exclude the very first label (`#sidebar-tokens-label`) or let the sidebar's top padding absorb it.
- Alternatively, add `Static` spacers in `compose()` between sections. CSS margin is cleaner.

**Patterns to follow:**
- Textual CSS margin/padding conventions already used in `main.tcss`.

**Test scenarios:**
- Sidebar renders with visible blank line between Tokens and Subagents, Subagents and Background Commands, etc.
- MCP Servers section has same left spacing as Subagents and Todos (fixes TODO.md line 59).

**Verification:**
- Visual inspection: sidebar sections are no longer visually touching.

---

- U7. **Add contextual keyboard shortcut hints to footer**

**Goal:** Surface active shortcuts so users don't have to guess.

**Requirements:** R6

**Dependencies:** U3 (footer restructuring)

**Files:**
- Modify: `src/orchid/app.py` (compose: add `#shortcuts` Static to footer; `rerender_footer`: update hint text)
- Modify: `src/orchid/main.tcss` (style `#shortcuts`)

**Approach:**
- Add a `Static(id="shortcuts")` to the footer `Horizontal` in `app.py:compose()`.
- Define a helper `_get_shortcut_hints()` that returns a string based on app state:
  - Streaming: `"Esc: interrupt | Ctrl+P: commands | Ctrl+S: submit"`
  - Idle with input: `"Ctrl+S: submit | Ctrl+P: commands | Ctrl+C: clear"`
  - Idle no input: `"Ctrl+P: commands"`
  - Interrupt confirmation pending: `"Esc: confirm interrupt"`
- Call this in `rerender_footer` and update `#shortcuts`.
- Style `#shortcuts` with `color: $text-muted; text-style: dim;` so it's subtle.
- The `#interrupt-hint` can be retired or kept for the red/yellow confirmation text only; the static hints replace its informational role.

**Patterns to follow:**
- `rerender_footer` already updates multiple footer widgets atomically.

**Test scenarios:**
- Footer shows `Esc: interrupt | Ctrl+P: commands` while assistant is streaming.
- Footer shows `Ctrl+P: commands` when idle.
- Footer updates immediately after streaming stops.

**Verification:**
- Visual inspection: footer right side shows contextual hints that change with app state.

---

- U8. **Build sidebar context viewer breakdown**

**Goal:** Replace the single "Context: X" line with a detailed breakdown of context consumption.

**Requirements:** R1

**Dependencies:** U1, U6

**Files:**
- Modify: `src/orchid/widgets/sidebar.py` (`_flush_token_update`, compose, new breakdown rendering)
- Modify: `src/orchid/app.py` (capture system prompt text per chain; notify sidebar of tool set changes)
- Modify: `src/orchid/tools/__init__.py` or tool registry (expose schema JSON size)

**Approach:**
- The context viewer needs categories: System prompt, System tools, Tool use & results, Messages, Free space.
- **Data source challenge:** The current domain model does not track *which* tokens belong to which category. We must estimate.
- **Estimation strategy (character-based proportional allocation):**
  - For each category, count **characters** in the source text.
  - Allocate `total_prompt_tokens` proportionally by character share.
  - Formula: `category_tokens = (category_chars / total_chars) * total_prompt_tokens`
  - Rationale: tokenizers are roughly linear with character count for the same text type. By using proportions, the absolute "chars per token" rate cancels out. No tokenizer dependency needed.
  - **Known limitation:** JSON schemas tokenize slightly denser than natural language (one token per punctuation symbol). A `1.3x` weight can be applied to tool schema chars if empirical testing shows it's needed, but pure proportions are good enough for an estimate.
- **Categories and their character sources:**
  - **System prompt:** `len(system_prompt_text)` captured from the actual prompt sent to `stream_response` (stored on `Chain` or `Session`).
  - **System tools:** `len(json.dumps(tools))` where `tools` is the current `allowed_tools` list. Recomputed when the tool registry changes (e.g., MCP server initialization adds new tools).
  - **Tool use & results:** `sum(len(m.content) for m in session.messages if m.type == TOOL_RESULT or m.type == TOOL_CALL)` — session-wide.
  - **Messages:** `sum(len(m.content) for m in session.messages if m.role == USER or (m.role == ASSISTANT and not m.hidden and m.type == TEXT))` — session-wide.
  - **Free space:** `max_context - prompt_tokens` (not estimated — exact subtraction).
- **Tool schema caching:** Tool definitions are mostly static per session, but MCP servers can add tools dynamically. Cache `tools_char_count` on the sidebar or app; invalidate when `get_tool_registry()` detects new MCP tool entries. The MCP manager can emit an event or the app can recompute on its periodic tick.
- **UI layout:** Always-visible multi-line `Static` replacing `#token-info`. No collapsible — the user wants it always visible.
  ```
  Context: 33.6k (26%)
  ───────────────
  System: 5.3k (2.7%)
  Tools: 4.8k (2.4%)
  Tool use: 29.2k (14.6%)
  Messages: 1.6k (0.8%)
  Free: 156.8k (78.4%)
  ```
  - Labels abbreviated to fit 30 columns: "System prompt" → "System", "System tools" → "Tools".
  - Use `Chain.format_tokens` for compact numbers.
- **Normalization:** After computing all categories, scale them so their token sum exactly matches `Usage.prompt_tokens` (the actual reported total). This keeps percentages accurate even if individual estimates are off.
- Compute in `_build_context_breakdown()` called from `_flush_token_update`. Memoize by fingerprint `(total_prompt_tokens, num_messages, tools_hash)` to avoid re-computing on every tick.

**Patterns to follow:**
- `Chain.format_tokens` for compact numbers.
- `_flush_token_update` for throttled updates.
- The sidebar's existing `_usage_by_view` caching pattern.

**Test scenarios:**
- **With max context:** All five categories shown with percentages that sum to 100% (±1% rounding).
- **Without max context:** Categories shown with raw token counts only; no percentage column.
- **After tool call:** "Tool use" increases; "Messages" may decrease relatively (same total, different split).
- **After MCP server loads:** "Tools" category increases when new tools are registered.
- **Session restore:** Breakdown recomputed from restored messages; "Free" reflects current prompt vs. max context.
- **Zero messages:** "Messages" shows 0; system and tools still show their baseline; free space is max context minus baseline.

**Verification:**
- Visual inspection: sidebar shows a structured context breakdown comparable to the Claude Code screenshot.
- Percentages sum to 100% when max context is known.

---

## System-Wide Impact

- **Footer layout change (U3)** affects the visual footprint of every screen state (streaming, idle, interrupted). The `#interrupt-hint` may need width adjustments since the footer now spans the full main pane.
- **Interrupt suppression (U4)** removes a visual cue that users may have relied on to confirm their interrupt was received. The footer hint (`Esc: interrupt`) and the sudden stop of streaming provide enough feedback.
- **Path shortening (U5)** is a purely presentational change but could confuse users if the relative path is ambiguous (e.g., multiple directories named `src`). The fallback to absolute paths for external files mitigates this.
- **Theme change (U2)** affects all five themes. If a custom theme lacked `panel` definition, it now needs one.
- **CSS extraction (U1)** means future sidebar style edits happen in `sidebar.tcss`, not `sidebar.py`. No runtime behavior change.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Footer re-layout breaks input or command picker positioning. | Keep `#input` and `#command-picker` inside the same `#main-pane` wrapper so their width and docking are unchanged. |
| Context viewer categories are inaccurate because token attribution is heuristic. | Label the display as "estimated" or omit percentages when uncertain. The primary goal is a directional breakdown, not accounting precision. |
| Interrupt suppression hides the interrupt from the user entirely, causing confusion. | Keep the footer hint active during interrupt confirmation, and rely on the streaming stop as the primary feedback. |
| Sidebar CSS extraction breaks if `CSS_PATH` resolves incorrectly. | Use a repo-relative path and test that Textual resolves it from the widget's module directory. |
| Path shortening produces `../../../../` for external paths, which is worse than absolute. | Fallback: if `relpath` starts with `..` and has more than 2 levels, keep the absolute path. |
| Key hints string is too long for narrow terminals. | Truncate or abbreviate (e.g., `Esc: stop` instead of `Esc: interrupt`) when footer width is tight. |

---

## Documentation / Operational Notes

- Update `AGENTS.md` or `README.md` with the new `/context` viewer and visible key hints if user-facing docs exist.
- The `TODO.md` items at lines 57 and 59 can be checked off after U4 and U6 land.

---

## Sources & References

- `src/orchid/app.py` — footer compose, interrupt paths, `rerender_footer`, `_format_session_model_label`
- `src/orchid/main.tcss` — footer margin hack, `UserMessageWidget` background
- `src/orchid/widgets/sidebar.py` — `DEFAULT_CSS`, compose order, `_flush_token_update`
- `src/orchid/widgets/message_widget.py` — `get_tool_result_title`, `create_message_widget`
- `src/orchid/themes/registry.py` — custom theme definitions
- `TODO.md` — lines 57 (hide interrupt), 59 (MCP spacing)
- `docs/plans/2026-06-22-001-feat-token-usage-display-plan.md` — `Chain.format_tokens`, `ChainFooterWidget` patterns
