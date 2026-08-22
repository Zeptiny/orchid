---
title: "Todo batch input treated as one stringified task"
date: 2026-08-21
category: logic-errors
module: todo tools
problem_type: logic_error
component: assistant
severity: medium
symptoms:
  - "todo_create called with an array of eight titles created only one task"
  - "The created task's title was the raw JSON-encoded array text"
  - "Subsequent todo_update calls mutated the single mega-task instead of individual tasks"
root_cause: missing_validation
resolution_type: code_fix
tags: [todo-tools, stringified-json, batch-input, zod-schema, tool-dispatch]
---

# Todo batch input treated as one stringified task

## Problem

`todo_create` batch support existed (issue #110), but some model/provider tool surfaces serialize array arguments as JSON strings. Because the input schema accepted either a string or an array, a serialized batch was silently treated as one task title instead of being expanded into multiple todos (issue #171).

## Symptoms

- Calling `todo_create` with eight titles created only one task.
- The task title was the raw JSON array text: `["Main: allow-list + project save semantics (...)", ...]`.
- The agent then adapted to the single mega-task and repeatedly updated it — the visible "confusion" in the issue screenshot.
- The model-facing tool declaration exposed `title` as `{"type":"string"}` even though the schema description documented array support.
- JSON-stringified arrays passed validation through the union's string branch, so the failure was silent.

## What Didn't Work

- **Batch-handler suspicion:** `electron/src/main/tools/todo/create.ts` already had an `Array.isArray(title)` branch creating one task per title (batch support landed in `8f89b6f6`/`45071389`).
- **zod-to-json-schema suspicion:** isolated conversion preserved the union as `anyOf`.
- **AI SDK suspicion:** `asSchema` conversion also preserved the array alternative.
- **Anthropic driver suspicion:** `sanitizeJsonSchema` preserves `anyOf`; it was not collapsing the schema.
- **Actual boundary:** the model-facing tool declaration had already simplified `title` to a string, so arrays arrived as JSON-encoded strings before app dispatch — upstream of app-owned converters and outside app control.
- **Dispatch confirmation:** `electron/src/main/llm/tool-dispatch.ts:367` passes `validation.data` to handlers, so a schema-boundary preprocess reaches SDK execution, eager-tool execution, and IPC paths alike.

## Solution

Schema-boundary normalization in `electron/src/main/tools/todo/create.ts`:

```ts
export function expandStringifiedBatch(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((el) => typeof el === 'string')) {
      return parsed;
    }
  } catch {
    // Not JSON — treat as a literal string value.
  }
  return value;
}

title: z.preprocess(
  expandStringifiedBatch,
  z.union([z.string(), z.array(z.string()).min(1).max(TODO_BATCH_MAX_SIZE)]).describe(
    'Task title or array of task titles for batch creation.',
  ),
),
```

`electron/src/main/tools/todo/update.ts` applies the same preprocessing to `id` and `title`; `status` additionally uppercases expanded elements before its enum union. `todo_delete` is single-id only — unaffected.

The existing handler then receives normalized data and keeps its batch behavior unchanged:

```ts
const titles = Array.isArray(title) ? title : [title];
const created = titles.map((t) => todoStore.create(t, owner));
```

## Why This Works

- **Root cause:** a JSON-stringified array matched `z.string()` in the `string | string[]` union, so validation succeeded without revealing that transport had changed the intended type.
- **Fix mapping:** `z.preprocess(expandStringifiedBatch, ...)` converts only valid JSON arrays of strings into actual arrays before the union runs.
- **Literal strings stay safe:** `'[not json'`, `'[1, 2]'`, and `'["a", 2]'` remain single titles (malformed JSON, or parsed elements not all strings).
- **Empty batches fail clearly:** `'[]'` expands to an array, then the existing `.min(1)` rejects it with a schema error.
- **Provider schema compatibility preserved:** the underlying union and descriptions are unchanged, so provider-facing schema output still exposes the same `anyOf` structure when the consumer supports it.
- **Single convergence point:** every dispatch path funnels through `registry.validate` → `validation.data`, so one preprocess covers SDK, eager-bridge, and IPC callers.

## Prevention

- Any tool argument modeled as a `string | array` union should tolerate JSON-stringified batches via a preprocess at the schema boundary — not handler-side parsing.
- Audit for vulnerable unions with: `z.union([z.string(), z.array(`
- Reuse the shared normalizer (`expandStringifiedBatch` from `todo/create.ts`) rather than duplicating parse logic.
- Preserve literal bracketed strings by requiring: trimmed leading `[`, successful JSON parse, array result, all elements of the expected primitive type.
- Keep cardinality constraints (`.min(1)`/`.max(N)`) on the array branch so normalized empty/oversized batches fail during validation.
- For enum arrays, expand the array first, then apply per-element normalization/validation.
- Schema-boundary test set: stringified valid batches, native arrays, literal bracketed strings, malformed JSON, mixed-type arrays, empty serialized arrays, index-matched update arrays. Regression tests live in `electron/tests/unit/todo-web-tools.test.ts` (stringified batch inputs section).

## Related Issues

- GitHub #171 — Agent getting confused when creating multiple todos with one call (the bug)
- GitHub #110 — Batch todo operations: create/update multiple tasks in one tool call (the feature whose transport quirk surfaced this)
