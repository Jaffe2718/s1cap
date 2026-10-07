# DSH / TAS / S1CAP three-cell offline comparison

Date: 2026-10-07. The raw data is in [cell-comparison.json](../profile_output/cell-comparison.json),
and the self-contained runner is [eval-cells.mjs](../scripts/eval-cells.mjs).

## What was compared

The runner loads the current `bench/cells/C0.json` to `C2.json` presets through the same
`cellPolicyFromPreset()` resolver used by the implementation. It replays the same four fixed
task transcripts through `observeStep()` and `deliverContext()` in each cell. Each transcript has
an early tool result containing one exact value, an assistant trace, 11 unrelated tool results,
and a final tool step that needs the earlier value. The visible surface is either complete or
compacted to the last two messages before that final step.

| Cell | Delivered intervention | S1 lane in preset | Offline scorer used here |
| --- | --- | --- | --- |
| C0 / DSH | None | Absent | None |
| C1 / TAS | Serialized trace `T` | Absent | None |
| C2 / S1CAP | `T` plus selected earlier turns | Jev configured | Local lexical fallback |

The C2 run uses `lexicalScore()` for deterministic offline scoring because no Jev service was
called. The result tests recall and delivery using the current policies; it does not measure
Jev quality. The actual delivery channel appends `T`; the paper's full trace-position contrast
is not implemented in the model view.

## Results

Five warm runs per case gave identical discrete results; times below one millisecond are in the
raw file only because they do not predict agent latency. Tokens use `estimateTokens()`.

| Visible surface | Cell | Exact facts available | Serialized `T` present | Extra injected tokens | Local score questions |
| --- | --- | ---: | ---: | ---: | ---: |
| Complete | DSH / C0 | 4/4 | 0/4 | 0 | 0 |
| Complete | TAS / C1 | 4/4 | 4/4 | 147 | 0 |
| Complete | S1CAP / C2 | 4/4 | 4/4 | 147 | 0 |
| Compacted | DSH / C0 | 0/4 | 0/4 | 0 | 0 |
| Compacted | TAS / C1 | 0/4 | 4/4 | 147 | 0 |
| Compacted | S1CAP / C2 | 4/4 | 4/4 | 420 | 68 |

The tool facts are absent from the two retained messages after compaction. C1 restores the
assistant's trace, which says what to inspect but does not contain those exact tool values.
C2 recovers all four values. It selects three earlier segments per case, so the 420-token
injection includes more than just the four target facts. On the complete surface, C1 and C2
add the framed `T` even though the original assistant text remains visible: the serializer
changes its representation, so the visibility check does not treat the raw assistant text as
an already delivered `T`. C2's content-based visibility gate skips scoring in all four complete
cases and scores in all four compacted cases.

These are context-availability checks, not task answers. There is no solve-rate, provider
token usage, cache billing, model time, or official benchmark reward in this evaluation.
The prepared local Terminal-Bench task remains `prepared-not-run`; it supplies no outcome data.

## Reproduce

```bash
node scripts/eval-cells.mjs \
  --commit 6ea8c668a9667afc27022eef42e75d9e31cd1665 \
  --output profile_output/cell-comparison.json
```

The commit argument is a label for the checkout under test; use `git rev-parse HEAD` for an
exact value when reproducing. No network access, model credentials, or installed DSH profile
is required.

## Instrumentation changes

| File | Change | Purpose |
| --- | --- | --- |
| `scripts/eval-cells.mjs` | Added | Fixed four-case three-cell replay and measured delivery output |
| `profile_output/cell-comparison.json` | Generated | Per-case results and five timing samples |
| `docs/DSH-TAS-S1CAP-EVAL-20261007.md` | Added | Comparison and its limits |

No production source files were modified for this evaluation.
