---
date: 2026-06-16
topic: mcp-client
---

# MCP Client Integration

## Summary

Add a full MCP (Model Context Protocol) client to stupidex using the official `mcp` Python SDK. Users configure MCP servers in their config files; on app launch, stupidex connects to each server, discovers its tools and resources, and exposes them to agents through the existing unified tool registry. Agents use MCP tools via normal `allowed_tools` glob patterns, and MCP resources via a dedicated `read_mcp_resource` tool.

---

## Problem Frame

Stupidex is a coding CLI with 19 built-in tools, but it cannot connect to external tool ecosystems. Users who want to interact with GitHub, Linear, databases, or other services have no extension point — every integration must be hardcoded. MCP is the emerging standard for LLM-tool interop, supported by Claude Code, Cursor, and other coding tools. Without MCP support, stupidex is locked out of this ecosystem. The academic project also requires at least 1 MCP tool and 1 MCP resource implemented.

---

## Actors

- A1. **End user**: Configures MCP servers in config files, launches stupidex, expects tools to "just work" in agent conversations
- A2. **Agent (general/subagent)**: Calls MCP tools and reads MCP resources through the same interface as native tools
- A3. **MCP Server**: External process (stdio) or remote service (HTTP/SSE) that provides tools and resources

---

## Key Flows

- F1. **App startup — MCP server initialization**
 - **Trigger:** User launches `stupidex`
 - **Actors:** A1, A3
 - **Steps:** Load config → read `mcp_servers` section → for each server, start process (stdio) or connect (HTTP/SSE) → call `list_tools()` and `list_resources()` → build URI-to-server map → store MCP tool definitions for merge-at-access → log summary
 - **Outcome:** All configured MCP servers are running, their tools appear in the tool registry alongside native tools
 - **Covered by:** R1, R2, R3, R4

- F2. **Agent calls an MCP tool**
 - **Trigger:** LLM generates a tool call for `mcp_github_create_issue`
 - **Actors:** A2, A3
 - **Steps:** Tool registry resolves name → executor forwards call to MCP server via `session.call_tool()` → result returned as `ExecutorResult`
 - **Outcome:** Agent receives the MCP tool's response in the same format as native tool results
 - **Covered by:** R5, R6, R7

- F3. **Agent reads an MCP resource**
 - **Trigger:** LLM calls `read_mcp_resource` with a URI
 - **Actors:** A2, A3
 - **Steps:** Tool resolves MCP server from URI-to-server map (built at startup from `list_resources()`) → calls `session.read_resource(uri)` → returns content as `ExecutorResult`
 - **Outcome:** Agent receives resource content (file, DB schema, etc.)
 - **Covered by:** R8

- F4. **Server failure handling**
 - **Trigger:** An MCP server crashes or fails to start
 - **Actors:** A3
 - **Steps:** Catch exception during startup or tool execution → log warning → for startup failure, skip that server's tools → for runtime failure, return error as tool result
 - **Outcome:** App continues running without the failed server; other servers and native tools unaffected
 - **Covered by:** R9, R10

---

## Requirements

**Server configuration**
- R1. Users configure MCP servers under an `mcp_servers` key in `~/.stupidex/config.json` and `.stupidex.json`. Each entry has a name, command+args (stdio) or url (HTTP/SSE), and optional env vars. The `mcp_servers` key must be added to the `Config` dataclass so the existing merge loop picks it up.
- R2. Project-level config (`mcp_servers` in `.stupidex.json`) merges with home config, with project entries overriding same-name home entries.

**Server lifecycle**
- R3. On app launch, all configured MCP servers are started. stdio servers run as subprocesses; HTTP/SSE servers are connected to.
- R4. On app exit (normal or interrupt), all MCP server subprocesses are terminated gracefully. Override `App.on_exit()` in Stupidex to close all MCP sessions, and register an `atexit` handler as fallback. Shutdown sequence: SIGTERM → wait 5 seconds → SIGKILL if still alive.

**Tool integration**
- R5. Each MCP tool is registered in `_TOOL_REGISTRY` with the naming pattern `mcp_<server_name>_<tool_name>`. Server names must match `[a-z0-9-]+` (no underscores) to prevent ambiguity. A reverse-lookup map (tool name → server session) is maintained for routing. The `Tool` domain object is constructed from the MCP tool schema (name, description, JSON Schema parameters). MCP tools are merged into the registry at access time in `stream_response` (not at static registry build time) since MCP initialization is async.
- R6. Agents access MCP tools through normal `allowed_tools` glob patterns (e.g., `["mcp_github_*"]`, `["mcp_*"]`).
- R7. When an agent calls an MCP tool, the executor forwards the call to the correct MCP server's `session.call_tool()` and returns the result as an `ExecutorResult`.

**Resource access**
- R8. A `read_mcp_resource` meta-tool is registered in the tool registry. It accepts a `uri` parameter, resolves the correct MCP server via a URI-to-server map built from each server's `list_resources()` at startup, calls `session.read_resource(uri)`, and returns the content.

**Error handling**
- R9. If an MCP server fails to start during app launch, log a warning and skip that server. The app continues with remaining servers and native tools.
- R10. If an MCP tool call fails at runtime, return the error as the tool result content (same pattern as native tool errors). Do not crash the app.

**Transports**
- R11. Support stdio transport: server runs as a subprocess, communication over stdin/stdout.
- R12. Support HTTP/SSE transport: connects to a remote MCP server URL.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R5.** Given config has `mcp_servers: { filesystem: { command: "mcp-server-filesystem", args: ["/home/user"] } }`, when stupidex launches, then `mcp_filesystem_read_file`, `mcp_filesystem_write_file`, etc. appear in the tool registry.
- AE2. **Covers R6.** Given an agent's `allowed_tools` includes `["mcp_filesystem_*"]`, when the LLM calls `mcp_filesystem_read_file`, then the call succeeds. If `allowed_tools` does not include the pattern, the tool is not available to that agent.
- AE3. **Covers R8.** Given an MCP server exposes a resource at `file:///home/user/project/README.md`, when the agent calls `read_mcp_resource(uri="file:///home/user/project/README.md")`, then the file content is returned.
- AE4. **Covers R9.** Given config has a server with an invalid command, when stupidex launches, then a warning is logged and the app starts normally with remaining tools.
- AE5. **Covers R10.** Given an MCP tool call fails because the server is unresponsive, when the agent calls the tool, then an error message is returned as the tool result and the app continues running.

---

## Success Criteria

- Users can add an MCP server to their config and have its tools available to agents without code changes
- MCP tools are indistinguishable from native tools in the agent's experience (same call pattern, same result format)
- The app handles MCP server failures gracefully without crashing
- At least one bundled example MCP server demonstrates tool + resource usage for the academic requirement

---

## Scope Boundaries

- MCP "Prompts" feature (server-defined prompt templates) — not needed for v1
- MCP "Sampling" feature (server-initiated LLM calls) — complex, out of scope
- Dynamic server hot-reloading without app restart
- Exposing stupidex's own tools as an MCP server (client only)
- MCP authentication/OAuth flows for remote servers

---

## Key Decisions

- **Unified registry over separate layer:** MCP tools merge into `_TOOL_REGISTRY` so agents use the same `allowed_tools` mechanism. No new agent config fields needed.
- **Namespaced naming:** `mcp_<server>_<tool>` prevents collisions with native tools and makes the source server obvious in tool calls.
- **Start on launch over lazy start:** Servers start immediately so tool availability is known before the first conversation. Simpler mental model for users.
- **Config in existing files:** No separate `.mcp.json` file — consistent with the existing config pattern and avoids config fragmentation.

---

## Dependencies / Assumptions

- `mcp` Python SDK must be added to `pyproject.toml` dependencies (minimum version supporting `stdio_client`, `session.call_tool`, `session.read_resource`, and HTTP/SSE transport)
- MCP servers configured by the user must be installed on the system (stupidex does not auto-install them)
- The `mcp` SDK's async API is compatible with stupidex's asyncio event loop (expected — both use asyncio)

---

## Outstanding Questions

### Deferred to Planning

- Affects R5. [Needs research] Exact mapping from MCP tool JSON Schema to `ToolParameter` / `ToolParameterProperties` — verify the `mcp` SDK returns schemas in a format compatible with the existing domain model.
- Affects R8. [Needs research] How MCP resource content is returned (text vs binary) and how to handle binary resources in `ExecutorResult`.
- Affects R3. [Technical] Whether `mcp` SDK's `stdio_client` context manager can be managed as a long-lived session within stupidex's app lifecycle, or if a wrapper is needed.
