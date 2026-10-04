# Collaborator prompt — running and tuning an S1CAP experiment

Copy the block below into a fresh assistant session. It names only paths inside this repository, because a reader on
GitHub cannot see anything outside it: the round harness and the recorded rounds live on the operator's machine and
are deliberately not part of the project.

---

You are working on **S1CAP**, a research harness for a three-cell ablation. Read these four first, in order:
`bench/README.md` (what the cells are and which contrast is registered), `docs/ARCHITECTURE.md` (the pipeline:
segmenter -> association graph -> System-1 lane -> assembler -> delivery), `docs/CELLS-RUN.md` (how a round is run and
what its records mean), `docs/FORMULAS.md` (the registered cost, window and statistical analysis).

**The cells.** `C0` is the baseline and delivers nothing; `C1` delivers the state proxy `T` alone; `C2` delivers `T`
plus the segments System-1 recall selected.
**The cell policy is data.** `bench/cells/{C0,C1,C2}.json` is the only source of a cell's switches (`deliver`,
`tas.on`, `recall.tier1`, `recall.threshold`, `recall.depth`, `recall.window`, `s1.*`). `cellPolicy()` in
`packages/core/src/types.ts` sets nothing; it returns the defaults with the cell's name on them.

**Proceed without asking**
- Read anything. Run `node scripts/build-packages.mjs`, the test suite, `scripts/check-lib-fresh.mjs`,
  `scripts/check-doc-pointers.mjs --check`, and any tool's `--self-test`.
- Reproduce behaviour locally. `scripts/stub-s1-backend.mjs` answers `/v1/systemone` with content-derived weights
  rather than constants, so the live System-1 path can be exercised with no checkpoint and no key;
  `scripts/replay-tape.mjs <tape.jsonl>` replays a tape and must produce the same digest twice;
  `scripts/window-curve.mjs`, `scripts/paired-stats.mjs` and `scripts/prompt-hash.mjs` are self-contained.
- Draw and read the figures: `scripts/cell-report.mjs`, `scripts/s1-activity.mjs`, `scripts/rg-matrix.mjs`.
- Write a patch **with tests**, and say which measurement supports it.

**Stop and ask a human first** — propose it, state the single variable it moves and what you predict, then wait:
- any change to a study variable in `bench/cells/*.json` (`recall.threshold`, `recall.depth`, `recall.window`,
  `s1.provider`, `deliver`, `tas.on`, `recall.tier1`);
- anything needing a live backend, a real round, or a credential;
- `git commit`, `git push`, or any rewrite of history;
- deleting or overwriting a record, a round directory, or a figure.

**Never propose a commit on a red tree.** The gates, in order: `build-packages.mjs` -> the test suite ->
`check-lib-fresh.mjs` (every `lib/` file byte-identical to what `src/` builds) -> `check-doc-pointers.mjs --check`.
A test that fails immediately after a preset change is usually a test that hardcoded the old value: this project has
had that happen twice, and the fix belongs in the test.

**Facts that decide whether a measurement means anything.** Each of these has cost a real round.

- **The uncached input is the whole bill.** A cache read is priced roughly 1/50 of a miss, so at a 90 % hit rate the
  miss is still about 96 % of the input cost. Improving the hit *rate* barely moves the bill; shrinking what stops
  being a hit moves it a lot.
- **Delivery appends one message** at the end of the step's messages; it does not replace the history. The injected
  block is therefore uncached by construction, and it is the largest single line in a bill (measured at 40-71 % of a
  run's miss). **Nothing caps the recalled block by tokens**: `recall.window` and `recall.threshold` bound how many
  pairs are *scored*, not how much is *delivered*.
- **The lane keeping up is `demandedPairs` against `demandMissedPairs`**, not `settled / offered`. Scoring is on
  demand, so an unscored pair is normally one the walk never asked about; `settled / offered` measures what the walk
  wanted, and reading it as a shortfall is a mistake this project has made.
- **A compaction rewrite invalidates the whole prompt prefix.** One event has accounted for more than half of a run's
  uncached input, which is why the compaction records are read before the token totals.
- **`recall.threshold` behaves like a switch, not a dial**, across the range measured so far: walk candidates per
  segment went 0.33 at `r = 0.60`, 3.67 at `0.58` and 9.0 at `0.55`, and the cost of one task went $0.083, $0.147,
  $0.344. Two lanes do not share an answer, because they do not share a score distribution.
- **`recall.depth` costs the lane nothing** (the offered pair count contains no `d`), and **`recall.window` costs lane
  calls, not prompt tokens** - but `w` is bounded by the backend's concurrency on a local lane, so raising it is only
  free against a hosted one.
- **Move one variable at a time, and treat one run as one sample.** Say which variable a proposal moves, and what
  result would refute it.
