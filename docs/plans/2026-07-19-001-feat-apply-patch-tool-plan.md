---
title: "feat: Add apply_patch tool for multi-file patch application"
type: feat
status: active
date: 2026-07-19
origin: docs/brainstorms/apply-patch-tool-requirements.md
---

# feat: Add apply_patch tool for multi-file patch application

## Summary

Implement an `apply_patch` tool that accepts the OpenAI/Codex `*** Begin Patch` format and applies multi-file create, update, delete, and rename operations in a single tool call. The implementation is structured as four layers — parser, matcher, application engine, and tool handler — with a custom agent projector and UI renderer for multi-file results.

---

## Problem Frame

Orchid's `edit` tool requires byte-exact string matches and operates on one file per call. Multi-file refactors produce N round-trips with redundant context, and minor whitespace or Unicode drift causes edit failures that force re-reads and retries. Models are increasingly trained on the OpenAI apply_patch format; accepting it directly reduces hallucinated syntax and improves first-attempt success. (see origin: `docs/brainstorms/apply-patch-tool-requirements.md`)

---

## Requirements

- R1. Accept a single `patch` string in the `*** Begin Patch` ... `*** End Patch` envelope format
- R2. Support `*** Add File:`, `*** Update File:`, `*** Delete File:` operation headers
- R3. Support `*** Move to:` rename directive within update hunks
- R4. Support `@@` context hint lines for search disambiguation, including stacked hints
- R5. Support `*** End of File` marker for EOF-anchored chunks
- R6. Support multiple `@@` chunks per file, applied in order
- R7. Lenient parsing: strip heredoc wrappers (`<<'EOF'...EOF`)
- R8. 4-tier progressive matching: exact → trim-end → trim-both → Unicode normalization + trim
- R9. Per-file error with unmatched lines and file path on match failure
- R10. `@@` context hints narrow search position before matching change lines
- R11. `Add File` creates files with auto-created parent directories
- R12. `Update File` requires existing file; nonexistent is a per-file error
- R13. `Delete File` removes file; nonexistent is a per-file error
- R14. `Move to` writes updated content to new path, removes original
- R15. Per-file independent sequential application; one failure doesn't block others
- R16. Per-file status reporting with committed-file tracking on partial failure
- R17. Paths resolved against frozen turn cwd; reject traversal outside project directory
- R18. Atomic writes prevent partial content on failure
- R19. Per-file change data uses existing `file-change` result infrastructure (hunks, counts)
- R20. Aggregate result includes summary of all files touched with per-file status

**Origin acceptance examples:** AE1–AE8 (see origin document)

---

## Scope Boundaries

- Unified diff format not supported; only `*** Begin Patch` envelope
- All-or-nothing multi-file atomicity not implemented
- Existing `edit` and `write` tools not deprecated
- No custom renderer UI beyond per-file diff rendering via existing patterns
- No streaming/incremental patch parsing
- No approval/permission UI specific to apply_patch

---

## Context & Research

### Relevant Code and Patterns

- `src/main/tools/filesystem/edit.ts` — handler pattern: read → validate preconditions → `buildStructuredFileChange` → schema-parse at mutation boundary → `atomicWrite`
- `src/main/tools/filesystem/write.ts` — file creation pattern: `mkdirSync(recursive)` + `atomicWrite` + `chmod 0o644` for new files
- `src/main/tools/filesystem/structured-diff.ts` — `buildStructuredFileChange({ path, operation, oldContent, newContent })` computes and validates hunks via jsdiff before mutation
- `src/main/tools/types.ts` — `ToolDefinition`, `ToolHandler`, `resolveToolPath`, `ToolExecutionContext`
- `src/main/tools/result.ts` — `defaultFamilyAgentProjectors`, `fileChangeAgentProjector` (reconstructs old/new strings from hunks), `finalizeToolExecutionResult`
- `src/shared/types/tool-result-filesystem.ts` — `fileChangeDataSchema`, `fileChangeHunkSchema` (strict, single-file)
- `src/renderer/components/ToolResults/FileChangeToolResult.tsx` — diff rendering with DaisyUI semantic tokens
- `src/renderer/components/ToolResults/registry.tsx` — `toolRenderers` / `familyRenderers` maps, `resolveToolResultRenderer`
- `src/main/tools/index.ts` — `registerBuiltinToolsInto` registration pattern
- `tests/unit/file-tools.test.ts` — handler test pattern (tmpDir, `toolCtx()`, direct handler invocation, on-disk verification)
- `tests/unit/filesystem-tool-results.test.ts` — result pipeline test pattern (registry dispatch, canonical + projection assertions, `_setStructuredPatchForTests` seam)
- `tests/parity/tools.test.ts` — inventory protection (`EXPECTED_TOOL_NAMES`, counts, definition validation)

### External References

- Codex `apply-patch` crate: `codex-rs/apply-patch/src/parser.rs` (grammar, lenient parsing), `seek_sequence.rs` (4-tier matching), `lib.rs` (application engine, delta tracking)
- OpenAI apply_patch docs: https://developers.openai.com/api/docs/guides/tools-apply-patch
- Codex model instructions: `codex-rs/prompts/templates/apply_patch_tool_instructions.md`

---

## Key Technical Decisions

- **`generic` family with tool-level custom projector over new result family**: The `file-change` family is single-file by design. Rather than registering a new family (touching 6+ files for family registration, copy serialization, renderer registry, and count tests), use the `generic` family with a custom `agentProjector` on the tool definition and a tool-specific renderer via `toolRenderers.set('apply_patch', ...)`. This gives full control over multi-file projection and rendering with minimal plumbing. Per-file update facts still use `buildStructuredFileChange` so coordinates/counts can't drift.

- **Reject absolute paths in patches**: The Codex format spec says "File references can only be relative, NEVER ABSOLUTE." Codex itself accepts absolute paths, but Orchid's security model (audit S4 P0 #1) requires stricter confinement. All paths must be relative, resolved against `ctx.cwd`, with a containment check rejecting `../` traversal.

- **Apply all chunks then diff once per file**: Multiple `@@` chunks within a single file are applied sequentially to compute the final new content in memory. Then `buildStructuredFileChange(oldContent, newContent)` is called once, producing one aggregate diff. Individual chunk boundaries are not preserved in the canonical result.

- **Port Codex matching algorithm as-is**: The 4-tier `seek_sequence` (exact → trim-end → trim-both → Unicode normalization + trim) is ported directly from `codex-rs/apply-patch/src/seek_sequence.rs`. The Unicode normalization table covers typographic dashes, curly quotes, and exotic spaces.

- **Parser as a separate pure module**: The patch parser is a pure function (string → structured hunks) with no filesystem access, enabling thorough unit testing independent of the handler. Same for the matching algorithm and content transformation.

---

## Open Questions

### Resolved During Planning

- **Result schema shape**: New `applyPatchResultDataSchema` wrapping an array of per-file results (each with status, optional `FileChangeData`, optional error). Tool uses `generic` family + custom projector. (see origin: Outstanding Questions Q1)
- **Unicode normalization scope**: Port Codex table as-is. (see origin: Q2)
- **Absolute path handling**: Reject; relative-only with containment check. (see origin: Q3)
- **Multi-chunk diff computation**: Apply all chunks → final content → one `buildStructuredFileChange` per file. (see origin: Q4)
- **Multi-file envelope framing**: One envelope, custom projector emits per-file XML. (see origin: Q5)

### Deferred to Implementation

- Exact XML projection format for per-file results — will be refined against the existing `fileChangeAgentProjector` output during implementation
- Whether the `applyPatchResultDataSchema` should include the raw patch text for replay/debugging
- Edge cases around CRLF handling in the parser (Codex strips `\r`; port and verify)

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
LLM tool call: { patch: "*** Begin Patch\n..." }
│
├─ 1. PARSE (pure, no I/O)
│   parsePatch(patch) → Hunk[]
│   (AddFile | DeleteFile | UpdateFile { chunks, movePath })
│
├─ 2. RESOLVE PATHS
│   for each hunk:
│     resolveToolPath(ctx.cwd, hunk.path) → absolute
│     assertContained(resolved, ctx.cwd)  ← reject ../ traversal
│
├─ 3. APPLY PER-FILE (sequential, independent)
│   for each hunk:
│     ├─ AddFile:
│     │   mkdirSync(parent, recursive) → atomicWrite(content) → chmod 0o644
│     │
│     ├─ DeleteFile:
│     │   verify exists + not directory → unlink
│     │
│     └─ UpdateFile:
│         readFileSync → split lines
│         for each chunk:
│           seekSequence(lines, chunk.oldLines, start, chunk.eof)
│             tier 1: exact → tier 2: trimEnd → tier 3: trim → tier 4: unicode+trim
│           apply replacements → new lines
│         join → newContent
│         buildStructuredFileChange(old, new) → FileChangeData
│         atomicWrite(newContent)
│         if movePath: write to dest, remove original
│
├─ 4. COLLECT RESULTS
│   per-file: { path, status, fileChangeData?, error? }
│   aggregate: { files: [...], added, modified, deleted, failed }
│
├─ 5. PROJECT (custom agentProjector)
│   per successful file → file-change XML (old_string/new_string from hunks)
│   per failed file → error XML with unmatched lines
│
└─ 6. RENDER (ApplyPatchToolResult.tsx)
    per file → reuse FileChangeToolResult diff rendering pattern
```

---

## Implementation Units

- U1. **Patch parser**

**Goal:** Parse the `*** Begin Patch` envelope format into structured hunk objects. Pure function, no filesystem access.

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** None

**Files:**
- Create: `src/main/tools/filesystem/apply-patch-parser.ts`
- Test: `tests/unit/apply-patch-parser.test.ts`

**Approach:**
- Port the grammar from Codex's `parser.rs` and `apply_patch.lark` to TypeScript
- Define types: `PatchHunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk`
- `UpdateFileHunk` contains `path`, optional `movePath`, and `chunks: UpdateFileChunk[]`
- `UpdateFileChunk` contains `changeContext: string | null`, `oldLines: string[]`, `newLines: string[]`, `isEndOfFile: boolean`
- Lenient mode: detect and strip `<<'EOF'...EOF` / `<<"EOF"...EOF` / `<<EOF...EOF` wrappers before parsing
- Validate `*** Begin Patch` / `*** End Patch` boundaries
- Reject empty update hunks (no chunks)
- Support `@@ ` context hints and bare `@@` (no hint)
- Support `*** End of File` marker setting `isEndOfFile: true`
- Support `*** Move to:` directive
- Multiple `@@` chunks per update file, applied in parse order

**Patterns to follow:**
- Codex `parser.rs` marker constants (`BEGIN_PATCH_MARKER`, `ADD_FILE_MARKER`, etc.)
- Codex `streaming_parser.rs` for chunk accumulation logic
- Existing Zod-first pattern: export a Zod schema for the parsed output if useful for validation

**Test scenarios:**
- Happy path: parse a multi-file patch with Add, Update (with chunks), and Delete operations → correct hunk array
- Happy path: parse Update with `*** Move to:` → `movePath` populated
- Happy path: parse Update with multiple `@@` chunks → chunks array in order
- Happy path: parse `@@ class Foo` context hint → `changeContext` populated
- Happy path: parse stacked `@@ class Foo` / `@@ def bar():` → last hint used as `changeContext`
- Happy path: parse `*** End of File` marker → `isEndOfFile: true`
- Happy path: parse Add File with `+` lines → contents joined with newlines
- Edge case: patch with no hunks (empty `*** Begin Patch\n*** End Patch`) → empty array
- Edge case: heredoc-wrapped patch (`<<'EOF'\n...\nEOF`) → stripped and parsed
- Edge case: heredoc with double quotes (`<<"EOF"`) → stripped and parsed
- Edge case: update hunk without explicit `@@` header (bare context/add lines) → parsed as single chunk
- Error path: missing `*** Begin Patch` → parse error with descriptive message
- Error path: missing `*** End Patch` → parse error
- Error path: empty update hunk (no chunks after `*** Update File:`) → parse error
- Error path: mismatched heredoc quotes (`<<"EOF'`) → parse error (not stripped)

**Verification:**
- All parser tests pass
- Parser handles every example from the Codex `apply_patch_tool_instructions.md`

---

- U2. **Context matching engine (seek_sequence)**

**Goal:** Implement the 4-tier progressive line-sequence matching algorithm. Pure function, no filesystem access.

**Requirements:** R8, R10

**Dependencies:** None

**Files:**
- Create: `src/main/tools/filesystem/apply-patch-match.ts`
- Test: `tests/unit/apply-patch-match.test.ts`

**Approach:**
- Port `seek_sequence` from Codex's `seek_sequence.rs`
- Function signature: `seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null`
- Four matching tiers tried in order:
  1. Exact: `lines[i..i+len] === pattern`
  2. Trim-end: `line.trimEnd() === pat.trimEnd()` per line
  3. Trim-both: `line.trim() === pat.trim()` per line
  4. Unicode normalize + trim: normalize typographic dashes (`\u{2010}`–`\u{2015}`, `\u{2212}` → `-`), curly quotes (`\u{2018}`–`\u{201B}` → `'`, `\u{201C}`–`\u{201F}` → `"`), exotic spaces (`\u{00A0}`, `\u{2002}`–`\u{200A}`, `\u{202F}`, `\u{205F}`, `\u{3000}` → ` `), then trim and compare
- When `eof` is true, start search from `lines.length - pattern.length` (anchor to end)
- Empty pattern → return `start` (no-op match)
- Pattern longer than lines → return `null`
- Also export `findContextHint(lines: string[], hint: string, start: number): number | null` using the same 4-tier matching for `@@` context hints

**Patterns to follow:**
- Codex `seek_sequence.rs` — exact port of the algorithm and Unicode normalization table

**Test scenarios:**
- Happy path: exact match finds sequence at correct index
- Happy path: trim-end match ignores trailing whitespace
- Happy path: trim-both match ignores leading and trailing whitespace
- Happy path: Unicode normalization matches ASCII dash against en-dash (`\u{2013}`)
- Happy path: Unicode normalization matches ASCII quotes against curly quotes
- Happy path: Unicode normalization matches ASCII space against non-breaking space
- Happy path: `eof=true` anchors match to end of file
- Edge case: empty pattern → returns `start`
- Edge case: pattern longer than lines → returns `null`
- Edge case: no match at any tier → returns `null`
- Edge case: match at tier 1 preferred over tier 2 (exact wins when both would match)
- Edge case: `start` offset skips earlier occurrences
- Covers AE1: trailing whitespace tolerance
- Covers AE2: Unicode dash tolerance
- Covers AE4: context hint narrows search position

**Verification:**
- All matching tests pass
- Matching behavior is identical to Codex's `seek_sequence` for the same inputs

---

- U3. **Patch application engine**

**Goal:** Apply parsed hunks to file content in memory, computing new content for update operations. Pure content transformation — no filesystem I/O.

**Requirements:** R6, R8, R9, R10

**Dependencies:** U1, U2

**Files:**
- Create: `src/main/tools/filesystem/apply-patch-apply.ts`
- Test: `tests/unit/apply-patch-apply.test.ts`

**Approach:**
- Port the content transformation logic from Codex's `lib.rs` (`derive_new_contents_from_chunks`, `compute_replacements`, `apply_replacements`)
- `applyChunksToContent(originalContent: string, chunks: UpdateFileChunk[], filePath: string): string`
  - Split content into lines, strip trailing empty element (matching Codex behavior)
  - For each chunk:
    - If `changeContext` present, use `findContextHint` to locate position, advance `lineIndex`
    - If `oldLines` empty (pure addition), insert at end (or before final empty line)
    - Otherwise, use `seekSequence` to find `oldLines` starting from `lineIndex`
    - Handle trailing empty line in pattern (retry without it, per Codex)
    - Record replacement: `(startIndex, oldLen, newLines)`
  - Apply replacements in reverse order (descending index) to preserve positions
  - Re-add trailing newline, join lines
- On match failure, throw/return error with the unmatched lines and file path (R9)
- Export a result type that distinguishes success (new content) from failure (error + unmatched lines)

**Patterns to follow:**
- Codex `lib.rs` `compute_replacements` and `apply_replacements` functions
- Codex trailing-empty-line retry logic

**Test scenarios:**
- Happy path: single chunk replacement → correct new content
- Happy path: multiple chunks in one file → all applied in order
- Happy path: pure addition (no old lines) → inserted at end
- Happy path: `*** End of File` chunk → inserted at file end
- Happy path: context hint narrows search → change applied in correct location
- Happy path: trailing empty line in pattern → retried without it, match succeeds
- Edge case: empty file with pure addition → content created
- Edge case: chunk replacing first line → correct
- Edge case: chunk replacing last line → correct
- Edge case: interleaved additions and deletions across non-adjacent regions
- Error path: old lines not found at any tier → error with unmatched lines and file path
- Error path: context hint not found → error with hint text and file path
- Covers AE3: per-file error includes unmatched lines
- Covers AE6: EOF marker anchors insertion

**Verification:**
- All application engine tests pass
- Content transformation produces identical results to Codex for the same inputs

---

- U4. **Tool definition, handler, result schema, and registration**

**Goal:** Wire the parser, matcher, and application engine into a registered tool with a Zod-validated input schema, result schema, and handler that performs filesystem operations.

**Requirements:** R11, R12, R13, R14, R15, R16, R17, R18, R19, R20

**Dependencies:** U3

**Files:**
- Create: `src/main/tools/filesystem/apply-patch.ts`
- Create: `src/shared/types/tool-result-apply-patch.ts`
- Modify: `src/main/tools/index.ts` (import + register)
- Modify: `tests/parity/tools.test.ts` (add to `EXPECTED_TOOL_NAMES`, bump counts 29→30, 18→19, add definition validation block)
- Modify: `tests/unit/filesystem-tool-results.test.ts` (add to family-metadata table)
- Test: `tests/unit/apply-patch.test.ts`

**Approach:**
- **Input schema**: `applyPatchInputSchema = z.object({ patch: z.string().describe('...') })`
- **Result schema** (`tool-result-apply-patch.ts`):
  - `applyPatchFileResultSchema`: `{ path, operation: 'create'|'update'|'delete', status: 'complete'|'error', fileChange?: FileChangeData, error?: { code, message } }`
  - `applyPatchResultDataSchema`: `{ files: ApplyPatchFileResult[], added: number, modified: number, deleted: number, failed: number }`
- **Tool definition**: `name: 'apply_patch'`, `resultFamily: 'generic'`, `outputDataSchema: applyPatchResultDataSchema`, `category: 'filesystem'`, custom `agentProjector` (see U5)
- **Handler flow**:
  1. Parse patch via `parsePatch(input.patch)` — return error outcome on parse failure
  2. For each hunk, resolve path via `resolveToolPath(ctx.cwd, hunk.path)`
  3. Containment check: reject if resolved path escapes `ctx.cwd` (R17)
  4. Reject absolute paths in the patch (format spec violation)
  5. For each hunk sequentially (R15):
     - **AddFile**: `mkdirSync(parent, { recursive: true })` → `atomicWrite(content)` → `chmod 0o644` for new files. Build `FileChangeData` with `operation: 'create'`
     - **DeleteFile**: verify exists and not directory → read content for delta → `unlinkSync`. Build result with `operation: 'delete'`
     - **UpdateFile**: read file → `applyChunksToContent` → `buildStructuredFileChange(old, new)` → `fileChangeDataSchema.parse(data)` at mutation boundary → `atomicWrite(newContent)`. If `movePath`: write to dest (auto-create parents), remove original
  6. Collect per-file results, compute summary counts
  7. Return `{ status: failed > 0 ? 'partial' : 'complete', data }`
- **Registration**: `registry.register(applyPatchDefinition, applyPatchHandler)` in `registerBuiltinToolsInto`, alongside other filesystem tools
- **Do NOT add to `RENDERER_ALLOWED_TOOLS`** — this is a mutating tool

**Patterns to follow:**
- `edit.ts` handler structure: read → validate → `buildStructuredFileChange` → schema-parse → `atomicWrite`
- `write.ts` for file creation: `mkdirSync` + `atomicWrite` + `chmod`
- `edit.ts` `errorOutcome` pattern for structured errors
- `file-tools.test.ts` for handler test setup (tmpDir, `toolCtx()`, direct invocation)

**Test scenarios:**
- Happy path: single-file update patch → file modified, result has `modified: 1`
- Happy path: multi-file patch (add + update + delete) → all applied, correct summary counts
- Happy path: rename via `*** Move to:` → new file exists, original removed
- Happy path: add file in nonexistent directory → parents created, file written with 0o644
- Edge case: patch with no hunks → error outcome ("no files were modified")
- Edge case: CRLF file content → handled correctly (CR stripped from line content)
- Covers AE5: rename produces correct result
- Covers AE7: heredoc-wrapped patch is parsed and applied
- Covers AE8: `../../etc/passwd` path rejected with traversal error
- Error path: update nonexistent file → per-file error, other files still applied
- Error path: delete nonexistent file → per-file error
- Error path: match failure in one file → that file errors, others succeed, status is `partial`
- Error path: absolute path in patch → rejected
- Error path: invalid patch syntax → error outcome with parse error message
- Integration: handler invoked via `executeToolCall` through registry → canonical result + agent projection produced
- Integration: `_setStructuredPatchForTests` seam → diff failure before mutation leaves file unchanged

**Verification:**
- All handler tests pass
- Parity tests updated and passing (tool count, definition validation)
- Tool appears in `toolRegistry.listAll()` and `toJsonSchema()`

---

- U5. **Agent projector and UI renderer**

**Goal:** Custom agent projector for multi-file LLM-facing XML output, and a renderer component for the chat UI.

**Requirements:** R19, R20

**Dependencies:** U4

**Files:**
- Create: `src/renderer/components/ToolResults/ApplyPatchToolResult.tsx`
- Modify: `src/renderer/components/ToolResults/registry.tsx` (`toolRenderers.set('apply_patch', ApplyPatchToolResult)`)
- Modify: `src/renderer/utils/tool-title.ts` (add `apply_patch` branch)
- Modify: `tests/unit/tool-result-rendering.test.ts` (add resolution + markup assertions)
- Modify: `tests/unit/tool-title.test.ts` (add apply_patch title test)
- Test: covered by modifications above

**Approach:**
- **Agent projector** (defined in `apply-patch.ts`, referenced by `definition.agentProjector`):
  - Parse `applyPatchResultDataSchema` from `canonical.data`
  - For each successful file with `fileChange`: reuse the `fileChangeAgentProjector` logic (reconstruct old/new strings from hunks, emit compact XML)
  - For each failed file: emit error XML with path, error code, and unmatched lines
  - Wrap in a single `<tool_result name="apply_patch" status="...">` envelope with per-file `<file>` sections
  - Summary line: `N files added, M modified, K deleted, J failed`
- **Renderer** (`ApplyPatchToolResult.tsx`):
  - Parse `applyPatchResultDataSchema` from `canonical.data`
  - Render a summary header (files added/modified/deleted/failed counts)
  - For each file with `fileChange`: render using the same diff display pattern as `FileChangeToolResult` (hunk headers, `+`/`-`/` ` lines with semantic color tokens)
  - For each failed file: render an error alert with the error message
  - Use `ui/` primitives (`Alert`, `StatusBadge`) — no direct DaisyUI class names (styling contract)
  - Use DaisyUI semantic color tokens (`bg-success/10`, `text-error-content`) — no raw colors
- **Tool title**: `if (tool === 'apply_patch')` branch using `withLifecycle(...)` for "Applying patch to N files"
- **Registry**: `toolRenderers.set('apply_patch', ApplyPatchToolResult)`

**Patterns to follow:**
- `FileChangeToolResult.tsx` for diff rendering (Hunk, DiffLine subcomponents, semantic tokens)
- `result.ts` `fileChangeAgentProjector` for XML projection logic
- `tool-title.ts` existing branches for title format

**Test scenarios:**
- Happy path: `resolveToolResultRenderer('apply_patch', 'generic')` returns `ApplyPatchToolResult`
- Happy path: render multi-file result → markup contains per-file diff sections
- Happy path: render result with failed file → markup contains error alert
- Happy path: agent projector emits per-file XML with old/new strings for successful files
- Happy path: agent projector emits error XML with unmatched lines for failed files
- Happy path: tool title returns "Applying patch to N files" format
- Edge case: render empty result (no files) → graceful handling

**Verification:**
- Renderer resolution test passes
- Markup assertions pass for multi-file and error cases
- Agent projector output is valid XML parseable by the LLM context
- Tool title test passes

---

## System-Wide Impact

- **Interaction graph:** `apply_patch` is invoked via the standard `executeToolCall` path in `tool-dispatch.ts`. No new IPC channels. Not added to `RENDERER_ALLOWED_TOOLS` (mutating tool).
- **Error propagation:** Per-file errors are collected in the result data, not thrown. The handler returns `partial` status when any file fails. Parse errors return `error` status immediately.
- **State lifecycle risks:** Each file write uses `atomicWrite` to prevent partial content. On multi-file partial failure, successfully written files remain on disk (by design — per-file independent semantics). The result data tracks which files were committed.
- **API surface parity:** No new IPC channels. The tool is exposed to the LLM via `toJsonSchema()` automatically. MCP exposure follows the standard tool registry path.
- **Integration coverage:** End-to-end test via `executeToolCall` with registry dispatch proves the canonical result + agent projection pipeline.
- **Unchanged invariants:** `edit`, `write`, and all other existing tools are unchanged. The `file-change` family schema is not modified. The `RENDERER_ALLOWED_TOOLS` allowlist is not modified.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Parser divergence from Codex format as models evolve | Port Codex grammar faithfully; lenient parsing handles known model quirks (heredocs). Parser is a pure module — easy to update independently. |
| Unicode normalization false positives (matching wrong location) | Normalization is the lowest-priority tier (tried last). Exact and whitespace matches always win. Normalization only fires when all stricter tiers fail. |
| Multi-file partial failure confuses the agent | Per-file error messages include unmatched lines and file path, giving the agent enough to re-read and retry just the failed file. |
| Large patches (many files, many chunks) hit tool timeout | Default 60s timeout is generous for filesystem operations. If needed, `noTimeout` can be set on the definition later. |
| Result schema compatibility with existing UI | Custom renderer handles the new schema. Existing `FileChangeToolResult` is not modified. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/apply-patch-tool-requirements.md](docs/brainstorms/apply-patch-tool-requirements.md)
- **Codex apply-patch crate:** `codex-rs/apply-patch/src/` (parser.rs, seek_sequence.rs, lib.rs)
- **OpenAI apply_patch docs:** https://developers.openai.com/api/docs/guides/tools-apply-patch
- **Canonical tool results plan:** `docs/plans/2026-07-18-002-feat-canonical-tool-results-plan.md`
- **Security audit:** `docs/code-review-reports/full-audit-2026-07-16/S4-tools-ast-rag-mcp.md` (P0 #1 path sandbox)
- Related code: `src/main/tools/filesystem/edit.ts`, `src/main/tools/filesystem/structured-diff.ts`
