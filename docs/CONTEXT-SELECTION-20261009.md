# S1 selection on an intact context

Round `round-20261009-1122` recorded `recall-visible` on all 30 C2 steps,
zero demand walks and zero S1 calls. The visibility shortcut was treating
"already present" as "no relevance decision needed". That disables the S1
mechanism even though the lane is configured.

## Implementation

`step-observer.ts` now runs the existing bounded demand walk independently of
visibility. Completed pair scores are reused. C0/C1 still have recall off.
`recallVisibleSkips` is retained as a legacy telemetry field, not incremented.
The canonical visibility proof remains in delta delivery to prevent duplicate
injections; repairing that proof was useful and is not reverted.

`context-selection.ts` applies explicit S1 rejections to older, chunked,
single-text tool results using the shipped DSH 0.2.0-rc.2 session surface API:

```
session.append('tool/result', originalDataWithChangedMessageContent, {
  surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
  sourceEventSeqs: [seq],
})
```

The packaged `dsh-session/lib/types/surface.js` permits exactly one tool-result
node to be replaced and requires every field except `message.content` to match.
The native loop then builds its request from `session.deriveMessages()`. This
is a durable, replayable model-view change, not a mutation of request arrays.

Only current-anchor pairs actually judged by S1 below the configured relevance
threshold can authorize removal. Selected chunks, unknown/lexical pairs,
instructions, user messages, assistant tool calls, the assembly tail and anchor,
and at least the last three surface nodes are retained. Empty results and
replacements that would not reduce character count are refused. Tool-call ids,
result ids, turn/step/source/error metadata and native pairing stay intact.
Archived original chunks remain in the association graph; shortened tool-result
surface replacements are recorded in the session stream but do not overwrite
that archive. A later recall can recover omitted content.

Missing host APIs or a rejected replacement preserve the remaining native
context. Each selection attempt writes a `context-selection` tape record with
the rejection count, changed-result count, removed character count and reason.
Characters removed are a mechanism diagnostic, not provider token savings.

## Verification status

No tests or model calls were run for this revision, at the user's request.
Generated JavaScript is rebuilt for profile installation. Existing tests that
asserted the obsolete zero-call shortcut are updated to assert S1 engagement.
No latency, cost, solve-rate or non-regression claim is made without a new run.

## Follow-up: reduce blocking in demand scoring

The 12:27 report leaves pre-step time outside `step/start` / `step/end`.
Consequently step remainders alone cannot establish that S1 is nonblocking.
This revision addresses two code paths that can prolong anchor waits:

- Demand levels now accept each row as it completes, recording its S1 weights
  and releasing its claim immediately. Existing scorers returning only a final
  answer array remain compatible; published rows are counted only once.
- Concurrent walks share one bounded scoring scheduler. Depth-zero rows take
  priority over queued deeper BFS rows, and a new anchor promotes an existing
  queued claim for that row. Running requests are not cancelled.
- Anchor waiters wake on row completion or release, with the existing short
  polling interval as a fallback. If no scoring operation owns an unknown row,
  the waiter stops instead of consuming the remaining ten-second budget.
  Unknown content is retained, with no lexical substitution for S1 judgments.

The scoring threshold, recall depth/window, backend admission limit and anchor
wait budget are unchanged. Scheduling can affect which deeper rows finish
within a budget; quality and timing non-regression remain unverified.

New tape records distinguish `pre-step-timing` (total, downstream middleware,
plugin, observation and context application), `s1-row-timing` (queue delay and
scorer time, including client retries), and `anchor-wait-timing` (actual elapsed
time, configured budget and exit reason). Existing `anchor-wait.ms` retains its
legacy meaning of configured budget, not measured latency. Scorer durations
overlap and must not be added to wall time.

Both packages' generated JavaScript were rebuilt. No tests, benchmark rounds
or model calls were run. Type checking could not run because this checkout
does not have the `tsc` executable installed; no dependency was downloaded.

## Build gate repair (2026-10-09)

The subsequent request authorizes local build/test gate repair. Using the
read-only Harness installation's Node v24.21.0, all packages were regenerated;
`scripts/check-lib-fresh.mjs` passes for all 40 files. The prior manual removal
of whitespace from generated JavaScript caused five byte-level mismatches.
Generated output must remain exactly as the build writes it.

The anchor-priority test now verifies anchor scores are persisted when the step
returns, then waits explicitly for final walk telemetry before asserting its
totals. It does not reintroduce waiting for the whole walk into production.
The Python discovery test's mocked dependencies now specify a fixed executable
path so its expected candidates do not depend on the Node installation.
No Laya backend implementation or Harness installation file was changed.

The full local suite passes: 402 tests, 402 passed, zero failed/cancelled/skipped.
Test process TEMP/TMP point into the workspace because sandboxed persistence
tests cannot rename snapshot files in the default system temporary directory.
Evidence: `../.s1cap-audit-scratch/optimization-20261009/build-green-tests.txt`.
No model calls or benchmark rounds were started; type checking remains unrun.
