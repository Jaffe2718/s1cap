# What a round's report must contain

This is the reporting contract for a measurement round. It exists because the numbers a round produces are only
meaningful next to the identity of what produced them, and because three separate mistakes in one day produced
reports that were arithmetically fine and factually wrong: a round whose cells worked in DSH's shared default
workspace, a round whose local lane was never up, and a commit that claimed a gate had passed when it had not.

`docs/AGENT_BRIEF.md` rule 11 fixes the principle - **the measurement is not a single number, and the token triple is
reported separately** - and `docs/FORMULAS.md` §5-§7 fix the cost and time arithmetic. This document fixes what a
report *contains*, where each number comes from, and which numbers may not be published at all.

## 0. Two shapes of round

| Shape | Input | Report |
| --- | --- | --- |
| **D - one drawn task** | one task x {C0, C1, C2} | the three arms **side by side**; n = 3, so **no significance test is run**, and the report is process quantities plus verdicts |
| **B - full benchmark** | n tasks x {C0, C1, C2} | **paired** by task, with paired statistics; solve rate and the token triple are reported **separately** |

Both shapes share §1-§4. They part at §5.

## 1. Identity block

Every number in the report hangs off this block. A round without it cannot be read - "the record says C2 and the
process was C0" is a real failure mode, not a hypothetical.

```
task        instance_id / repo / base_commit / FAIL_TO_PASS / PASS_TO_PASS
arm         cell, and its policy values: r, d, w, tier1, deliver, tas
lane        provider, mode, baseUrl, model, pythonPath when local
tested LLM  provider, model, and reasoningEffort (measured rounds so far ran `high`)
judge env   interpreter, pytest version, and any compatibility shim the checkout needs
source      the tape's kind:"wiring" record - the profile text is not evidence
```

## 2. Validity gates - passed before any number is published

| Gate | Test | If it fails |
| --- | --- | --- |
| Workspace ownership | the session's workspace is `<run>/ws/<cell>` | the **verdict** is void (the tokens remain real) |
| Lane reachable | a health probe before the stimulus is sent | the arm does not run: a C2 with no lane measures nothing |
| Judge environment | `environmentIssue` is false | the verdict is marked environment-caused and **excluded from statistics** |
| Run completeness | not interrupted or killed | the whole round is **excluded**, with an `EXCLUDED.md` saying why |

## 3. Common to every arm

**Cost - the token triple, never collapsed into one number**

```
uncached input   the bill
cached input     what it costs to keep the context stable
output
hit rate = hit / (hit + uncached)
```

- Figure: **per-step token composition** (cached against uncached, stacked). A step that follows a compaction is
  marked, with what that rewrite cost against the run's median step.
- Source: the session store's per-message `usage`, plus the `compaction` records.
- Tool: `scripts/cell-report.mjs --format all`.

**Time - four quantities, none of which substitutes for another**

```
steps · tool calls · LLM time · tool time      plus wall clock and ms/step
```

`System-1 time` is **not additive** with these; it belongs to §4.

## 4. Specific to an arm that has a System-1 lane

C0 and C1 have no lane, and the report must say so explicitly rather than leave a blank.

```
S1 calls · questions asked · retries · latency p50/p95/max · failures
did the lane keep up:  demandedPairs against demandMissedPairs
                       scoredPairs against judgedPairs against deferredPairs
recall activity matrix   scripts/s1-activity.mjs
association-graph matrix scripts/rg-matrix.mjs   (cell = relevance %, state encoded in the border)
injection accounting     read `context_delivery` records ONLY
```

**A metric that reads the wrong source is a defect, not a rounding difference.** The `injected` column derived from
`assembly` records describes the candidate layout, not what was delivered; after delivery became a delta it reported
383.6 % of a round's own uncached input. Such a column is either repointed at the right record or removed.

## 5. Verdicts and statistics

**D - one drawn task.** The three arms side by side, each with its judge result. When every arm solves the task, the
report must say so in as many words: **solve rate does not discriminate here, the process quantities do.**

**B - full benchmark.**

```
per arm:  n (tasks) · solve rate with a confidence interval · median and quartiles of the token triple
paired:   per-task deltas (uncached, total, steps) across arms, via scripts/paired-stats.mjs
never:    a single composite score
never:    money - vendors reprice, tokens stay comparable
```

## 6. Reproducibility, and how a figure reaches the reader

A report is **generated, not written by hand**: every figure comes from a script, every command in it can be re-run as
written, and a superseded value is kept as a dated `_meta` note rather than overwritten.

**A figure is the generating tool's own vector output, referenced unmodified.** The rule exists because a rasterised
copy silently loses the thing that makes a figure checkable - its text, its vectors, and its ability to be read at any
size - while looking exactly like the real one.

- The record is the **SVG the tool wrote**, byte for byte: `cell-report.mjs` for the token, cost, time and governance
  figures, `s1-activity.mjs` for the recall activity matrix, `rg-matrix.mjs` for the association-graph matrix.
- The report embeds each figure **by its own filename, from the directory the tool wrote it into**, and that file is
  never re-drawn, re-scaled, re-coloured or "cleaned up" by hand afterwards.
- **A screenshot is never a figure.** A rasterised copy may be shown in a chat message so a reader can glance at it,
  but it is not the record: it is not committed, not referenced from a report, and not the artifact a later reader is
  pointed at. If a PNG of a figure exists at all, it is a convenience copy and is labelled as one.
- When the surface a reader uses cannot render SVG (some previews cannot), ship an `index.html` **beside** the report
  that displays the same SVG files, so the vector originals stay reachable either way.
- The numbers inside a figure and the numbers in the report's tables come from the same records. If they disagree, the
  report is wrong, not the figure.

## 7. The honesty clauses

Each of these comes from a failure that actually happened.

1. **Never collapse the measurement into one number**; report the token triple separately (rule 11).
2. **Never report money**, only tokens.
3. **A stale metric is labelled or deleted**, never left to look current.
4. **An environment-caused failure is marked, not counted.**
5. **An interrupted or killed round does not enter statistics**, and an exclusion note is written where a reader will
   find it.
6. **The record must match the behaviour.** A commit message claiming a gate passed, a tape claiming a lane that never
   answered, a report claiming a cell that worked elsewhere - each is a defect, and is fixed as one.
