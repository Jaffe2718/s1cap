# DOC-CONTRACT — what a document may own, and what it must point at

A rule sheet, not an essay. It exists because one design change — one arm's `deliver` flag and one `tier1`
value — forced edits across ~10 documents in three separate sweep passes: they restated values the code
already owned.

## 1. Three classes of document

- **(a) Rules and invariants** — hand-maintained, deliberately small, stable. The run book, the handover,
  the arm definitions, `DEFECT-GATE.md`. A rule may be restated in one line with a pointer to its full
  statement; it may not be re-derived in two places.
- **(b) Facts the code or a run owns** — arm tables, knob names and defaults, metric definitions, wiring
  records, evidence layouts, command sequences. **Generate them or read them from their source; a document
  may only point at them.**
- **(c) Dated records** — round reports, audits, captured outputs, diagnostic analyses. **Frozen.**

## 2. The rule this pass paid for

**A document sentence that repeats a value the code owns is a defect of the documentation, not a
convenience.** The fix is a pointer, never a synchronised copy. When a document and its source disagree,
the source wins and the document is corrected — not the other way round.

**This rule is machine-checked** by `scripts/check-doc-pointers.mjs`: exit 0 clean, 1 on findings, 2 on a
usage error or an unreadable source of truth.

## 3. Single sources of truth

| fact class | source |
| --- | --- |
| arms, switches, knob names and defaults | `bench/cells/*.json` + `cellPolicy()` (`packages/core/src/types.ts`) |
| metrics | `scripts/cell-report.mjs` |
| formulas and definitions | `docs/FORMULAS.md` |
| procedure and commands | `.s1cap-ablation/RUNBOOK.md` |
| verdicts (the defect gate) | `.s1cap-ablation/DEFECT-GATE.md` |
| what a run was configured as | that run's own `wiring` tape record (`<DSH_HOME>/.s1cap/tape.jsonl`) |
| task pools, grid, budget, success rule | the experiment design and metrics sections of `docs/AGENT_BRIEF.md` |
| the standing brief for the loop | `HANDOVER-DSH-TEST.txt` |

## 4. Correcting a wrong dated record

1. **Never rewrite the record.** Append a dated correction that names the file and the line, and the source
   that says otherwise. (Precedent: `STATUS.md` §3b and the late updates in `DEFECT-GATE.md`.)
2. A correction that changes a **verdict** also lands in `DEFECT-GATE.md`; a correction that changes a
   **rule** belongs in the owning rules document, not in the record.
3. **Frozen files:** every `round-*/` directory (`ROUND-REPORT.md`, `report-diagnostic/*`, `judge-*.txt`),
   the audit files (`s1cap-audit-*.md`), captured tool output, and the dated sections of `STATUS.md`.
4. A dated record may be *superseded* by a newer record; it is never edited into agreement with it.
