# Progressive startup screen: residual review findings

Source review: `/tmp/compound-engineering-1000/ce-code-review/20260731-040717-41233943/review.json`

The automatic findings from the review were applied in `dc7d310`. The following findings require broader behavior or lifecycle decisions and were intentionally left for follow-up, as requested.

## #2 — Worker cleanup failure bypasses degraded fallback (P1)

- Location: `electron/src/main/llm/tool-pool.ts:62`
- Impact: if worker initialization and worker disposal both reject, startup becomes fatal instead of offering inline-tool degraded mode. The failed candidate is also cleared, so shutdown cannot retry cleanup.
- Follow-up: separate startup availability from cleanup success, retain failed cleanup candidates for a shutdown retry, and cover simultaneous initialization and disposal rejection.

## #3 — Renderer load failure bypasses the startup failure screen (P1)

- Location: `electron/src/main/index.ts:219`
- Impact: `createWindow()` ignores the `loadURL()` / `loadFile()` promise, so startup can publish `ready` after renderer navigation fails and users never see Orchid's failure guidance.
- Follow-up: define the product behavior for renderer-load failure, then await navigation and show a guaranteed local fallback document or quit cleanly.
