# Tool context selection

S1 scoring, graph upkeep and recall continue for short histories. Only destructive
replacement of older tool results is gated, after the observer has assembled the
step. TAS and missing-evidence recall are unchanged by this gate.

Before replacement, estimate the current DSH durable surface using its visible
nodes and derived message content, including structured reasoning and tool call
arguments. Do not substitute the assembled S1 selection or the complete historical
graph for the history the model currently sees. Counts are heuristic estimates,
not provider token-meter measurements.

The initial conservative policy requires both:

- Estimated visible history at least `min(s, floor(budgetTotal / 2))` tokens,
  where `s = shortContextTokens`, default 32768. Zero disables the short-history
  guard. `budgetTotal` is the assembler's available input
  budget, after its output reserve and overhead.
- Aggregate net savings across eligible replacements at least
  `max(1024, ceil(visibleTokens * 0.05))` estimated tokens. Savings include the
  excerpt headers; small deletions are skipped even in long histories.

All replacements are planned before any write-back. Existing protection of
instructions, user messages, assistant messages, recent results, selected chunks,
unjudged chunks, native tool pairing and unchanged-content checks still applies.
Missing budget or unreadable visible evidence causes preservation.

The `context-selection` tape probe records `contextTokens`,
`contextThresholdTokens`, `minimumSavingTokens`, `potentialSavingTokens`, actual
`changed`/`removedChars`, and the skip or replacement reason. Thresholds are
conservative implementation defaults, not benchmark-established optimal values.

## Settings and naming

The settings panel exposes `r / d / w / c / omega / s`:

| Symbol | Full name | Default | Bounds |
| --- | --- | --- | --- |
| c | chunkTokens | 512 | integer 64..8192 |
| omega (ω) | overlapTokens | 64 | integer 0..4096, less than c |
| s | shortContextTokens | 32768 | integer 0..1048576 |

For example: `/s1-tune c=512 omega=64 s=32768`. Full names are also
accepted. The persistent tuning file uses full names. Profile fields are
`segmentation.chunkTokens`, `segmentation.overlapTokens` and
`contextSelection.shortContextTokens`.

`s` applies immediately. Changes to `c/omega` are saved for the next plugin
activation: restart DeepSeek Harness and start a new conversation to use them.
Existing graph snapshots keep their recorded segmentation geometry on resume;
legacy snapshots use the historical 512/64 geometry. The panel distinguishes
active values from pending values and reports restart requirements. Per-session
observer status and the wiring record retain the segmentation parameters.

## Calibration for one benchmark suite

Do not grid-search c/omega/s. A review agent examines the DSH baseline's actual
inputs, reasoning, tool outputs, natural semantic boundaries and cross-boundary
dependencies. Aggregate over the same suite to select one c/omega/s tuple from
DSH evidence only, then hold it fixed while
searching r/d/w. Do not tune each task separately or present the best per-task
configuration as one deployable configuration.

Freeze the suite identity, source DSH runs, statistic, bucket width or quantile
definition and final tuple before evaluating the S1CAP grid. S1CAP recall activity
is validation evidence, not a reason to silently retune c/omega/s during that grid.
Moving to another suite requires a new calibration record.

The review records its statistic: median, mode with a declared bucket width, or
`Q(m/n)` with a declared quantile convention. Q(3/4) denotes the 75th percentile.
Use actual input-token counts at the first source modification when calibrating
s; step numbers are diagnostic and cannot be converted directly to tokens. Use
natural semantic-unit sizes and the context needed across boundaries when
calibrating c/omega. A suite statistic is a defensible initial setting, not proof
of global optimality. Validate the frozen tuple on separate examples or repeats
alongside a fresh DSH baseline; preserve completion quality when comparing time
and cost. No benchmark is started by changing settings.

Reasoning segmentation keeps natural paragraphs first, uses sentence boundaries
when a paragraph is too long, and falls back to token-bounded spans only when
there is no usable sentence structure. The fallback now converts heuristic token
budgets to Unicode-safe spans, and packing accounts for inserted separators.

Motivation: the caplog trial removed a critical phase-registration source excerpt
before step 6 at roughly 13K actual input tokens, then recalled it at step 7.
The policy prevents that unnecessary early deletion. It does not establish a
causal speedup, eliminate later selection errors, or validate chunk boundaries.
