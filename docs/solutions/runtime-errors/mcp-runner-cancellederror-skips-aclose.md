---
title: "CancelledError in MCP runner's finally block skips exit_stack.aclose(), causing dangling async generators"
date: 2026-06-19
category: runtime-errors
module: MCP (stupidex.mcp)
problem_type: runtime_error
component: development_workflow
severity: medium
symptoms:
  - '"an error occurred during closing of asynchronous generator" logged during app shutdown'
  - 'RuntimeError: Attempted to exit cancel scope in a different task than it was entered'
  - async generator finalizer fires after event loop shutdown_asyncgens, in wrong task context
root_cause: async_timing
resolution_type: code_fix
tags:
  - mcp
  - async-generator
  - cancel-scope
  - shutdown
  - anyio
---

# CancelledError in MCP runner's finally block skips exit_stack.aclose()

## Problem

When the app shuts down, two error messages are logged per MCP server:

```
an error occurred during closing of asynchronous generator <async_generator object stdio_client at 0x...>
RuntimeError: Attempted to exit cancel scope in a different task than it was entered in
```

The `stdio_client` and `sse_client` transports from `mcp` wrap anyio task groups with task-bound cancel scopes. If the async generators aren't properly closed before the event loop teardown, Python 3.14's `shutdown_asyncgens` finalizes them in a different task context, triggering the cross-task error.

## Symptoms

- Warning-level log messages on every app shutdown with MCP servers configured
- No immediate data loss (the subprocess is killed by process group teardown), but the errors indicate leaked transport tasks
- The existing lifecycle test suite (`test_mcp_lifecycle.py`) already covered the cross-task scenario but did not cover this CancelledError path

## What Didn't Work

- The existing `MCPManager._run()` design was correct in principle — one dedicated task owns enter/exit of all transport contexts. But `CancelledError` (a `BaseException`) could interrupt `await self._stop.wait()` inside the `finally` block, causing the subsequent `aclose()` to never execute.
- Adding a bare `except` around `_stop.wait()` without re-raising `CancelledError` would silently swallow cancellation.

## Solution

In `MCPManager._run()`'s `finally` block, catch `asyncio.CancelledError` around `await self._stop.wait()`, continue to `aclose()` regardless, then re-raise the `CancelledError`.

```python
# Before: CancelledError propagates through _stop.wait() and skips aclose()
finally:
    self._ready.set()
    await self._stop.wait()
    try:
        await self._exit_stack.aclose()
    except Exception:
        logger.warning("Error during MCP shutdown", exc_info=True)

# After: aclose() always runs, then CancelledError re-raised
finally:
    self._ready.set()
    cancelled = False
    try:
        await self._stop.wait()
    except asyncio.CancelledError:
        cancelled = True
    try:
        await self._exit_stack.aclose()
    except Exception:
        logger.warning("Error during MCP shutdown", exc_info=True)
    if cancelled:
        raise
```

## Why This Works

`CancelledError` inherits from `BaseException`, not `Exception`, so the `try/except Exception` around `aclose()` would not catch it. The fix intercepts the cancellation signal at the earliest safe point (`_stop.wait`), holds it, ensures the critical cleanup (`aclose()` — which closes all transport contexts and their underlying anyio task groups) runs in the same task that entered them, and *then* propagates the cancellation.

## Prevention

- Any `finally` block containing async cleanup that includes `await` should guard against `CancelledError` unless the cleanup is safe to skip.
- The existing test `test_shutdown_from_different_task_does_not_raise` should be complemented with a test that simulates runner cancellation to cover this path.

## Related Issues

- https://github.com/orgs/python-mcp/discussions — anyio task groups have task-bound cancel scopes
- `mcp` SDK's `stdio_client` wraps `anyio.create_task_group()` — entering the context in one task and exiting from another raises `RuntimeError`
