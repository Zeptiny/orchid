---
description: Handoff instructions for brainstorm -- next-step option set, per-selection dispatch instructions, and closing summary formats.
---

# Handoff

This content is loaded when Phase 4 begins -- after the requirements document is written.

---

#### 4.1 Present Next-Step Options

Present only the options that apply. Renumber so visible options stay contiguous starting at 1.

If `Resolve Before Planning` contains any items:
- Ask the blocking questions now, one at a time, by default
- If the user explicitly wants to proceed anyway, first convert each remaining item into an explicit decision, assumption, or `Deferred to Planning` question
- Do not offer the `Plan implementation` or `Build it now` options while `Resolve Before Planning` remains non-empty

**Preamble when no blocking questions remain:**

```
Brainstorm complete.

Requirements doc: <absolute path to requirements doc>

What would you like to do next?
```

**Preamble when blocking questions remain and user wants to pause:**

```
Brainstorm paused. Planning is blocked until the remaining questions are resolved.

Requirements doc: <absolute path to requirements doc>

What would you like to do next?
```

Present only the options that apply. Renumber so visible options stay contiguous starting at 1.

1. **Plan implementation with `plan` (Recommended)** - Move to `plan` for structured implementation planning. Shown only when `Resolve Before Planning` is empty.
2. **Start building with `work` (skip planning)** - Skip planning and move to `work`; suited to lightweight, well-defined changes. Shown only when `Resolve Before Planning` is empty and scope is lightweight, success criteria are clear, scope boundaries are clear, and no meaningful technical or research questions remain.
3. **More clarifying questions to sharpen the doc** - Keep refining scope, edge cases, constraints, and preferences through further dialogue. Always shown.
4. **Done for now** - Pause; the requirements doc is saved and can be resumed later. Always shown.

#### 4.2 Handle the Selected Option

**If user selects "Plan implementation with `plan` (Recommended)":**

Immediately load the `plan` skill in the current session. Pass the requirements document path when one exists; otherwise pass a concise summary of the finalized brainstorm decisions.

**If user selects "Start building with `work` (skip planning)":**

Immediately load the `work` skill in the current session using the finalized brainstorm output as context. If a compact requirements document exists, pass its path.

**If user selects "More clarifying questions to sharpen the doc":** Return to Phase 1.3 (Collaborative Dialogue) and continue asking the user clarifying questions one at a time. Continue until the user is satisfied, then return to Phase 4.

**If user selects "Done for now":** Display the closing summary (see 4.3) and end the turn.

#### 4.3 Closing Summary

When complete and ready for planning, display:

```text
Brainstorm complete!

Requirements doc: <absolute path to requirements doc>

Key decisions:
- [Decision 1]
- [Decision 2]

Recommended next step: `plan`
```

If the user pauses with `Resolve Before Planning` still populated, display:

```text
Brainstorm paused.

Requirements doc: <absolute path to requirements doc>

Planning is blocked by:
- [Blocking question 1]
- [Blocking question 2]

Resume with `brainstorm` when ready to resolve these before planning.
```
