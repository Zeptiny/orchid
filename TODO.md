# TODO

Internal backlog for Orchid. User-facing summary lives in the [README known limitations](README.md#known-limitations) section. Remove or archive items as they ship.

---

## Agent quality

- LLM can deviate from the intended architecture
  - `AGENT.md` and docs should constrain this
- LLM can produce dead code, incomplete implementations, or ignore the plan
  - Reviewers should catch this — investigate why they don't always
  - Subagents should make it easier to follow plans end-to-end
- Skills and agents are not fully updated for the current harness capabilities

## General backlog

- Remaining work from `docs/code-review-reports/2026-07-15-electron-simplification-review.md`
- Verify remote embedding models work correctly
- Concurrency control for file locking
- LSP integration
- SSH / remote connection support
- Session compaction / compression (summarize or drop older turns so long sessions stay within context limits)
- Investigate if its better to not create new chains with the queued messages
- Chain snapshoting
- Better retry / frozen agent handling / long ttft
- Goal mode

## Native semantic code graph / AST tool improvements

- Evolve the flat AST symbol index into a versioned semantic graph
  - Store files, definition nodes, exact definition/reference occurrences, typed edges, unresolved references, and index metadata
  - Add stable qualified symbol IDs that do not depend on line numbers
  - Add edge kinds for `contains`, `calls`, `imports`, `exports`, `references`, `extends`, `implements`, `instantiates`, `overrides`, `decorates`, `returns`, and `type_of`
  - Record call-site line/column plus provenance/confidence so syntax-derived and heuristic edges can be distinguished
  - Add FTS5 search over symbol names, qualified names, signatures, and docstrings
  - Track schema and extractor versions; rebuild incompatible derived indexes instead of maintaining complex data migrations
- Replace flat name capture with richer language adapters for Orchid's existing Python, JavaScript, JSX, TypeScript, and TSX support
  - Extract definitions, scopes, qualified names, signatures, imports/exports, calls, member access, inheritance, type relationships, decorators, and JSX component usage
  - Associate each reference/call with its enclosing executable symbol so edges represent actual call flow
  - Keep exact occurrence ranges compatible with `find_symbol_references`, `rename_symbol`, and `replace_symbol`
  - Add languages only after the initial five have accuracy fixtures and acceptable indexing performance
- Add conservative cross-file resolution
  - Resolve lexical definitions, import aliases, module paths, re-exports, constructors, qualified members when the receiver is known, and inheritance/interface relationships
  - Preserve ambiguous references as unresolved instead of guessing
  - Retry unresolved references in unchanged files when changed files introduce matching symbols
  - Remove or re-resolve incoming edges when a target file or symbol is deleted or renamed
- Add isolated Orchid-specific relationship synthesizers with explicit heuristic provenance
  - React/JSX component rendering and event-handler wiring
  - Electron preload/renderer calls to matching main-process IPC handlers by channel
  - XState actions, guards, actors, and state-machine references
  - Tool definitions and other registry entries to their registered handlers
- Add project-scoped traversal and context services
  - Cycle-safe callers, callees, bidirectional call-flow, type-hierarchy, file-dependency, and reverse-impact traversal
  - Configurable depth and node/file caps with deterministic ordering and duplicate suppression
  - Return dependency paths, direct/transitive classification, edge locations, and provenance instead of flat symbol lists
  - Read source from the current on-disk file after path-scope validation; never treat indexed source positions as proof that cached content is current
- Add `explore_code` as the primary graph-backed code-understanding tool
  - Accept natural-language questions, symbol names, file names, or mixed queries
  - Seed retrieval from exact/qualified-name lookup and FTS; use the existing Orchid RAG index as an optional fallback/augmentation for prose queries
  - Map RAG file/line hits to enclosing graph nodes, expand through weighted graph relationships, and rank bridge symbols and co-located files
  - Group selected source ranges by file, merge overlaps, add current line-numbered source, and include a compact relationship/impact summary
  - Keep the agent-facing payload below the tool offload threshold and state omissions/truncation explicitly
- Add `get_symbol` for targeted symbol inspection
  - Resolve symbols project-wide with optional file/line/kind disambiguation
  - Return every plausible definition when a name is ambiguous rather than silently choosing one
  - Optionally include signature, current source or container outline, direct callers/callees, and edge provenance
  - Preserve `get_function` for compatibility, but make `get_symbol` the general function/class/interface/component lookup tool
- Add `trace_calls` for explicit call-flow queries
  - Support `callers`, `callees`, and `both` directions with bounded depth
  - Include call sites and one path from the requested symbol to every returned node
  - Distinguish direct calls, generic references, construction, and synthesized callback/framework hops
- Add `analyze_change_impact` for pre-edit blast-radius analysis
  - Traverse callers, importers, instantiation sites, subclasses/implementers, overrides, decorators, component consumers, and synthesized registrations in the reverse dependency direction
  - Group direct and transitive impact by file and edge type, with paths explaining why each result is included
  - Cap high-fan-out generic-reference/import expansion and report when results are partial
- Improve existing AST tools around the graph
  - `find_symbol_references`: return definition/reference classification, resolved target where known, ambiguity details, and current source locations
  - `get_function`: reuse graph resolution and current-source validation while keeping its existing compatibility contract
  - `get_file_skeleton`: use graph nodes/signatures and optionally summarize dependents/dependencies without dumping source
  - `rename_symbol`: use resolved occurrences to reduce same-name false positives, present ambiguity/impact before mutation, and keep conservative fallback behavior
  - `replace_symbol`: invalidate and synchronously enqueue the changed file for graph refresh after a successful write
  - `ast_index`: add `sync` alongside `status`, `index`, and `clear`; report nodes, occurrences, edges, unresolved counts, extraction version, pending files, and freshness/watcher health
- Add automatic graph freshness and lifecycle management
  - Maintain one leased index service/worker per project runtime with single-flight indexing and safe shutdown
  - Notify it immediately after Orchid `write`, `edit`, `apply_patch`, `rename_symbol`, and `replace_symbol` mutations
  - Add a debounced filesystem watcher for external editor changes and command-driven writes that bypass Orchid file tools
  - Incrementally extract changed files, delete removed-file data, rerun affected resolution, and batch bursts of edits
  - Before graph queries, cheaply reconcile pending Orchid-originated writes or return an explicit stale/partial warning while sync is still running
  - Surface degraded watcher state rather than silently serving a frozen index
- Integrate the new tools with Orchid's agent and output contracts
  - Register them as built-in read-only tools with exact names and Zod schemas; do not route them through MCP
  - Add compact tool-specific XML renderers using the exact registered name in the `<tool_result>` envelope
  - Add generating/running/completed UI states and dedicated widgets or compact summaries
  - Add the tools to the appropriate general, explorer, implementer, architecture, reviewer, testing, reliability, security, and other relevant agent allowlists
  - Update agent instructions so `explore_code` is the first choice for architecture/flow questions, while `grep`, `read`, `rag_search`, and exact AST tools remain explicit fallbacks
  - Extend the Index sidebar and AST IPC/shared status types with graph counts, resolving/linking progress, pending files, and freshness state
- Add correctness, performance, and integration coverage
  - Fixture tests for nested scopes, duplicate names, overloads, aliased imports, re-exports, calls, member calls, constructors, inheritance, JSX, IPC, XState, ambiguous references, and parse failures
  - Incremental tests for modify/add/delete/rename, stale-edge removal, unresolved-reference retry, watcher batching/degradation, and concurrent query/index behavior
  - Traversal tests for cycles, duplicate edges, depth/node caps, deterministic ordering, provenance, and direct/transitive paths
  - Tool-contract tests for schemas, exact result names, XML escaping, path containment, current-source line accuracy, output budgets, cancellation, and missing/uninitialized indexes
  - Project-runtime tests proving concurrent sessions query only their frozen workspace and that retired index services remain alive until active turn leases finish
  - Retrieval evaluation comparing `explore_code` against `grep`/`read`/`rag_search` on architecture, call-flow, bug-localization, and refactor-impact tasks; measure relevance, missing/wrong edges, tool calls, tokens, latency, database size, and indexing time
- Explicit non-goals for the initial implementation
  - No separate file-tree or generic file-read tools; reuse `read_directory`, `glob`, `read`, and `get_file_skeleton`
  - No duplicate semantic embedding system; optionally consume Orchid's existing RAG results
  - No broad framework-heuristic or language expansion until the core graph's precision, freshness, and evaluation gates pass

## Compound system improvements

- **Do not change this until the design is clearer**
- Multiple primary agent types (general, plan, etc.) that can be switched mid-conversation

## Subagents

- Side / "BTW" agent (ask a question without interrupting the main flow)
  - Best UI placement still TBD
  - Read-only tools only
  - Multi-turn? Still under consideration
  - Useful for clarifications without stopping work
    - e.g. "How does function X interact with system Y?"
- A tool to view what the agent is currently doing / working
  - May be summarized?
  - Maybe only its TODOs are enough?
