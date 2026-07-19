---
date: 2026-07-19
topic: apply-patch-tool
---

# apply_patch Tool

## Summary

A new `apply_patch` tool that accepts the OpenAI/Codex `*** Begin Patch` format, supporting multi-file create, update, delete, and rename operations in a single tool call with 4-tier progressive context matching and per-file error reporting. It complements the existing `edit` and `write` tools, giving agents a standard, token-efficient way to batch file changes.

---

## Problem Frame

Orchid's current file-editing surface is split across two tools: `edit` (exact string replacement, single file, single or replace-all) and `write` (full file creation or replacement). Agents performing multi-file refactors, renames, or coordinated edits must issue one `edit` call per file per change, each requiring an exact string match. This creates three compounding costs:

1. **Token overhead.** Each `edit` call sends the full `old_string` and `new_string` as tool arguments. A 10-file rename produces 10 round-trips, each carrying redundant context. Diff-style patches express the same changes in a fraction of the tokens.

2. **Fragile matching.** `edit` requires byte-exact string matches. When an LLM's remembered file content drifts from reality (stale indentation, trailing whitespace, Unicode punctuation), the edit fails and the agent must re-read the file and retry. There is no tolerance for minor discrepancies.

3. **No multi-file atomicity of intent.** While true all-or-nothing atomicity is undesirable (one bad hunk shouldn't block everything), there is no way for an agent to express "these 5 files change together" in a single tool call. Each file is a separate decision point where the agent can lose track of the overall refactor.

Models are increasingly trained on the OpenAI apply_patch format. By accepting this format directly, Orchid lets models use a patch language they already know, reducing hallucinated tool syntax and improving first-attempt success rates.

---

## Requirements

**Patch format and parsing**

- R1. The tool accepts a single `patch` string argument containing the full `*** Begin Patch` ... `*** End Patch` envelope as defined by the OpenAI/Codex apply_patch format.
- R2. The parser supports all three file operation headers: `*** Add File: <path>`, `*** Update File: <path>`, and `*** Delete File: <path>`.
- R3. The parser supports the `*** Move to: <new path>` directive within update hunks for file rename/move operations.
- R4. The parser supports `@@` context hint lines (e.g., `@@ class Foo`, `@@ def bar():`) that narrow the search position before matching change lines. Multiple stacked `@@` lines are supported for disambiguation.
- R5. The parser supports the `*** End of File` marker to anchor a chunk to the end of the file.
- R6. A single `*** Update File:` operation may contain multiple `@@` chunks, each targeting a different region of the file. Chunks are applied in order.
- R7. The parser operates in lenient mode: it strips heredoc wrappers (`<<'EOF'...EOF`, `<<"EOF"...EOF`) that some models produce around the patch text.

**Context matching**

- R8. When applying an update chunk, the tool locates the old lines in the target file using a 4-tier progressive matching strategy, tried in order:
  1. Exact line match
  2. Match ignoring trailing whitespace (trim-end per line)
  3. Match ignoring leading and trailing whitespace (trim both sides per line)
  4. Match after Unicode punctuation normalization (typographic dashes to ASCII `-`, curly quotes to ASCII `"`/`'`, non-breaking and exotic spaces to ASCII space) combined with trim
- R9. If no tier finds a match, the tool returns a per-file error that includes the unmatched lines and the file path, giving the agent actionable recovery information.
- R10. When a `@@` context hint is present, the tool first locates the hint line in the file (using the same 4-tier matching), then searches for the old lines only after that position.

**File operations**

- R11. `*** Add File:` creates a new file with the content specified by `+` lines. Parent directories are created automatically if they do not exist.
- R12. `*** Update File:` reads the existing file, applies all chunks to compute new content, and writes the result. The file must exist; updating a nonexistent file is a per-file error.
- R13. `*** Delete File:` removes the specified file. Deleting a nonexistent file is a per-file error.
- R14. `*** Move to:` within an update hunk writes the updated content to the new path, then removes the original file. If the destination already exists, it is overwritten.

**Application semantics**

- R15. Files are applied independently and sequentially in the order they appear in the patch. A failure in one file does not prevent subsequent files from being applied.
- R16. The tool result reports per-file status (success or failure) with descriptive messages. On partial failure, the result includes which files were successfully committed and which failed.
- R17. All file paths are resolved against the turn's frozen working directory. Relative paths in the patch are joined to this cwd. The tool rejects paths that traverse outside the project directory.
- R18. File mutations use atomic writes to prevent partial content on failure.

**Result format**

- R19. The tool result reuses the existing `file-change` result family for per-file change data (hunks, added/removed line counts, resulting content), enabling existing UI widgets to render each file's diff.
- R20. The aggregate result includes a summary of all files touched (added, modified, deleted) with per-file status, following the existing tool output envelope contract.

---

## Acceptance Examples

- AE1. **Covers R8, R9.** Given a file where a line has trailing spaces (`"foo   "`) and the patch's old line is `"foo"` (no trailing spaces), when the patch is applied, the match succeeds at tier 2 (trim-end) and the file is updated.
- AE2. **Covers R8.** Given a file containing a typographic en-dash (`\u{2013}`) in a comment and the patch uses an ASCII hyphen (`-`), when the patch is applied, the match succeeds at tier 4 (Unicode normalization) and the file is updated.
- AE3. **Covers R9, R15, R16.** Given a 3-file patch where file 2's old lines don't match any content, when the patch is applied, files 1 and 3 are updated successfully and the result reports file 2 as failed with the unmatched lines included in the error message.
- AE4. **Covers R4, R10.** Given a file with two identically-named local variables in different functions, and a patch with `@@ def target_func():` before the change lines, when the patch is applied, the change is made in the correct function because the context hint narrows the search.
- AE5. **Covers R3, R14.** Given a patch with `*** Update File: src/old.ts` followed by `*** Move to: src/new.ts`, when the patch is applied, `src/new.ts` contains the updated content and `src/old.ts` is removed.
- AE6. **Covers R5.** Given a patch chunk ending with `*** End of File` and pure `+` lines, when applied, the new lines are inserted at the end of the target file.
- AE7. **Covers R7.** Given a patch wrapped in `<<'EOF'\n*** Begin Patch\n...\n*** End Patch\nEOF`, when the tool receives this string, the heredoc wrapper is stripped and the inner patch is parsed and applied normally.
- AE8. **Covers R17.** Given a patch containing `*** Update File: ../../etc/passwd`, when the tool resolves the path against the project cwd, the operation is rejected with a path-traversal error.

---

## Success Criteria

- Agents can perform multi-file refactors (renames, API migrations, coordinated edits) in a single tool call with fewer tokens than equivalent `edit` calls.
- First-attempt patch application succeeds on files with minor whitespace or Unicode discrepancies that would cause `edit` to fail.
- Per-file error messages are specific enough that an agent can re-read the failed file and produce a corrected patch without additional guidance.
- The tool integrates with Orchid's existing result family and UI widget infrastructure so that per-file diffs render in the chat stream without new UI work.
- The patch format matches what models are already trained on, minimizing hallucinated syntax and format errors.

---

## Scope Boundaries

- Unified diff format is not supported; only the `*** Begin Patch` envelope format.
- All-or-nothing multi-file atomicity is not implemented; files are applied independently.
- The existing `edit` and `write` tools are not deprecated or removed; they remain available alongside `apply_patch`.
- No custom renderer UI for multi-file patches; existing file-change widgets handle per-file rendering.
- Streaming/incremental patch parsing (as in Codex's `StreamingPatchParser`) is not needed for tool-call semantics.
- No approval/permission UI specific to apply_patch; existing tool execution guards apply.

---

## Key Decisions

- **OpenAI apply_patch format over unified diff**: Models are increasingly trained on the `*** Begin Patch` format. It is multi-file by design, uses context-based matching (no line numbers to get wrong), and supports file creation and deletion natively. Unified diff is line-number-sensitive and single-file per block.
- **Per-file independent application over all-or-nothing**: Matches Codex behavior. One bad hunk should not block an otherwise-valid multi-file patch. The agent gets specific per-file feedback and can retry just the failed file.
- **4-tier progressive matching**: Exact match is preferred for predictability, but whitespace and Unicode tolerance dramatically improves first-attempt success on LLM-generated patches. The tiers are ordered from most to least strict, so the most precise match always wins.
- **Single `patch` string input over structured operations array**: Models generate the patch as a single text block. A string input matches how the format is produced in practice and avoids requiring the model to construct a JSON array of operations.
- **Complement, not replace**: `edit` remains better for quick single-string replacements. `apply_patch` targets multi-hunk and multi-file scenarios. Both stay in the toolset; usage data will inform whether `apply_patch` eventually subsumes `edit`/`write`.

---

## Dependencies / Assumptions

- The `diff` npm package (already a dependency) is available for computing structured file changes from old/new content.
- The existing `file-change` result family and `FileChangeData` schema can represent per-file changes from apply_patch without schema modifications.
- The existing `atomicWrite` utility handles safe file mutation.
- The Codex `apply-patch` crate (parser, seek_sequence, application logic) serves as the primary reference implementation for porting to TypeScript.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R19][Technical] Whether `FileChangeData` needs new optional fields (e.g., `movePath` for renames, per-file `status` for partial failures) or whether a new aggregate result family is cleaner for multi-file results.
- [Affects R8][Needs research] Whether the Unicode normalization table from Codex's `seek_sequence` should be extended or trimmed for Orchid's use cases.
- [Affects R17][Technical] How path-traversal rejection interacts with absolute paths in patches — Codex accepts both relative and absolute paths; Orchid's security model may require stricter constraints.
- [Affects R6][Technical] How multiple chunks within a single file interact with the structured-diff computation — whether to compute one aggregate diff or per-chunk diffs for the result.
- [Affects R20][Technical] How the tool output envelope should frame multi-file results — one envelope with an array of per-file changes, or a new aggregate family.
