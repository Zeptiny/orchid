---
title: "feat: Full interface rework — three-panel layout, tool states, interrupt flow, Feather icons"
type: feat
status: active
date: 2026-07-08
---

# Full Interface Rework

## Summary

Complete UI rework of the Orchid Electron app to match the design mockup in `ce-brainstorm-visual/orchid-sidebar-split/screens/012-tool-states-interrupt-flow-feather-icons.html`. The rework introduces a three-panel layout (left sessions sidebar, center chat, right context sidebar), replaces Unicode icons with Feather Icons, implements inline tool call blocks with four distinct states (generating/running/completed/failed), adds a three-phase Esc interrupt flow, error banners, a command palette with sub-pickers, and a tabbed configuration mode.

---

## Problem Frame

The current UI uses a two-panel layout (chat + right sidebar with ToolRail) and Unicode characters for icons. Tool calls are split between inline collapse blocks and a separate ToolRail panel. The interrupt flow is two-phase. The design mockup (iteration 012) proposes a cleaner three-panel layout with inline-only tool display, proper iconography, richer interrupt states, and better error handling — all of which need to be implemented.

---

## Requirements

- R1. Three-panel layout: left sidebar (sessions), center (chat + composer), right sidebar (context/MCP/todos/usage)
- R2. Feather Icons via npm package, replacing all Unicode icon characters
- R3. Tool call states: generating (blue, streaming args), running (yellow, spinning), completed (no badge, collapsed), failed (red badge)
- R4. Tool call streaming: show partial JSON args as LLM generates them via `fullStream`
- R5. Three-phase Esc interrupt: running → confirmAgent → confirmSubagents → cancelled
- R6. Chain footer with usage stats and interrupted state
- R7. Error banners: stream error, rate limit, auth error, tool error
- R8. Command palette with sub-pickers (theme, personality)
- R9. Tabbed configuration mode (General, Providers, MCP, Tier Models, RAG)
- R10. Auto-scroll behavior: auto-scroll on new content, pause on scroll-up, re-enable on stream start

---

## Scope Boundaries

- ToolRail removal: the existing ToolRail + ToolWidgets directory will be removed; all tool display moves inline
- LiveCommandInline widget: deferred (existing background command output stays as-is in tool results)
- Session rename/delete flows: deferred to follow-up
- Streaming retry counter in UI: deferred
- Scroll-to-bottom button: not needed with current auto-scroll logic

### Deferred to Follow-Up Work

- Background command output viewer (right panel live output)
- Session rename/delete via palette commands
- Streaming retry counter display
- Scroll-to-bottom floating button

---

## Context & Research

### Relevant Code and Patterns

- `electron/src/renderer/components/ChatView.tsx` — current layout orchestrator
- `electron/src/renderer/components/ChatStream.tsx` — message list with auto-scroll
- `electron/src/renderer/components/MessageWidget.tsx` — per-message renderer
- `electron/src/renderer/components/InputArea.tsx` — composer with cancel
- `electron/src/renderer/components/Footer.tsx` — status bar
- `electron/src/renderer/components/Sidebar.tsx` — right sidebar
- `electron/src/renderer/components/CommandPalette.tsx` — Cmd+K palette
- `electron/src/renderer/components/ContextGrid.tsx` — context visualization
- `electron/src/renderer/components/ToolWidgets/` — ToolRail (to be removed)
- `electron/src/renderer/hooks/useChat.ts` — chat state hook
- `electron/src/renderer/hooks/useToolRail.ts` — tool rail hook (to be removed)
- `electron/src/main/agents/xstate/agent-machine.ts` — agent state machine
- `electron/src/main/agents/xstate/interrupt-machine.ts` — interrupt flow
- `electron/src/main/llm/orchestrator.ts` — stream orchestration
- `electron/src/main/ipc/chat.ts` — chat IPC handlers
- `electron/src/shared/types/ipc.ts` — IPC channel definitions

---

## Key Technical Decisions

- **Feather Icons via `react-feather`**: Official React wrapper for Feather Icons. Tree-shakeable, typed, well-maintained. Alternative `feather-icons` raw package would require manual SVG rendering.
- **Inline-only tool display**: Remove ToolRail entirely. Rich widgets (Monaco diff, xterm terminal) move to inline collapsible blocks with expandable content. This simplifies the layout and matches the mockup.
- **fullStream for tool call streaming**: Switch from `textStream` to `fullStream` in orchestrator to capture `tool-call-stream-start` and `tool-call-delta` events. Fallback to `textStream` + `onStepFinish` for providers that don't support it.
- **Three-phase interrupt via existing interrupt-machine.ts**: The existing machine already supports `confirmAgent` and `confirmSubagents`. The renderer needs to properly display all three phases instead of the current two.
- **Left sidebar sessions**: Session list moves from right sidebar to a new left sidebar component. Right sidebar retains context/MCP/todos/usage.

---

## Implementation Units

- U1. **Install Feather Icons and create icon component**

**Goal:** Add `react-feather` package and create a wrapper component that provides consistent sizing.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `electron/package.json`
- Create: `electron/src/renderer/components/Icon.tsx`
- Create: `electron/src/renderer/components/Icon.test.tsx`

**Approach:**
- Install `react-feather` as a dependency
- Create an `Icon` wrapper component that maps size props to Feather's size system
- Re-export commonly used icons as a convenience layer

**Patterns to follow:**
- Existing component patterns in `electron/src/renderer/components/`

**Test scenarios:**
- Happy path: Icon renders with correct size prop
- Happy path: Icon renders with correct color from parent context
- Edge case: Icon with no size prop defaults to 16px

**Verification:**
- `npm install` succeeds, Icon component renders in isolation

---

- U2. **Left sidebar — sessions panel**

**Goal:** Create a left sidebar with session list, search, new session button, and settings link.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Create: `electron/src/renderer/components/LeftSidebar.tsx`
- Create: `electron/src/renderer/components/LeftSidebar.test.tsx`
- Modify: `electron/src/renderer/components/ChatView.tsx`
- Modify: `electron/src/renderer/components/Sidebar.tsx` (remove sessions from right sidebar)

**Approach:**
- Build `LeftSidebar` component with: header (Orchid title + collapse/new buttons), search input, grouped session list (Today/Earlier), footer (settings button)
- Integrate into ChatView as the left column of the grid
- Remove session list from the existing right sidebar
- Use Feather icons: `Search`, `Plus`, `ChevronLeft`, `Settings`

**Patterns to follow:**
- Existing sidebar patterns in `Sidebar.tsx`
- Mockup HTML structure from frame 1 and 2

**Test scenarios:**
- Happy path: Sessions list renders with grouped items
- Happy path: Search filters sessions by title
- Happy path: New session button triggers session creation
- Edge case: Empty sessions shows "No sessions yet" message
- Edge case: Long session titles are truncated

**Verification:**
- Left sidebar renders with sessions, search works, new session creates entry

---

- U3. **Right sidebar — context/MCP/todos/usage panels**

**Goal:** Refactor right sidebar to show context grid, MCP servers, subagents, todos, and usage in collapsible sections.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `electron/src/renderer/components/Sidebar.tsx`
- Modify: `electron/src/renderer/components/ContextGrid.tsx`

**Approach:**
- Reorganize right sidebar sections: Context (with grid + legend), Usage, Subagents, Todos, MCP Servers
- Each section is a DaisyUI collapse
- Context grid shows 8x8 color-coded cells with legend
- Usage shows prompt/completion/total/cached tokens
- MCP shows server name + tool count badge
- Remove session list (moved to left sidebar)

**Patterns to follow:**
- Mockup frames 1 and 2 right panel structure

**Test scenarios:**
- Happy path: All sections render with correct data
- Happy path: Collapse toggle works for each section
- Edge case: Empty subagents/todos shows appropriate empty state

**Verification:**
- Right sidebar shows all sections, context grid renders correctly

---

- U4. **Three-panel layout refactor**

**Goal:** Refactor ChatView to use a three-panel grid layout: left sidebar (260px), center chat (flexible), right sidebar (300px).

**Requirements:** R1

**Dependencies:** U2, U3

**Files:**
- Modify: `electron/src/renderer/components/ChatView.tsx`
- Modify: `electron/src/renderer/App.tsx` (if needed for layout)

**Approach:**
- Change ChatView from two-column to three-column grid: `grid-template-columns: 260px minmax(460px, 1fr) 300px`
- Left sidebar collapsible (hides on narrow screens)
- Right sidebar collapsible via Ctrl+B
- Responsive breakpoint: at <980px, collapse sidebars to icon-only mode

**Patterns to follow:**
- Mockup `.app-frame` CSS grid definition

**Test scenarios:**
- Happy path: Three panels render at correct widths
- Happy path: Left sidebar collapses/expands
- Happy path: Right sidebar toggles via Ctrl+B
- Edge case: Narrow viewport collapses sidebars gracefully

**Verification:**
- Layout matches mockup, sidebars are collapsible

---

- U5. **Inline tool call blocks with four states**

**Goal:** Replace ToolRail with inline collapsible tool call blocks showing generating/running/completed/failed states.

**Requirements:** R3

**Dependencies:** U1, U4

**Files:**
- Create: `electron/src/renderer/components/ToolCallBlock.tsx`
- Create: `electron/src/renderer/components/ToolCallBlock.test.tsx`
- Modify: `electron/src/renderer/components/MessageWidget.tsx`
- Remove: `electron/src/renderer/components/ToolWidgets/ToolRail.tsx`
- Remove: `electron/src/renderer/components/ToolWidgets/ToolWidgetContainer.tsx`
- Remove: `electron/src/renderer/hooks/useToolRail.ts`

**Approach:**
- Build `ToolCallBlock` component: DaisyUI details/collapse with state-dependent styling
- States: `generating` (blue/info badge, spinning loader icon, shows streaming args), `running` (yellow/warning badge, spinning loader, shows description), `completed` (no badge, collapsed by default, shows result summary), `failed` (red/error badge, shows error message)
- Replace ToolCallMessage and ToolResultMessage rendering in MessageWidget
- Remove ToolRail and all ToolWidgets
- Use Feather icons: `Loader` (spinning), `Search`, `Terminal`, `FileText`, `Zap`

**Patterns to follow:**
- Mockup frame 2 tool block structure
- Existing collapse patterns in the codebase

**Test scenarios:**
- Happy path: Generating state shows blue badge and streaming args
- Happy path: Running state shows yellow badge and spinning icon
- Happy path: Completed state shows no badge, collapsed by default
- Happy path: Failed state shows red badge and error message
- Edge case: Tool block expands/collapses on click
- Integration: Tool call from agent stream renders correct state

**Verification:**
- Tool calls render inline with correct state indicators

---

- U6. **Tool call streaming (generating state)**

**Goal:** Implement `fullStream` in orchestrator to capture tool call streaming events and forward them to the renderer.

**Requirements:** R4

**Dependencies:** U5

**Files:**
- Modify: `electron/src/main/llm/orchestrator.ts`
- Modify: `electron/src/main/agents/xstate/agent-machine.ts`
- Modify: `electron/src/shared/types/ipc.ts`
- Modify: `electron/src/main/ipc/chat.ts`
- Modify: `electron/src/renderer/hooks/useChat.ts`

**Approach:**
- Switch from `textStream` to `fullStream` in orchestrator
- Handle `tool-call-stream-start` events: emit new `chat:toolCallStart` IPC with `{ toolCallId, toolName }`
- Handle `tool-call-delta` events: emit `chat:toolCallDelta` IPC with partial JSON
- Add `TOOL_CALL_START` and `tool_call_start` events to agent-machine and StreamEvent types
- Renderer: update tool block to `generating` state on `toolCallStart`, show partial args on `toolCallDelta`
- Fallback: keep `textStream` as fallback for providers without fullStream support

**Patterns to follow:**
- Existing `chat:chunk` IPC pattern for streaming text

**Test scenarios:**
- Happy path: Tool call generating state appears when LLM starts generating tool JSON
- Happy path: Partial args stream into the tool block in real-time
- Edge case: Provider without fullStream support falls back gracefully
- Error path: fullStream error doesn't crash the agent loop

**Verification:**
- Tool calls show "generating" state with streaming args before execution begins

---

- U7. **Three-phase Esc interrupt flow**

**Goal:** Implement the full three-phase Esc interrupt: confirmAgent → confirmSubagents → cancelled, with proper UI feedback.

**Requirements:** R5, R6

**Dependencies:** U4

**Files:**
- Modify: `electron/src/renderer/components/Footer.tsx`
- Modify: `electron/src/renderer/components/InputArea.tsx`
- Modify: `electron/src/renderer/hooks/useChat.ts`
- Modify: `electron/src/main/ipc/chat.ts`

**Approach:**
- Footer shows "Esc to interrupt" during streaming (with spinning loader icon)
- First Esc: footer changes to "Esc again: cancel agent" (warning icon, yellow text)
- Second Esc: cancels agent, partial content saved, chain footer shows "Interrupted" badge
- If subagents running: third phase shows "Esc again: cancel subagents"
- Chain footer: always visible below last message, shows `agent: in X cached Y out Z | sub: in X cached Y out Z | elapsed`
- When interrupted: prepends stop icon + "Interrupted" badge with stats
- Auto-reset after 5s of inactivity (existing behavior)
- Replace "[Interrupted by user]" inline message with chain footer badge

**Patterns to follow:**
- Mockup frame 3 interrupt flow states
- Existing interrupt-machine.ts two-phase logic

**Test scenarios:**
- Happy path: Streaming shows "Esc to interrupt" in footer
- Happy path: First Esc shows "Esc again: cancel agent"
- Happy path: Second Esc cancels stream, shows "Interrupted" in chain footer
- Happy path: Subagent running shows third phase "Esc again: cancel subagents"
- Edge case: Auto-reset after 5s returns to idle
- Edge case: Cancel during tool execution stops tool and saves partial content
- Integration: Partial assistant message is preserved after interrupt

**Verification:**
- All three interrupt phases work, chain footer shows correct state and stats

---

- U8. **Error banners**

**Goal:** Add error banner components for stream errors, rate limits, auth failures, and tool errors.

**Requirements:** R7

**Dependencies:** U1, U4

**Files:**
- Create: `electron/src/renderer/components/ErrorBanner.tsx`
- Create: `electron/src/renderer/components/ErrorBanner.test.tsx`
- Modify: `electron/src/renderer/components/ChatStream.tsx`
- Modify: `electron/src/renderer/components/ToolCallBlock.tsx`

**Approach:**
- Build `ErrorBanner` component with icon, title, message, and action buttons
- Error types: stream error (alert-circle, Retry + Dismiss), rate limit (alert-triangle, countdown + Switch Model + Dismiss), auth error (lock, Open Settings + Dismiss)
- Tool errors: inline in ToolCallBlock with failed badge (already in U5)
- Banners centered in chat area, dismissable
- ChatStream renders error banners for `chat:error` IPC events

**Patterns to follow:**
- Mockup frame 4 error banner structure
- Existing ErrorMessage in MessageWidget

**Test scenarios:**
- Happy path: Stream error shows banner with Retry and Dismiss buttons
- Happy path: Rate limit shows banner with countdown timer
- Happy path: Auth error shows banner with Open Settings button
- Happy path: Dismiss removes the banner
- Edge case: Multiple errors stack vertically
- Error path: Retry triggers new stream attempt

**Verification:**
- Error banners display correctly for each error type, actions work

---

- U9. **Command palette with sub-pickers**

**Goal:** Refactor the command palette to support sub-pickers for theme and personality selection.

**Requirements:** R8

**Dependencies:** U1

**Files:**
- Modify: `electron/src/renderer/components/CommandPalette.tsx`

**Approach:**
- Add sub-picker support: when user types `/theme` or `/personality`, palette shows a swatch/option picker instead of text results
- Theme sub-picker: color swatches with theme names, current theme highlighted
- Personality sub-picker: list of personality options
- Palette overlay: `position: fixed; inset: 0; z-index: 1000` (full screen)
- Keyboard: up/down navigate, Enter selects, Esc closes
- Feather icons in palette items

**Patterns to follow:**
- Mockup frame 5 palette structure
- Existing CommandPalette.tsx fuzzy search

**Test scenarios:**
- Happy path: Ctrl+K opens palette
- Happy path: `/theme` shows theme sub-picker with swatches
- Happy path: `/personality` shows personality options
- Happy path: Selecting a theme applies it immediately
- Happy path: Esc closes palette and returns focus to chat
- Edge case: Empty search shows all commands grouped

**Verification:**
- Palette opens, sub-pickers work, selections apply

---

- U10. **Configuration mode**

**Goal:** Build a tabbed configuration UI accessible via Settings button or Ctrl+,.

**Requirements:** R9

**Dependencies:** U1, U4

**Files:**
- Create: `electron/src/renderer/components/ConfigView.tsx`
- Create: `electron/src/renderer/components/ConfigView.test.tsx`
- Modify: `electron/src/renderer/App.tsx`

**Approach:**
- Build `ConfigView` with: header (title + save/close), tab bar (General, Providers, MCP, Tier Models, RAG), form body, footer (shortcuts)
- General tab: default model, theme, personality, ignored directories, tool limits, streaming settings
- Config layers display: defaults → home → project → env
- Unsaved indicator badge
- Ctrl+S to save, Esc to close
- Replaces chat view when active

**Patterns to follow:**
- Mockup frame 6 config structure
- Existing config schema in `electron/src/main/config/schema.ts`

**Test scenarios:**
- Happy path: Settings button opens config view
- Happy path: Tab switching works
- Happy path: Form fields populate with current config values
- Happy path: Save persists changes via `config:save` IPC
- Happy path: Unsaved badge appears on modification
- Edge case: Esc closes config and returns to chat
- Error path: Validation errors shown inline

**Verification:**
- Config view opens, tabs work, save persists changes

---

- U11. **Chat footer and composer refinements**

**Goal:** Update the chat footer to show model info, token count, context percentage, and keyboard shortcuts. Update composer with streaming state.

**Requirements:** R6, R10

**Dependencies:** U4

**Files:**
- Modify: `electron/src/renderer/components/Footer.tsx`
- Modify: `electron/src/renderer/components/InputArea.tsx`

**Approach:**
- Footer split into two areas: composer-info bar (cwd, model, tokens, context %) and chat-footer (keyboard shortcuts)
- During streaming: composer-info shows spinning loader + "streaming" indicator, input is disabled, Cancel button replaces Send
- Footer shows `Ctrl K commands`, `Ctrl B inspector`, `Ctrl N new session` shortcuts
- Chain footer (per-message): shows usage stats after each agent response

**Patterns to follow:**
- Mockup frame 1, 2, 3 footer/composer structure

**Test scenarios:**
- Happy path: Footer shows correct model and token info
- Happy path: Streaming state disables input and shows Cancel button
- Happy path: Cancel button triggers interrupt flow
- Edge case: Context percentage updates as conversation grows

**Verification:**
- Footer and composer match mockup behavior

---

- U12. **Auto-scroll behavior refinement**

**Goal:** Implement smart auto-scroll that pauses on scroll-up and re-enables on stream start.

**Requirements:** R10

**Dependencies:** U4

**Files:**
- Modify: `electron/src/renderer/components/ChatStream.tsx`

**Approach:**
- Auto-scroll triggers on: new message, streaming content update, new tool block
- If user scrolls up (>100px from bottom), auto-scroll pauses
- When streaming starts, auto-scroll re-enables regardless of position
- Use `IntersectionObserver` or scroll position detection

**Patterns to follow:**
- Existing auto-scroll logic in ChatStream.tsx

**Test scenarios:**
- Happy path: New messages auto-scroll to bottom
- Happy path: Scrolling up pauses auto-scroll
- Happy path: New stream re-enables auto-scroll
- Edge case: Rapid streaming doesn't cause scroll jitter

**Verification:**
- Auto-scroll behaves correctly in all scenarios

---

## System-Wide Impact

- **Interaction graph:** ChatView becomes the layout hub with three children (LeftSidebar, ChatPane, Sidebar). MessageWidget dispatches to ToolCallBlock instead of ToolRail. Footer handles interrupt state display.
- **Error propagation:** `chat:error` IPC triggers ErrorBanner in ChatStream. Tool errors show inline in ToolCallBlock.
- **State lifecycle risks:** Removing ToolRail while keeping inline tool display requires careful migration of existing tool call data structures.
- **API surface parity:** No backend API changes needed. IPC additions are additive (`chat:toolCallStart`, `chat:toolCallDelta`).
- **Integration coverage:** Tool call streaming (U6) requires testing with real LLM streams to verify fullStream fallback behavior.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| fullStream not supported by all providers | Fallback to textStream + onStepFinish |
| ToolRail removal breaks rich tool widgets (diff, terminal) | Inline blocks with expandable content replace them |
| Three-panel layout too wide on small screens | Responsive breakpoint collapses sidebars |
| Feather Icons bundle size | Tree-shaking via react-feather, only import used icons |

---

## Sources & References

- **Design mockup:** `ce-brainstorm-visual/orchid-sidebar-split/screens/012-tool-states-interrupt-flow-feather-icons.html`
- **Agent state machine:** `electron/src/main/agents/xstate/agent-machine.ts`
- **Interrupt machine:** `electron/src/main/agents/xstate/interrupt-machine.ts`
- **Orchestrator:** `electron/src/main/llm/orchestrator.ts`
- **IPC types:** `electron/src/shared/types/ipc.ts`
