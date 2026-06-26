---
name: web-research-cache
description: 'RAG research cache note — web fetch is unavailable in stupidex; RAG-based codebase research is used instead.'
---

# Research Cache

**Note:** Web fetch is not available in this environment. The ideate skill uses `rag_search` for codebase-grounded research instead of web-based research. The caching mechanism below applies to RAG search results when used.

## Cache file shape

```json
[
  {
    "key": {
      "mode": "repo|elsewhere-software|elsewhere-non-software",
      "focus_hint_normalized": "<lowercase, whitespace-collapsed focus hint or empty string>",
      "topic_surface_hash": "<short hash of the user-supplied topic surface>"
    },
    "result": "<RAG research output as plain text>",
    "ts": "<iso8601>"
  }
]
```

Files live under a temp scratch directory.

## Reuse check

Before dispatching RAG research, check for existing cache entries from prior runs in the same session. If any entry's `key` matches the current dispatch (same mode variant plus same normalized focus hint plus same topic surface hash), skip the dispatch and pass the cached `result` to the consolidated grounding summary.

On `re-research` override, delete the matching entry and dispatch fresh.

## Append after fresh dispatch

After a fresh dispatch, append the new result to the cache file. The next invocation in the session can reuse it.

## Topic surface hash

The topic surface is the user-supplied content the research is grounded on:
- **Elsewhere modes:** the user's topic prompt plus any Phase 0.4 intake answers.
- **Repo mode:** the focus hint plus a stable repo discriminator (resolved from `git remote get-url origin`, `git rev-parse --show-toplevel`, or CWD).

Normalize before hashing: lowercase, collapse whitespace. First 8 hex chars of sha256 is sufficient.

## Degradation

If the cache file is unreachable across invocations on the current platform (filesystem isolation, sandboxing, ephemeral working directory), degrade to "no reuse, dispatch every time." Surface the limitation and proceed without reuse rather than inventing a capability the platform may not have.
