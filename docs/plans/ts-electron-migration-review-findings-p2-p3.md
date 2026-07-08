# TS/Electron Migration — Review Findings (P2/P3)

Deferred findings from the code review of the TypeScript/Electron desktop app migration. These are lower severity issues to address in follow-up iterations.

Generated: 2026-07-08

---

## Correctness (P2)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | Retry middleware `contentDelivered` flag resets per retry iteration — duplicate content can be streamed | `llm/middleware/retry.ts:83` | Move `contentDelivered` flag outside the `while` loop so it persists across retries |
| 2 | `grep` tool mutates global `String.prototype` with `rstrip()` | `tools/search/grep.ts:190` | Replace with standalone `rstrip(s)` helper function |
| 3 | `stepIndex` hardcoded to `0` for all steps — multi-step tool loops are indistinguishable | `llm/orchestrator.ts:262` | Track step counter outside the loop, increment in `step-finish` case |
| 4 | `withTimeout` doesn't cancel the underlying promise — timed-out tools leak | `llm/tool-dispatch.ts:238` | Pass `AbortSignal` to tool handler; document that timed-out tools continue in background |

## Correctness (P3)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | Tool results use `'unknown'` as `toolName` | `llm/orchestrator.ts:151` | Build `toolCallId → toolName` map from assistant messages' `tool_calls` arrays |
| 2 | `BackgroundProcessStore` entry variable referenced in closures before assignment | `tools/process/background-store.ts:119` | Declare `entry` with `let` and assign immediately; restructure callbacks |

## Security (P2)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | MCP servers execute arbitrary external processes with no sandboxing | `mcp/transport.ts:40` | Add confirmation prompt for new MCP servers, manifest of approved commands, process audit logging |
| 2 | Keychain falls back to plaintext on Linux without libsecret | `config/keychain.ts:196` | Surface persistent UI warning (not just console.warn) when encryption unavailable |
| 3 | Config provider `base_url` is not validated — can be set to attacker-controlled server | `ipc/config.ts:86` | Validate against private IP blocklist; warn on non-HTTPS endpoints |

## Security (P3)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | Redaction utility uses best-effort regex — may miss non-standard secret formats | `config/keychain.ts:349` | Consider comprehensive secret detection library (secretlint, detect-secrets patterns) |
| 2 | `web_fetch` cache file path is leaked in response content | `tools/web/fetch.ts:489` | Return relative or opaque reference instead of absolute path |
| 3 | Error messages from filesystem tools leak internal file paths | `tools/filesystem/write.ts:121` | Sanitize error messages with `path.relative()` or truncate prefix |

## Performance (P2)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | `upsertFileBatch`/`deleteByFileBatch` use `Array.splice()` in descending-index order — O(M*N) for M deletions from N-element array | `rag/store.ts:502` | Build new arrays by filtering/collecting surviving elements in single pass O(N) |
| 2 | `discoverFiles()` uses recursive `walkDir()` with spread — O(depth) intermediate arrays | `rag/indexer.ts:328` | Use iterative stack-based walk; accumulate into single array |
| 3 | ONNX tensor creation does `flat().map(BigInt)` — creates 102K intermediate objects per batch | `rag/embedder.ts:376` | Build `BigInt64Array` directly in tokenization loop, avoid intermediaries |
| 4 | `searchFileSync` reads entire file into memory even if max_results found on first lines | `tools/search/grep.ts:159` | Use streaming readline interface; consider `worker_threads` for CPU concurrency |
| 5 | `pruneIfNeeded()` sorts ALL entries by `createdAt` on every `spawn()` call | `tools/process/background-store.ts:360` | Track oldest entry separately; only sort when eviction needed; use linear scan |
| 6 | `ASTStore.getConn()` opens new connection on every call (same as RAG store pre-fix) | `ast/store.ts:148` | Cache connection on instance (same pattern as RAG store fix) — **note: may already be fixed** |
| 7 | `cosineSimilarity()` recomputes per-vector norm from scratch — vectors already L2-normalized | `rag/store.ts:873` | Skip `vNorm` computation; just compute dot product / `qNorm` |
| 8 | `isBinary()` opens and reads first 8KB of every file even when `include_pattern` constrains to text extensions | `tools/search/grep.ts:92` | Skip binary detection when `include_pattern` is set to known text extension |

## Performance (P3)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | `loadNpy()` converts Float32Array buffer to `number[][]` — triples memory usage | `rag/store.ts:162` | Return `Float32Array[]` directly from buffer data |
| 2 | `updateFile()` creates new Embedder instance on every call — re-warms up per instance | `rag/indexer.ts:257` | Cache singleton Embedder instance at module level |
| 3 | `append()` calls `Buffer.concat` on every append when head is locked | `tools/process/head-tail-buffer.ts:27` | Use list of Buffer chunks, concat only when `getTail()` called |
| 4 | `_searchCache` holds ALL vectors in memory indefinitely with no eviction | `rag/store.ts` | Add eviction policy or memory pressure monitoring |

## Maintainability (P2)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | `outputSchema` in `ToolDefinition` is never read, written, or referenced — dead field | `tools/types.ts:28` | Remove until there's a concrete consumer |
| 2 | `ToolHandler` typed as `(input: unknown) => Promise<unknown>` — discards type info from `inputSchema` | `tools/types.ts:41` | Add generic `ToolHandler<TInput, TOutput>` or infer from schema |
| 3 | `zodToJsonSchema(definition.inputSchema as any)` — `as any` bypasses type checking | `tools/registry.ts:84` | Fix type constraint; narrow `inputSchema` to `z.ZodObject<any>` |
| 4 | Message construction copy-pasted 3 times with identical boilerplate | `renderer/hooks/useChat.ts` | Extract `createMessage(partial)` factory function |
| 5 | `export type { StreamEvent }` re-export from events.ts — no file imports from there | `agents/xstate/events.ts:146` | Remove dead re-export |
| 6 | `ALLOWED_INVOKE_CHANNELS` and `ALLOWED_EVENT_CHANNELS` typed as `string[]` not `IPCChannel[]` | `shared/types/ipc.ts:245` | Change to `readonly IPCChannel[]` for compile-time validation |
| 7 | `notify` function logs to console — stub placeholder | `renderer/components/ChatView.tsx:163` | Implement real toast notification system or remove |
| 8 | `commandContext` object reconstructed on every render — causes unnecessary re-renders | `renderer/components/ChatView.tsx:173` | Wrap in `useMemo` with appropriate dependencies |

## Maintainability (P3)

| # | Finding | File | Suggested Fix |
|---|---------|------|---------------|
| 1 | `UpdaterState` both re-exported and imported on adjacent lines — redundant | `shared/types/ipc.ts:19` | Use single `export type { ... } from '...'` |
| 2 | `session.rename` takes positional args but IPC uses object — inconsistent | `shared/types/ipc.ts:147` | Align API surface with IPC message type |
| 3 | `setMCPManagerRef` is mutable singleton setter — hidden coupling | `main/ipc/index.ts:48` | Pass `MCPManager` as parameter to `registerMCPIPC()` |

## Testing Gaps (P2)

| # | Gap | Suggested Test |
|---|-----|----------------|
| 1 | RAG store mock doesn't enforce SQL constraints | Use `better-sqlite3` `:memory:` for integration tests |
| 2 | Indexer tests don't verify deleted files removed from index | Test: index → delete file → re-index → chunks removed |
| 3 | Spike E2E tests silently skip without LLM env vars | Add mock-based E2E that always runs |
| 4 | Dynamic tool builders tested with `{} as any` dependencies | Provide minimal mock dependencies |
| 5 | Interrupt flow test doesn't verify AbortSignal propagation | Capture abortSignal, assert `aborted === true` after CANCEL |
| 6 | ConfigManager.save() not tested for persistence round-trip | Test: load → save → load → modifications persisted |
| 7 | Binary detection doesn't test boundary cases | Test: null byte at position 8000, empty file, valid UTF-8 |

## Testing Gaps (P3)

| # | Gap | Suggested Test |
|---|-----|----------------|
| 1 | Timeout test uses 5-second delay — sensitive to CI load | Use `new Promise(() => {})` (never resolves) |
| 2 | Read_output exemption test relies on implicit tool name | Verify tool name is in `TOOLS_WITHOUT_TIMEOUT` set |
| 3 | MCP `callTool` on failed server doesn't verify return vs throw | Assert `resolves.toBeDefined()` not rejects |

---

## Residual Risks

These are known limitations documented in the codebase:

1. **Session files and tool-output cache** store sensitive data as plaintext, protected only by filesystem permissions. Documented in `keychain.ts` threat model.
2. **MCP tool output** is not validated or sanitized before being returned to LLM context — prompt injection risk from malicious MCP servers.
3. **Grep tool regex** compiled directly via `new RegExp(pattern)` — ReDoS risk mitigated by per-file timeout.
4. **LCS-based diff** in edit.ts can produce suboptimal diffs when content has many duplicate lines.
5. **Provider quirks middleware** uses `as unknown as Awaited<...>` cast — type mismatch risk if AI SDK changes `doStream` result shape.
