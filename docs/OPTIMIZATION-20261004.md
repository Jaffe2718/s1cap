# What changed to make S1CAP cheaper without losing recalled facts?

Implementation and offline measurement record, 2026-10-04. Baseline:
`346d7865913c231208830f12383f050081e3cfe7`. Historical rounds and registered cell presets were not modified.

## Method change: recall is a repair of missing context

The old delivery path appended the entire selected block whenever any part changed. An unchanged trace and
unchanged recalled turns were paid for repeatedly. Its session-lifetime digest also prevented a previously sent
block from returning after compaction removed it.

The plugin now reads DSH's actual `Session.deriveMessages()` projection. This API excludes surface nodes removed by
compaction; the append-only log and the inbox do not. Two checks use the same exact-content visibility predicate:

- Before scoring, if every recorded content segment is already visible, do not start an S1 recall walk. Trace
  construction and assembly still run. Unknown message shapes or unavailable projection APIs do not enable this shortcut.
- Before delivery, re-read the projection after observation's awaits and emit only missing trace/recalled blocks.
  Original messages, tool pairing, and transcript order are preserved. Suppression requires an original message's
  matching id and verbatim text, or a visible S1CAP injection containing the full labelled block. A compacted-away
  block becomes eligible again. Forks and process restarts derive visibility from their own surface.

The implementation is in [context-delivery.ts](../packages/dsh-plugin/src/context-delivery.ts),
[step-observer.ts](../packages/dsh-plugin/src/step-observer.ts), and
[index.ts](../packages/dsh-plugin/src/index.ts). `recall-visible` probe records and the observer's
`recallVisibleSkips` counter expose skipped scoring. Delivery records describe the blocks actually inserted;
assembly records still describe the candidate layout, so they are not delivered-token measurements.

The insertion's trace order now follows the assembled order. This distinguishes Trace Append from Trace as State
**inside the injection**. It does not reorder the harness's existing history or place the question last in the
whole request, and does not implement the proposed full model-view proxy.

## Scoring and correctness changes

The [demand scheduler](../packages/dsh-plugin/src/demand-scheduler.ts) runs rows with bounded concurrency using the
existing admission policy, preserving result alignment. It checks the walk deadline before each row, rather than
letting a whole claimed level continue to launch work after its deadline. Already admitted requests retain the
client's timeout/retry behavior and may finish later; this is not a hard cancellation deadline. Session attribution
travels with each request, including retries, instead of using a shared mutable session variable.

The [association graph](../packages/core/src/assoc-graph.ts) now traverses retained graded scores at the current
threshold. Previously, lowering the threshold could not recover pairs omitted from the edge set at ingest.
Demand scoring asks only for missing pairs, including when a window grows beyond a settled eager cursor or a
snapshot has a partially measured row. When a backend becomes available, it can replace lexical guesses;
backend judgements are reused. Nonfinite/out-of-range rows are released for retry instead of counted as judged.
Demand pair counts are therefore the **sum of the offered candidate-list lengths**, bounded above by the old
sum of full window sizes. Skipped claims are counted even when other rows in that level were offered.

The lexical fallback's double-escaped Unicode regex previously treated normal words as separators. It now
tokenizes Unicode words correctly and memoizes token sets with weak segment-object keys, invalidating on text
change. This avoids re-tokenizing a segment for every pair without retaining dead sessions in a global text cache.

The [assembler](../packages/core/src/assembler.ts) applies structural exclusions on the unjudged fail-open path,
so pinned content, recent tail, and anchor siblings cannot be injected as earlier history. It no longer discards
all but one chunk of a passage: a sibling is redundant only if its **entire text** is already contained in a
selected sibling. Distinct chunks retain distinct facts, even if that costs more tokens than incorrectly deleting
them. No new recall token cap or study knob was introduced.

The [trace cache](../packages/core/src/observer.ts) freezes the first **nonempty** task trace; a task-opening empty
trace cannot disable T for the entire task. The plugin keeps trace caches per session, including forks that reuse
event ids. Payload ids use SHA-256 rather than a 32-bit hash; existing injection prefixes remain recognizable.

## Recorded offline results

Raw inputs are deterministic in [profile-optimization.mjs](../scripts/profile-optimization.mjs); measured samples,
baseline commit, runtime version, and timestamp are in [optimization.json](../profile_output/optimization.json).

| Fixture / measurement | Control | Optimized | What this establishes |
| --- | ---: | ---: | --- |
| 48 steps, rolling recall, one simulated compaction: injected token estimate | 54,234 | 6,548 | 87.9% less newly injected text; all 356 per-step required-fact checks pass |
| Same fixture: cumulative visible injected-history token estimate | 731,506 | 101,397 | Reduced accumulation in this fixture, not a provider cache/billing result |
| Fully visible 12-step history: stub scoring calls / questions | 11 / 66 | 0 / 0 | Visibility admission avoids unnecessary scoring; control disables only the new surface check |
| Partially restored row: new questions / recalled hits | 4 / 4 | 2 / 4 | No repayment of the two existing judgements; identical recalled ids |
| 32 independent rows, simulated 4 ms latency, median of five runs | 135.43 ms serial | 66.74 ms with two workers | 2.03× scheduler speedup, identical answers; not a live backend throughput claim |
| 2,936 lexical pairs, median of five runs | Unicode-correct uncached reference | 16.49× faster with warmed token sets | Exact checksum equality; comparison is deliberately not against the old broken scorer |

These are synthetic engineering fixtures, not SWE-bench, Terminal-Bench, or τ²-bench results. Token counts use the
repository's heuristic estimator, not a provider tokenizer. Actual task solve rate, model attention effects of
removing repeated reminders, live backend saturation, and billed cache-hit/miss cost still need paired task runs.
The latency samples are descriptive microbenchmarks, not confidence intervals or end-to-end agent speedups.

## Reproduce

Use a separate checkout of the baseline commit, with workspace dependencies installed there as well. In the
optimized checkout:

```bash
npm install --ignore-scripts --package-lock=false
node scripts/build-packages.mjs
npm test
node --test scripts/*.test.mjs
node scripts/check-lib-fresh.mjs
node scripts/check-diagram.mjs
node scripts/profile-optimization.mjs --baseline /path/to/baseline-checkout --output profile_output/reproduction.json
```

The benchmark imports the baseline's committed JavaScript for delivery and graph behavior. Its scheduler control
is the old serial loop; the lexical control is an explicitly corrected, uncached reference. No API key, network
model call, external message, or live experiment is used by the benchmark.

## Validation record

- Package suite: **399 passed**, including real DSH `Session` append/compaction through the delivery middleware,
  visibility admission, changed content, fork isolation, deadline expiry, partial snapshots, backend recovery,
  threshold/window changes, trace startup, and distinct passage facts.
- Script suite: **15 passed, 1 skipped**. The skip is the existing prompt-hash test requiring an absent historical
  round artifact.
- Generated `lib/` is rebuilt using the repository's type-stripper and checked for byte equality. Diagram check
  passes. Type erasure intentionally preserves whitespace; source diffs are checked separately.
- Two pre-existing Linux test failures came from constructing Windows venv paths while inspecting the local
  filesystem. The setup fixtures now use the host platform; dedicated target-platform path tests remain intact.
- Full `npm run typecheck` is **not green**: the baseline already produces 342 diagnostics with TypeScript 5.9.3
  and Node 24 types, including absent workspace declarations, unchecked indexing, and outdated test shapes.
  New modules inherit that declaration-resolution problem. This change does not claim a clean repository-wide
  static type gate.
- Documentation-pointer checks report the same **38 existing findings** on the baseline: references to private
  run artifacts and stale section anchors. Frozen historical records were not rewritten to hide them.

## Profiling instrumentation changelog

The `system-profile` workflow was used to keep measurements in a standalone runner and save structured results.

| File | Change | Instrumentation |
| --- | --- | --- |
| [profile-optimization.mjs](../scripts/profile-optimization.mjs) | Added | Standalone timing, request-count and text-volume fixtures; exact-output/fact-preservation assertions |
| [optimization.json](../profile_output/optimization.json) | Generated | Raw measurements and five timing samples per microbenchmark |

No timing probes were inserted into production hot loops. The standalone runner and generated report can be
removed independently if profiling artifacts are not wanted; the runtime optimization does not depend on them.
