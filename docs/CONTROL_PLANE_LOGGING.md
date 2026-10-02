# Control-Plane Logging (System-1 isolation)

**Hard rule:** System-1 calls (Jev / Laya / EdgeJev / Kev) are recorded in a log stream that is
**independent of the session event log**. No control-plane record may become a segment, enter the
association graph, or appear in any context or `state` that System-1 is asked about.

Code: [`packages/core/src/provenance.ts`](../packages/core/src/provenance.ts) ·
Tests: [`packages/core/test/provenance.test.ts`](../packages/core/test/provenance.test.ts).

---

## 1. The hazard

Segments are the input to relevance scoring, and relevance scoring is a System-1 call. If a
System-1 call record were written into the session event stream, the pipeline would close a loop:

```
S1 call ──► control record ──► (if it were a session event) segment ──► recall scoring ──► S1 call ──► …
```

Each turn would add new S1-generated material that the next turn scores, so the number of System-1
calls per turn grows with the number of calls already made: unbounded cost, unbounded latency, and a
graph whose edges mostly describe the control layer's own bookkeeping. This is the "observer observed"
failure mode, and it is a correctness problem before it is a cost problem.

## 2. Two logs, two purposes

| | **Session log** | **Control-plane log** |
|---|---|---|
| Written by | the harness adapter (append-only, from harness events) | the plugin: LLM/S1/tool calls, assembly, gate decisions |
| Contents | user turns, assistant messages, reasoning traces, tool calls/results, pinned system text | timing, counts, token usage, cost, routing, answers/decisions, correlation ids |
| Read by | SEGMENTER → RECALL → RG → ASSEMBLER | humans and analysis scripts only |
| Feeds System-1 | **yes** — as segments/state | **never** |
| Rewritable | no (append-only) | no (append-only) |
| File (plugin default) | `./.s1cap/session.jsonl` | `./.s1cap/control.jsonl` |

Splitting the *sinks* is what makes the rule enforceable: the two streams never share a writer,
a schema, or a reader.

## 3. Enforced invariants

| # | Invariant | Enforcement |
|---|---|---|
| **I1** | Telemetry records and session events are different type families (`type` vs `kind`) | TypeScript types: `TelemetryEvent` is not assignable to `RawEvent` — the compiler rejects the mix-up |
| **I2** | The segmenter refuses control-plane shapes at runtime | `segmentEvent` calls `assertSessionEvent` → `ControlPlaneLeakError`; unknown `kind`s are rejected too, so a new control-plane kind cannot slip in silently |
| **I3** | Anything shown to System-1 or the LLM is session segments only | `assertSessionSegments(...)` gates the assembled view and the `/v1/systemone` state |
| **I4** | The control-plane log never receives session segments and is never read back into the model view | `ControlPlaneLog.emit` rejects segments; the sink is not in any read path of the assembly pipeline |

The allowlist `SESSION_SEGMENT_KINDS = ['user','assistant','trace','toolCall','toolResult','systemPinned']`
is closed: adding a kind to the pipeline requires editing that list, which is the moment to decide
whether the new material is session data or control data.

## 4. Correlation without coupling

Cost and timing must join to turns for the paper, but joining must not move content:

- every S1 record carries `turnId` and `taskId` (ids only);
- `scoredSegmentIds` records *which* segments were scored (ids, capped) so coverage can be analysed;
- `routedModel` records the checkpoint the backend actually chose (e.g. Laya routing to `english`);
- answers/decisions are stored in the control log — they are results, and they are never re-inserted
  into the conversation by the logging system.

## 5. Rules for the plugin surface

- `/s1 laya status` and `/s1 laya discover` print a **compact** status (state, base URL, interpreter,
  last error). Raw backend stdout/stderr stays a bounded diagnostic buffer (`LayaServer.logs`, 50 lines)
  and is never pasted into the transcript as a tool result deliberately fed back to the model.
- The agent is never instructed to read the control log. If it reads the file as a tool call, that tool
  *result* is ordinary session material — the log's contents are not privileged, but the plugin must not
  route them back to System-1 on its own initiative.
- Telemetry writing must not emit harness events: the sink takes a plain write callback and lives outside
  the session/surface machinery.
- Keep both files inside a git-ignored directory (`./.s1cap/`), and rotate them; the control log grows with
  every call, which is intentional but must not grow without bound on long runs.

## 6. What this buys

- **No self-excitation:** System-1 never scores its own output, so per-turn S1 cost is a function of
  session content, not of history length in calls.
- **Budget accounting that stays honest:** the cost model reads S1 usage from the control log, so
  governance cost can be reported separately from task cost (a headline number for the ablation — the 2×2 crossing
  run as three arms, whose registered contrast `C0` vs `C2` measures the recall lane while the ordering factor is
  recorded and delivered by no cell).
- **Reproducibility:** the two logs together are a complete, replayable record — session content and
  governance decisions — without either contaminating the other.

## 6. What observation mode writes today (M1)

`observation: log` (the default when the plugin is enabled) runs SEGMENTER → RECALL → ASSEMBLER on **every**
LLM call and appends one `assembly` record per call. The prompt the model receives is returned untouched:
this milestone changes no tokens, which is what makes it safe to run against a live session.

A real record from a DSH **0.1.7-rc.2** round (2026-09-28; `~/.dsh/.s1cap/control.jsonl`, relative paths resolve
against `DSH_HOME`). The release is part of the record's meaning, so it is stated: this is evidence about that
line, and the fields it lacks are not fields the record never had. Beside it, what the release in use writes.
The live pre-flight of the 2026-10-02 round (DSH **0.2.0-rc.2**, `observation: tape`, its telemetry paths pointed
into the round's own `evidence/PROBE/`) wrote **both** streams: 22 `control.jsonl` records — `assembly` ×4,
`context_delivery` ×4, `s1_call` ×14 — and 15 `session.jsonl` lines, all parseable. Here is that instance's last
`assembly` record, verbatim:

```json
{"windowN":1024,"scoredPairs":55,"judgedPairs":55,"type":"assembly","schema":1,"ts":1790944753873,"sessionId":"…","seq":12,"candidates":0,"selected":10,"bfsDepth":0,"budgetUsed":2537,"budgetTotal":118800,"blocks":{"pinned":1499,"stateProxy":31,"recalled":633,"tail":119,"anchor":255},"prefixTokensStable":1499,"layoutOrder":["pinned","stateProxy","anchor","recalled","tail"],"xFirst":true,"layoutStableTokens":1785,"cutAfterBlock":"anchor","tokensAfterCut":752,"recallTree":{},"fallback":"recency-window"}
```

The schema is **additive** across those two releases, which is the rule this document opens with: the fields the
older sample has are all still there, and 0.2.0-rc.2 adds `windowN`, `scoredPairs`/`judgedPairs`, `layoutOrder`,
`xFirst`, `layoutStableTokens`, `cutAfterBlock`/`tokensAfterCut` and `recallTree`. Two of the added fields answer
questions the sample below left open: `blocks.pinned` is **1499** (and `prefixTokensStable` equals it), where the old
sample had 0; and `scoredPairs == judgedPairs` (55/55 here, 0/21/28/55 across the four steps) is the per-step form
of the coverage number the report prints.

The contrast is the point of keeping both, so the 0.1.7-rc.2 record is reproduced unchanged:

```json
{"type":"assembly","schema":1,"ts":1790601861099,"sessionId":"…","seq":0,"candidates":0,"selected":0,
 "bfsDepth":0,"budgetUsed":7,"budgetTotal":118800,
 "blocks":{"pinned":0,"stateProxy":0,"recalled":0,"tail":0,"anchor":6},"prefixTokensStable":0,
 "fallback":"recency-window"}
```

Three things that round taught us, all now reflected in code:

- **`blocks.pinned` was 0.** The `agent/pre-step` payload's `messages` array did not carry the system prompt
  in this profile, so the pinned block — and with it `prefixTokensStable` — is empty. Sourcing the system
  prompt from the harness's own system-prompt surface is the next block's job; until then the budget
  accounting under-counts the fixed prefix. **On 0.2.0-rc.2 that job is visibly done** — the live record above
  carries `blocks.pinned: 1499` with `prefixTokensStable: 1499` (700/700 at its step 0) — which is why the two
  records are kept side by side rather than one replacing the other.
- **`blocks.stateProxy` was 1 for an absent T.** `estimateTokens('')` returns 1 by design (a text estimate is
  never zero), so an empty state proxy was charged a token; `assemble()` now charges 0.
- **`sessionId` was missing.** Added to `AssemblyEvent` as an optional field (the schema rule is *add, never
  rename*): without it, records from several sessions sharing one control-plane file cannot be attributed.