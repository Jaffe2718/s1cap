# Small offline evaluations after the 2026-10-04 optimization

This report adds deterministic engineering checks to the microbenchmarks in
[OPTIMIZATION-20261004.md](./OPTIMIZATION-20261004.md). It compares commit
`b2a08c357bbc7b009944a7b9b40d0026616e53c3` with baseline
`346d7865913c231208830f12383f050081e3cfe7`.

These are not SWE-bench, Terminal-Bench, tau-bench, or live-model results. Tokens are estimated by the
repository heuristic; relevance labels and scores are deterministic; elapsed times measure only local JavaScript.
Every timing case is warmed up and repeated five times, with the median reported. Raw samples and exact inputs are
in [simple-evals.json](../profile_output/simple-evals.json).

## Long-session scaling

Each step selects the latest eight facts. The control re-emits the full selected block; the optimized path repairs
only facts missing from the visible surface. All required-fact checks passed at every step.

| Steps | Coverage checks | Baseline injected tokens | Optimized | Reduction | Baseline median | Optimized median |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 228 | 27,758 | 3,269 | 88.2% | 41.78 ms | 8.54 ms |
| 64 | 484 | 58,654 | 6,408 | 89.1% | 173.07 ms | 27.45 ms |
| 128 | 996 | 121,377 | 12,826 | 89.4% | 376.02 ms | 53.55 ms |
| 256 | 2,020 | 249,817 | 26,022 | 89.6% | 1,544.84 ms | 195.78 ms |

At 256 steps, newly injected text is 89.6% smaller and cumulative visible injected history is 89.4% smaller.
The local runner is about 7.9x faster at that size, but this is not an end-to-end agent latency claim.

## Repeated compaction

The 128-step fixture drops all but the latest two injected messages at each simulated compaction. Relevant facts
that disappear must return; retained facts must not be repeated. All 996 required-fact checks passed in both arms.

| Compact every | Compactions | Baseline injected tokens | Optimized | Reduction | Visible-history reduction |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 16 steps | 7 | 121,377 | 17,543 | 85.5% | 83.1% |
| 32 steps | 3 | 121,377 | 14,837 | 87.8% | 86.2% |

More frequent compaction correctly requires more repair. It does not cause a coverage failure or restore the whole
selected block indiscriminately.

## Recall precision and cost

The corpus has 96 segments in eight interleaved topics. Earlier segments with the anchor's topic are relevant.
The deterministic scorer assigns 0.62 or 0.82 to relevant pairs, 0.42 to adjacent-topic distractors, and 0.08 to
other pairs. Depth is one, so this isolates the window/threshold trade-off without multi-hop amplification.

| Window | Threshold | Questions | Precision | Recall | F1 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 0.55 | 4 | 0.0% | 0.0% | 0.0% |
| 8 | 0.55 | 8 | 100.0% | 9.1% | 16.7% |
| 16 | 0.55 | 16 | 100.0% | 18.2% | 30.8% |
| 32 | 0.55 | 32 | 100.0% | 36.4% | 53.3% |
| 32 | 0.35 | 32 | 33.3% | 36.4% | 34.8% |
| 32 | 0.70 | 32 | 100.0% | 18.2% | 30.8% |

For this fixture, `threshold = 0.55` is the best of the three tested thresholds at every useful window. A larger
window increases recall linearly with scoring questions. This is a tuning sanity check, not evidence that the same
threshold is optimal for a learned backend or real tasks.

## Historical-text replay

The three user turns from local round `round-20261001-long-001` were replayed as text, without running its agent or
hidden evaluator. With the full surface visible, the optimized delivery emits zero duplicate tokens, while the
control emits 678 estimated tokens across two insertions. When the first turn is removed before the final turn,
the optimized path restores that one missing turn in one 281-token insertion; the control still emits 678 tokens.

This establishes delivery behavior on non-synthetic prose only. It does not establish task correctness or solve rate.

## Reproduce

```bash
node scripts/eval-optimization.mjs \
  --baseline /path/to/s1cap-at-346d786 \
  --baseline-commit 346d7865913c231208830f12383f050081e3cfe7 \
  --optimized-commit b2a08c357bbc7b009944a7b9b40d0026616e53c3 \
  --history /path/to/round-20261001-long-001/turns.json \
  --history-label round-20261001-long-001/turns.json \
  --output profile_output/simple-evals.json
```

Omit `--history` to run the synthetic suites without the private historical artifact.

## Profiling instrumentation changelog

| File | Change type | What was added |
| --- | --- | --- |
| `scripts/eval-optimization.mjs` | Added | Standalone scale, compaction, precision/recall, timing, and optional historical-text fixtures with assertions |
| `profile_output/simple-evals.json` | Generated | Inputs, raw five-run timing samples, metrics, commits, and scope disclaimer |
| `docs/EVALUATION-20261006.md` | Added | Human-readable results, limitations, and reproduction command |

No probes were added to production hot paths. The runner and its two output artifacts can be removed without
changing S1CAP runtime behavior.
