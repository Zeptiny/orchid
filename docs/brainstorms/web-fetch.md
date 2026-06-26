# Web Fetch Tool

## Problem

The agent currently has no native way to fetch and extract information from web pages. When it needs web content, it shells out to `curl` via `execute_command`, which returns raw HTML — noisy, unstructured, and hard for the agent to reason about. The existing `web-researcher` agent literally states "Web fetching is not available in this environment."

## Solution

A new `web_fetch` tool that takes a URL and a description of what the agent wants from the page. Two modes:

1. **`summarize` (default)** — fetches the page, converts HTML to markdown, sends the markdown + the agent's query to a Tolo-tier internal LLM agent (`web-fetch`), returns the extracted information.
2. **`raw`** — fetches the page, converts HTML to markdown, returns it directly. If the content exceeds a character threshold, writes it to a session-scoped temp file and returns the file path with a warning, so the agent can use its existing `read`/`grep` tools to search the content.

### Agent-facing interface

```
web_fetch(
    url: str,                  # Required — the URL to fetch
    query: str,                # Required — what to extract (used as context for summarize mode)
    mode: str = "summarize"    # "summarize" or "raw"
)
```

### Summarize mode flow

1. Fetch URL via `httpx` (already a dependency)
2. Convert HTML → markdown (new dependency: `markdownify` or `html2text`)
3. For non-HTML content types (JSON, plain text), pass through as-is
4. Dispatch to `web-fetch` internal agent (Tolo tier) with the page content + agent's query
5. Return: URL (post-redirect), page title, content type, LLM answer

### Raw mode flow

1. Fetch URL via `httpx`
2. Convert HTML → markdown
3. If content < threshold → return markdown directly
4. If content >= threshold → write to `~/.stupidex/cache/web-fetch/<session-id>/<slug>.md`, return file path + warning ("Content was X chars — saved to file, use `read` or `grep` to search it")
5. Return: URL, page title, content type, content or file path

### LLM integration

- The summarization prompt lives in `agents/defaults/web-fetch/AGENT.md` — `type: internal`, `tier: tolo`
- Users can customize by placing their own version in `~/.stupidex/agents/web-fetch/AGENT.md`
- The tool makes a one-shot `litellm.acompletion` call, not a full agent loop
- Full page content is sent to the LLM (no chunking or truncation)

### Web fetching behavior

- Follow HTTP redirects (301/302)
- Set a reasonable `User-Agent` header (not default `python-httpx`)
- Graceful failure on 403, timeouts, connection errors — return a clear error message to the agent
- Configurable timeout (default: 30s)

### Cache lifecycle (session-scoped)

- Cache directory: `~/.stupidex/cache/web-fetch/<session-id>/`
- Session save: no action needed, files are already on disk
- Session delete: `delete_session()` in `storage.py` also deletes the session's cache directory
- App restart: cache files persist, accessible if the session is resumed

### New dependency

`markdownify` or `html2text` for HTML→markdown conversion. Both are lightweight, pure Python. Decision deferred to implementation — `markdownify` preserves more structure, `html2text` is more battle-tested.

### What's explicitly out of scope

- JavaScript rendering (SPA sites)
- Authentication / cookies / sessions
- `robots.txt` compliance
- Rate limiting
- PDF / image extraction
- Multi-page crawling
- Content caching across sessions
- Streaming large files

## References

- Tool system: `src/stupidex/tools/`
- Agent system: `src/stupidex/agents/` — agents defined via `AGENT.md` with frontmatter (`type: internal`, `tier: tolo`)
- Existing Tolo agents: `agents/defaults/reviewer/`, `agents/defaults/explore-codebase/`
- Session storage: `src/stupidex/session/storage.py` — `save_session()`, `load_session()`, `delete_session()`
- Home config dir: `~/.stupidex/` (`HOME_CONFIG_DIR`)
