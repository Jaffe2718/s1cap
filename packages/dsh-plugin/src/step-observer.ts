/**
 * STEP OBSERVER — the plugin's read-only wiring of M1.
 *
 * Contains the logic (capture the system prompt, keep the graph fresh off the critical path, run the
 * observer, emit the record, keep counters) with no Cordis, no filesystem and no clock of its own: the clock,
 * the scheduler and the emit function are injected. That keeps the plugin's tests deterministic and the
 * wiring in `index.ts` a few lines.
 *
 * Nothing here can change a round: `observe()` never throws, never rewrites the payload, and is called
 * *after* the harness's own middleware chain produced its decision.
 *
 * Upkeep does not *start* inside `observe()`: new session events go into a bounded queue and are folded into the
 * graph on a later tick, where today they are folded in **and not scored** - see `step-observer.ts`'s queue handler
 * for why the eager sweep is gone.
 *
 * **Scoring is on-demand (2026-10-05): a pair is bought because a step's recall asked for the row that holds it.**
 * `waitForAnchorRow` no longer waits on a sweep somebody else is running; it *starts* the walk
 * (`AssociationGraph.recallDemand`) and watches the anchor's own row, which is that walk's first level. The walk
 * expands level by level and asks for the rows of the nodes each level stands on, so a node with no neighbour above
 * `tau` is never expanded and its neighbours' rows are never scored - the branch is not computed. `recall.anchorWaitMs`
 * keeps its meaning (the bound on how long the *step* waits, `0` disables the wait) and the fail-open rule in
 * `assemble()` keeps its own (what the step reads when the row did not arrive); what changed is that the rows behind
 * the anchor are now bought by the walk rather than by the arrival order.
 *
 * **Waiting alone was not enough, and the round that shows it is `20261004-1239`.** Its tape carries 26
 * `anchor-wait` lines: steps 2-8 `completed`, steps **9-26 `gave-up`** after the full 10 s each - because upkeep
 * walked the append order from its *oldest* unsettled entry and the anchor is the newest, so the row the step is
 * rooted on was never offered at all (the cursor had reached 106 of 228; `scores` was a complete triangle over
 * segments 0..105 and nothing above it). Every one of those 18 steps then fail-opened: `candidates` 0,
 * `unknownAdmitted` = `selected`, 21,755 recalled tokens on the last assembly. Naming the anchor to a sweep was the
 * first half (`scoreNew`'s `anchorId`, `packages/core/test/anchor-priority.test.ts`); on-demand scoring is the
 * second, and it removes the reason the first was needed: the walk no longer waits for a sweep to reach its end of
 * the session, it asks for that end first.
 */
import { AssociationGraph, CONTENT_EVENT_TYPES, S1_DEFERRED, adaptSessionEvent, createUpkeepQueue, estimateTokens, extractSystemPrompt, observeStep, segmentEvent } from '@s1cap/core';
import type {
  AssemblyPolicy,
  DemandResult,
  DemandRow,
  RawEvent,
  RgStore,
  S1Deferral,
  Segment,
  StepObservation,
  TelemetryEvent,
  UpkeepQueueStats,
} from '@s1cap/core';
import { isS1capInjected } from '@s1cap/core';
import { scoreDemandRows } from './demand-scheduler.ts';
import { contextVisibility } from './context-delivery.ts';

export interface StepObserverOptions {
  policy: AssemblyPolicy;
  emit(event: TelemetryEvent): void;
  now(): number;
  /** model context window in tokens (harness token meter when available, else the configured default) */
  contextWindow: number;
  reserveOutputTokens: number;
  fixedOverheadTokens: number;
  lambdaMs: number;
  /** how far the graph may lag the session, in turns (policy: rgMaintenance.maxLagTurns) */
  maxLagTurns?: number;
  /**
   * The most pairs one *upkeep sweep* may offer, across every segment it folds in. **No longer passed by the
   * plugin, and no longer read by it**: the eager sweep is gone (the queue handler below does not score), so there
   * is no tick-burst for a budget to bound. It is kept on this interface because `AssociationGraph.scoreNew` still
   * takes it and the replay/window-curve tools and the tests call that method directly - where a burst is exactly
   * what those callers ask for.
   */
  maxPairsPerSweep?: number;
  /**
   * One S1 call per new segment, scoring the whole window at once. Present only when a backend is configured;
   * its absence is what falls the graph back to lexical scoring, so observation mode stays free and offline.
   *
   * `S1Deferral` is a third answer and it is not a failure: the backend is saturated and the window was not
   * offered, so the pairs wait for a later tick rather than being bought from the fallback. The graph holds its
   * cursor and counts them (`packages/core/src/assoc-graph.ts`, `S1_DEFERRED`).
   */
  scoreBatch?: (
    current: Segment,
    candidates: readonly Segment[],
  ) => readonly number[] | undefined | S1Deferral | Promise<readonly number[] | undefined | S1Deferral>;
  sessionId?: string;
  /**
   * Per-session graph persistence. Optional by design: the observer stays free of the filesystem (see the header
   * note), so the plugin injects a store and the tests inject nothing. Without it a restart starts every session
   * with an empty graph and re-pays for scoring the snapshot would have carried.
   */
  rgStore?: RgStore;
  onWarn?(message: string): void;
  onObserved?(summary: string): void;
  /** diagnostic sink; the plugin writes it to the tape file */
  onProbe?(line: Record<string, unknown>): void;
  /**
   * M1 N3: record one tape line per call (opt-in; a tape contains session content).
   *
   * `sessionId` is passed in rather than read back. The plugin used to read it from `stats().sessionId`, which is
   * assigned after `emit` - further down this same function than the call above - so every tape line carried the
   * *previous* step's session id and the first line of a session carried `unassigned`. The handler has the id in
   * hand here, so the id it writes is the id of the step it is writing about (F16.1).
   */
  onTape?(step: number, messages: readonly unknown[], systemPrompt: string | undefined, sessionId: string): void;
  /**
   * The session-content stream (`telemetry.sessionJsonl`): one line per adapted RawEvent. Declared in config but
   * written by nothing was a real gap - a named sink that stays empty reads as a broken feature, and this is the
   * stream the experiment replay is meant to consume. Content only: the control-plane log is a different file,
   * and the two may never merge (I4). Fired from upkeep, where the live conversation actually enters the graph,
   * so the same RawEvent that becomes a segment is the one written here - the two never diverge.
   */
  onSessionEvent?(event: RawEvent): void;
  /** schedule one deferred upkeep tick; injected so tests can drive it by hand */
  schedule?(tick: () => void): void;
  /**
   * The wait used by the bounded anchor wait (`recall.anchorWaitMs`), injected for the same reason as `schedule`:
   * this module keeps no clock of its own (see the header). It defaults to an immediate resolve, so a test that
   * does not inject one never waits - the wait is an exception path, and a test suite that slept for it would be
   * paying the median 15.3 s relevance call it exists to cover for.
   *
   * Note the pairing with `now()`: the deadline is `now() + anchorWaitMs`, and a clock that does not move means the
   * loop can only end when the anchor's row is complete - never by deadline. A caller that injects a sleep which
   * resolves without advancing its own clock therefore has to complete the row, or the step waits for it forever.
   */
  sleep?(ms: number): Promise<void>;
}

export interface StepObserverStats {
  /** Assemblies that needed no scoring because every recorded content segment was already visible. */
  recallVisibleSkips: number;
  /** pre-step calls seen */
  steps: number;
  /** calls that produced a record */
  observed: number;
  /** calls skipped because the payload carried no message list */
  skipped: number;
  /** calls whose messages produced no segment, so there was nothing to assemble (see EmptyStepObservation) */
  empty: number;
  /**
   * Steps that were read into the graph and deliberately not assembled, because the harness's decision carried no
   * messages (see `ObserveOptions.assemble`).
   *
   * Its own counter, and not folded into `empty`, because the two are opposite diagnoses: `empty` is the segmenter
   * failing to understand a payload, `ingestOnly` is the lane correctly declining to pay for a step that cannot
   * receive context. A measured diagnostic round is 275 of these against 2 assembled steps, and a counter that
   * could not tell that from 275 unreadable payloads would hide the finding it exists to show.
   */
  ingestOnly: number;
  /** session events that carried conversation content and were folded into the graph */
  upkeepEvents: number;
  /** session events that carried no conversation (lifecycle notices) */
  upkeepEmpty: number;
  /** segments produced by upkeep, which is where the live history actually comes from */
  upkeepSegments: number;
  /**
   * Session events dropped at ingestion because they are S1CAP's own delivered blocks.
   *
   * Reported rather than silent, because a filter that cannot be seen is a filter that cannot be debugged: the
   * first time this is non-zero in a run, the question is whether delivery is working or looping, and the answer
   * has to be readable from `/s1` rather than inferred.
   */
  upkeepSelfDropped: number;
  /**
   * Pairs the on-demand walk offered to a scorer, across every step's recall.
   *
   * **This counter used to mean "pairs upkeep scored as segments arrived", and on-demand scoring moves it to the
   * other side of the same event.** What it counts now is what a walk asked for: a row is offered because a step's
   * recall reached the segment, so the number is the lane's spend *for the steps that ran* rather than for the
   * session's arrival order. A round reads it against `sum min(i, w)` for coverage (which falls by construction -
   * a pair nobody demanded is never settled) and against the assembly records for cost.
   */
  upkeepScoredPairs: number;
  /**
   * Of `upkeepScoredPairs`, the pairs the backend actually answered. Absent from this object until a verification
   * run reported it as `undefined`: the counter existed on the graph and in every assembly record, and the status
   * route - the one place an operator looks - could not see it. Read together, the difference is the size of the
   * gap between "the window was offered" and "the window was judged".
   */
  upkeepJudgedPairs: number;
  /**
   * Pairs a walk asked for and no backend answered - the demand path's own omission counter.
   *
   * Not `upkeepDeferredPairs`, which is the eager path's accounting of a *suffix* of the append order (and which
   * nothing writes since the eager path is gone from this wiring). A demanded row that gets no answer is released
   * unsettled and asked for again by a later step's walk, so this counts **pairs, once per entry** - the size of
   * the reach the backend cost the step, which is the number that says whether a failing backend is shrinking
   * recall.
   */
  upkeepMissedPairs: number;
  /**
   * Pairs the backend was too busy to be asked about, so upkeep deferred them to a later tick rather than scoring
   * them lexically. Beside `upkeepScoredPairs`, not inside it: the first is what was offered, this is what was
   * held back, and only the two together say how much of the session the backend was actually shown.
   *
   * Under on-demand scoring the admission gate's refusals land on *rows* rather than on arrival-order windows, and
   * the graph counts those in `demandMissedPairs` (carried in the snapshot) - this counter stays for the eager
   * path, which still exists as a method (`scoreNew`) and is what the replay and window-curve tools call.
   */
  upkeepDeferredPairs: number;
  /** observation failures (reported, never thrown) */
  errors: number;
  /** tokens the full history would have sent that the selected view did not */
  lastWouldSaveTokens: number;
  lastSelected: number;
  lastCandidates: number;
  lastSegments: number;
  lastObserveMs: number;
  sessionId: string;
  /** tokens of the rendered system prompt currently pinned (0 while none has been seen) */
  systemPromptTokens: number;
  /** diagnostic lines emitted (probe mode) */
  probes: number;
  /**
   * Steps where the payload's own anchor position and the graph window's disagreed.
   *
   * Counted rather than only sampled, because the tape keeps a bounded number of lines for it: the count is what
   * says "this is on every step" after the lines have stopped, and a reader who saw four lines and a cap would
   * otherwise not know whether the disagreement was rare or universal.
   */
  anchorMismatches: number;
  unknownPartTypes: string[];
  unknownRoles: string[];
  graphSegments: number;
  graphEdges: number;
  /**
   * The most recent contained failure, as text.
   *
   * Every failure on this path is deliberately swallowed so it costs the record and not the session - which is
   * correct, and which also made a real defect invisible: a scorer that threw on every segment showed up as a
   * healthy graph with `errors: 2`, zero edges and zero System-1 calls, and the message itself went to a logger
   * that does not reach the instance log. One string turns that back into a diagnosis.
   */
  lastError: string;
  /**
   * One entry per session graph this process holds. Reported because a shared graph made a segment count of 269
   * look like one long conversation when it was several unrelated ones - the exact confusion this isolates.
   */
  sessions: { sessionId: string; segments: number; edges: number }[];
  upkeep: UpkeepQueueStats;
}

export interface ObserveOptions {
  /** Confirmed model surface plus the decision's pending messages; absent disables the admission shortcut. */
  visibleMessages?: readonly unknown[];
  /**
   * Default true. Pass false when the harness's decision for this step carried no messages.
   *
   * The decision is the harness's answer to "what will be appended to the log for this step", and an empty one
   * means this step sends no request - so there is no context to deliver into, whatever the graph holds. The
   * observation still happens: the payload's messages become segments, because a segment belongs to the session
   * from the moment it arrives and this is one of the two lanes it can arrive on. What stops is the assembly,
   * which is the part that costs the walk and the anchor wait.
   */
  assemble?: boolean;
}

export interface StepObserver {
  /**
   * `agent/pre-step`: observe one LLM call, and hand back what it assembled.
   *
   * Returns a promise because scoring a new segment may be one System-1 call. The caller in `index.ts` awaits
   * it inside its own try/catch, so a rejected scorer still costs the record and never the step. The returned
   * observation carries the layout, which is what lets the caller deliver the view instead of only recording it;
   * `undefined` means there was nothing to assemble - an empty step, or a step the caller asked not to assemble -
   * and the caller then passes the decision through untouched.
   */
  observe(payload: unknown, options?: ObserveOptions): Promise<StepObservation | undefined>;
  /** `session/event`: capture the system prompt and queue the event for asynchronous upkeep */
  noteSessionEvent(event: unknown): void;
  /** N1: the rendered system prompt, read from the harness registry (see system-prompt.ts) */
  setSystemPrompt(text: string, tokens?: number): void;
  /** one bounded diagnostic line (written to the tape), used to read harness shapes we do not know yet */
  probe(line: Record<string, unknown>): void;
  /** drain deferred upkeep now (tests, shutdown) */
  flushUpkeep(): number;
  stats(): StepObserverStats;
}

/**
 * How many `anchor-mismatch` lines one observer may write.
 *
 * Four, and the number is a judgement about the tape rather than about the condition: the disagreement is steady
 * state (see `onAnchorMismatch` below), so its first few instances carry all the shape there is. The count of them
 * is unbounded and reported in `stats().anchorMismatches`.
 */
const ANCHOR_MISMATCH_LINES = 4;

/** The four readings the bounded anchor wait can end on. See `anchorWaitLine` for what each one means. */
export type AnchorWaitOutcome = 'completed' | 'gave-up' | 'not-started';

/**
 * The one diagnostic line a bounded anchor wait writes, and the sentence that goes with it.
 *
 * Split out of `createStepObserver` and exported so the *success* branch can be tested at all. It is the branch
 * that was missing - the first version wrote a line only when the fail-open rule was about to admit unjudged pairs,
 * so every wait that won was silent and the mechanism's effectiveness could not be measured from a round's
 * artifacts, only its failures. Driving that branch through a real observer needs a scoring call that returns
 * while the wait is inside a `drain()`, which a unit fixture cannot produce (the drain is synchronous and the row
 * is read in the same tick); the record it writes is a pure function of six values, so it is tested as one, and
 * the integration tests around it cover the three branches that *are* reachable from the loop.
 *
 * `step` is the number the wait was for, which the line never carried: a tape of `anchor-wait` lines with no step
 * cannot be joined to the assembly records the waits explain.
 */
export function anchorWaitLine(
  outcome: AnchorWaitOutcome,
  step: number,
  waitMs: number,
  polls: number,
  unknown: number,
  started: boolean,
): { line: Record<string, unknown>; message: string } {
  const waited = outcome !== 'not-started';
  return {
    line: {
      schema: 0,
      kind: 'anchor-wait',
      step,
      ms: waitMs,
      polls,
      unknown,
      waited,
      gaveUp: !waited || outcome === 'gave-up',
      outcome,
      // Whether this wait **started** the sweep that scores the anchor's row, as opposed to waiting on a sweep
      // someone else had already started (`step-observer.ts`, `startAnchorSweep`). The field exists because the
      // distinction did not, and the wait could once only hope: round `20261004-1239` waited its full 10 000 ms at
      // 18 consecutive steps and gave up at every one, because upkeep walks the *oldest* unsettled entry and the
      // anchor is the newest. A round reading this can now count how often the priority path engaged and how often
      // it won, instead of inferring it from `polls`.
      started,
    },
    message:
      // **Keyed on the outcome, not on `unknown`.** It used to be `unknown === 0 ? completed-sentence : …`, so a
      // wait that never started and found nothing to admit reported itself as a *completed* wait with no polls -
      // the one thing it cannot be, and the same shape of defect the comment above records for the tape line
      // (`{ms:10000, polls:0, unknown:2}` reading as a completed wait). A stand-down is a stand-down whether or
      // not there was anything left to admit.
      outcome === 'completed'
        ? // The wait did its job. Worth a line and not worth a warning: nothing is wrong, and the number that
          // matters is `polls` - how many drains it took to get the anchor's row judged.
          `[s1cap] anchor wait completed after ${waitMs}ms (${polls} drain(s)): the anchor's row is judged, ` +
          'so the fail-open rule admits nothing on this step' +
          (started ? ' (the wait named the anchor to a sweep of its own)' : '')
        : waited
          ? `[s1cap] anchor wait gave up after ${waitMs}ms (${polls} drain(s)): ` +
            `${unknown} pair(s) inside the window still unjudged; the fail-open rule admits them` +
            (started ? " (the wait named the anchor to a sweep of its own, which had not answered by the deadline)" : '')
          : `[s1cap] anchor wait not started (${waitMs}ms available): nothing queued and no scoring call in flight, ` +
            'and no batch scorer to start one, so the anchor\'s own row cannot be completed by waiting; ' +
            `the fail-open rule admits its ${unknown} pair(s)`,
  };
}

function readMessages(payload: unknown): readonly unknown[] | undefined {  if (typeof payload !== 'object' || payload === null) return undefined;
  const messages = (payload as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : undefined;
}

function readStep(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const step = (payload as { step?: unknown }).step;
  return typeof step === 'number' && Number.isFinite(step) ? step : 0;
}

/**
 * Opportunistic session id: the payload carries `agent`, and a session exposes an id. Read defensively — an
 * absent id only costs correlation in the control-plane log, never correctness.
 */
function readSessionId(payload: unknown, fallback: string): string {
  if (typeof payload !== 'object' || payload === null) return fallback;
  const agent = (payload as { agent?: unknown }).agent;
  if (typeof agent !== 'object' || agent === null) return fallback;
  const session = (agent as { session?: unknown }).session;
  if (typeof session !== 'object' || session === null) return fallback;
  const id = (session as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : fallback;
}

/** The session event's own type, e.g. `turn/end`. Absent for a payload that is not a session event. */
function readEventType(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' && type !== '' ? type : undefined;
}

export function createStepObserver(opts: StepObserverOptions): StepObserver {
  // One graph per session, and nothing shared between them.
  //
  // This used to be a single `new AssociationGraph()` for the lifetime of the activation, on the theory that the
  // observer outlives sessions. It does — and that was the bug, not the mitigation: a "new chat" in the same host
  // process started with the previous conversation's segments already in the graph, so the very first recall of a
  // fresh session could retrieve out of an unrelated conversation, and every measurement of the intervention was
  // contaminated by whatever had run before it in that window.
  //
  // The store, when one is supplied, makes a session's graph survive a restart. Without it the behaviour is the
  // same per-session isolation, just in memory only — so the store is an optional surface, not a dependency.
  const graphs = new Map<string, AssociationGraph>();
  const graphFor = (sessionId: string): AssociationGraph => {
    const known = graphs.get(sessionId);
    if (known !== undefined) return known;
    const resumed = opts.rgStore?.load(sessionId);
    const created = AssociationGraph.fromSnapshot(resumed);
    graphs.set(sessionId, created);
    if (resumed !== undefined) {
      opts.onWarn?.(
        `[s1cap] session ${sessionId} resumed its graph: ${created.segmentCount} segments, ${created.edgeCount} edges, scoring cursor at ${resumed.scored}`,
      );
    }
    return created;
  };
  // Persisted at the points where the graph actually changed: after upkeep, and after a turn boundary drains.
  // Per-step writes would rewrite the whole snapshot for a graph that a step does not touch.
  const persistGraph = (sessionId: string): void => {
    if (opts.rgStore === undefined) return;
    const graph = graphs.get(sessionId);
    if (graph !== undefined) opts.rgStore.persist(sessionId, graph.snapshot());
  };
  /** Per-session T memos; forked sessions may share the same task event id. */
  const proxyCaches = new Map<string, { id: string; text: string }>();
  /**
   * The recalled block's order, one array per session, alive for as long as the observer is. `assemble()` mutates
   * the array in place to the order the block was laid out in, so what is stored here is the *previous step's*
   * order, which is exactly what the next step reads (`AssembleInput.recallOrder`).
   *
   * **Per session, unlike `proxyCache` directly above, and the difference is not tidiness.** A T memo is keyed on
   * the task segment's id, so another session's task cannot match it; a block order is a bare list of segment ids
   * with nothing in it that says which session it came from, so one array shared by two sessions would hand one
   * session's block order to the other. This map is keyed on the same id the graph map above is, so the two cannot
   * disagree about what a session is.
   *
   * Nothing persists it. A restart loses the order and the next step lays the block out in the deterministic
   * fallback order (`assembler.ts`, `AssembleInput.recallOrder`); what it costs is one step of ordering stability,
   * not a segment, and a store for it would have to be another file in the profile for a cache-only quantity.
   */
  const recallOrders = new Map<string, string[]>();
  const recallOrderFor = (sessionId: string): string[] => {
    const known = recallOrders.get(sessionId);
    if (known !== undefined) return known;
    const created: string[] = [];
    recallOrders.set(sessionId, created);
    return created;
  };
  let systemPrompt: string | undefined;
  let systemPromptTokens = 0;
  let scheduled = false;
  const stats: StepObserverStats = {
    recallVisibleSkips: 0,
    steps: 0,
    observed: 0,
    skipped: 0,
    errors: 0,
    lastWouldSaveTokens: 0,
    lastSelected: 0,
    lastCandidates: 0,
    lastSegments: 0,
    lastObserveMs: 0,
    sessionId: opts.sessionId ?? 'unassigned',
    systemPromptTokens: 0,
    probes: 0,
    unknownPartTypes: [],
    unknownRoles: [],
    empty: 0,
    ingestOnly: 0,
    anchorMismatches: 0,
    upkeepEvents: 0,
    upkeepEmpty: 0,
    upkeepSegments: 0,
    upkeepSelfDropped: 0,
    upkeepScoredPairs: 0,
    upkeepJudgedPairs: 0,
    upkeepMissedPairs: 0,
    upkeepDeferredPairs: 0,
    graphSegments: 0,
    graphEdges: 0,
    lastError: '',
    sessions: [],
    upkeep: {
      enqueued: 0,
      applied: 0,
      dropped: 0,
      errors: 0,
      pending: 0,
      flushes: 0,
      overLag: false,
      maxLagTurns: opts.maxLagTurns ?? 2,
    },
  };
  /** own monotonic sequence: the harness's session-log sequence is not exposed on the pre-step payload */
  let seq = 0;
  let announcedShapes = false;
  let eventProbes = 0;
  /** session-event types already probed; one shape line each, so the budget lands on distinct shapes */
  const probedTypes = new Set<string>();

  const schedule =
    opts.schedule ??
    ((tick: () => void): void => {
      const timer = setTimeout(tick, 0);
      // never hold the process open just to drain a queue
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    });

  // An injected sleep, or none at all. The default resolves immediately *on purpose*: the anchor wait is an
  // exception path, and a test that reached it without injecting a clock would otherwise sit for the full
  // `anchorWaitMs` against a fixture that can never finish scoring.
  const sleep = opts.sleep ?? ((): Promise<void> => Promise.resolve());

  // The bounded anchor wait (`recall.anchorWaitMs`): at most one diagnostic line per step, and **one line per
  // outcome, successes included**.
  //
  // The first version wrote a line only when the fail-open rule was about to admit unjudged pairs - the stand-down
  // and the give-up - so every wait that *succeeded* was silent, and the mechanism's effectiveness could not be
  // measured from a tape at all: only its failures were on record. The measured round shows what that costs. Its
  // tape holds exactly one `anchor-wait` line, `{ms:10000, polls:0, unknown:2}`, written before the first step
  // tape line: the stand-down branch, on step 1, out of 277 steps. `recall.anchorWaitMs: 10000` therefore never
  // polled once in the whole round, and nothing on the tape could say whether it ever would have - "the wait ran
  // and cleared the row after N drains" is the number that decides whether the knob is worth its place, and it was
  // unobtainable.
  //
  // The poll count is what makes a stuck wait legible - a line per poll would be hundreds of lines for one slow
  // backend - and no line at all would leave `unknownAdmitted` in the record with nothing explaining it.
  //
  // Three outcomes reach the *loop* and the record distinguishes all three, because they are not the same event
  // and used to be written identically. `waited` is the wait that ran and lost: polling happened and the deadline
  // or the poll ceiling arrived with the row still incomplete. `not-started` is the wait that was never worth
  // taking: nothing was queued and no scoring call was in flight, so no amount of time could have completed the
  // row. `completed` is the wait that ran and won - the row is judged by the backend and the fail-open rule has
  // nothing to admit. The tape from a real round carries `{ms:10000, polls:0, unknown:2}` - a line that reads as a
  // completed wait with no polls, which is the one thing it cannot be - and the step proceeded down the fail-open
  // path with nothing saying that the fail-open path is what happened. `gaveUp` states the outcome for a reader
  // with no code in front of them, and `step` says which step it was about, which the probe line never carried.
  //
  // The fourth outcome - the anchor's row was already judged when the wait was called, i.e. `unknownBefore === 0`
  // - stays silent, and that is deliberate rather than an omission: it is the ordinary case (one `indexOf` plus a
  // map lookup, and it returns before any poll), and a line per step for it would bury the outcomes that are worth
  // reading. A round whose wait never had anything to do therefore shows *no* `anchor-wait` lines at all, which is
  // itself the reading: the knob was never exercised.
  //
  // The line and its sentence are built by `anchorWaitLine` above, so the success text is covered by a test rather
  // than by a fixture that cannot reach it.
  const reportAnchorWait = (
    probe: (line: Record<string, unknown>) => void,
    step: number,
    outcome: AnchorWaitOutcome,
    waitMs: number,
    polls: number,
    unknown: number,
    started: boolean,
  ): void => {
    const { line, message } = anchorWaitLine(outcome, step, waitMs, polls, unknown, started);
    probe(line);
    opts.onWarn?.(message);
  };

  /**
   * The on-demand walk's scorer: the rows one level of the walk needs in, one weight list per row out.
   *
   * Rows run in a bounded pool at the existing admission limit. A level can
   * contain several rows; its latency need not be their serial sum. Each worker
   * checks the walk's deadline before taking another row. An admitted call still
   * uses the client's own timeout/retry policy and may finish after the deadline.
   *
   * A row the scorer does not answer is reported as `undefined` and the graph releases it **unsettled** - no
   * lexical row is written in its place - so a later step's walk asks for it again. That is the one deliberate
   * difference from the eager sweep's fallback: the sweep had to keep the session's cursor moving, while a walk
   * that loses its backend only loses reach, and the fail-open rule in `assemble()` is what covers the step's own
   * anchor. `S1_DEFERRED` - the admission gate's "not now" - is reported the same way, and is counted by the graph
   * as a demanded pair that got no answer rather than as `deferredPairs` (which is the eager path's accounting).
   */
  const scoreDemandedRows = async (
    rows: readonly DemandRow[],
    deadline: number,
  ): Promise<readonly (readonly number[] | undefined)[]> => {
    if (opts.scoreBatch === undefined) return rows.map(() => undefined);
    return scoreDemandRows(rows, opts.scoreBatch, {
      concurrency: opts.policy.s1.admissionLimit,
      canStart: () => opts.now() < deadline,
      onError: (row, err) => {
        stats.errors += 1;
        stats.lastError = `demand scoring for ${row.id}: ${String(err)}`;
      },
    });
  };

  /**
   * **The whole of on-demand scoring, from the plugin's side**: the step's anchor is handed to the graph's walk,
   * which asks for the rows it needs level by level - the anchor's own first, then the rows of what the anchor
   * found, and so on, backwards - and stops where a node has no neighbour above `tau`. A pair is scored because
   * this walk asked for the row that holds it, and for no other reason.
   *
   * **Not awaited.** The walk is multi-round-trip by construction (one level, one call), so `recall.anchorWaitMs`
   * is what bounds how long the *step* waits for it - the loop in `waitForAnchorRow` watches the anchor's own row,
   * and everything the walk buys after that lands in the background for the steps that follow. A step that awaited
   * the whole walk would sit for as many calls as the walk has levels, which is minutes at the measured median.
   *
   * The tape line is written **when the walk settles**, tagged with the step that started it, because the numbers
   * a round needs to read are the walk's own: how many rows it asked for, how many pairs those were, how many the
   * backend judged, how many got no answer, and why it stopped. Without it the saving this whole design exists for
   * would be visible only as a smaller `scoredPairs` on the next assembly record, with nothing saying where it
   * went. `stats.upkeep*Pairs` are updated from the same result, where the anchor sweep's used to be counted -
   * same scorer, same graph, same policy, so a panel that counted one lane and not the other would make the
   * coverage ratio depend on which mechanism happened to reach a pair.
   */
  const demandWalk = (
    graph: AssociationGraph,
    sessionId: string,
    anchorId: string,
    probe: (line: Record<string, unknown>) => void,
    step: number,
    waitMs: number,
  ): Promise<DemandResult | undefined> => {
    const started = opts.now();
    const deadline = waitMs > 0 ? started + waitMs : Number.POSITIVE_INFINITY;
    return graph
      .recallDemand(
        [anchorId],
        {
          threshold: opts.policy.recall.threshold,
          depth: opts.policy.recall.depth,
          lambdaMs: opts.lambdaMs,
          now: opts.now(),
          window: opts.policy.recall.window,
        },
        opts.scoreBatch === undefined ? undefined : (rows) => scoreDemandedRows(rows, deadline),
        // Checked between levels and before each new row. Already admitted work
        // may finish after the deadline. `anchorWaitMs = 0` disables the wait, not recall: the walk then runs
        // unbounded in the background, which is exactly "scoring starts when the BFS recall is called" with no
        // step waiting on it. With no batch scorer the walk is local and synchronous and the budget is moot.
        opts.scoreBatch !== undefined && waitMs > 0 ? () => opts.now() < deadline : undefined,
      )
      .then(
        (result) => {
          stats.upkeepScoredPairs += result.pairs - result.missedPairs;
          stats.upkeepJudgedPairs += result.judged;
          stats.upkeepMissedPairs += result.missedPairs;
          // **The walk is a writer, so it is a persistence point.** It settles rows *after* the step that started
          // it has returned (that is what "not awaited" means), and the step's own `persistGraph` has already run by
          // then - so a process that died between the two would leave the snapshot without the pairs it had just
          // paid for, and the next start would buy them again. Measured on the restart fixture: the first process
          // settled its rows and its snapshot held none of them.
          persistGraph(sessionId);
          probe({
            schema: 0,
            kind: 'recall-demand',
            step,
            anchor: anchorId,
            ms: Math.max(0, opts.now() - started),
            levels: result.levels.length,
            rows: result.rows,
            pairs: result.pairs,
            judged: result.judged,
            missed: result.missed,
            missedPairs: result.missedPairs,
            skipped: result.skipped,
            stop: result.stop,
          });
          return result;
        },
        (err) => {
          // `recallDemand` releases every claim it holds on the way out, so a failed walk leaves no entry owned;
          // what it costs is the walk's own accounting and the record says so.
          stats.errors += 1;
          stats.lastError = `demand walk: ${String(err)}`;
          probe({ schema: 0, kind: 'recall-demand', step, anchor: anchorId, error: String(err) });
          return undefined;
        },
      );
  };

  const waitForAnchorRow = async (
    probe: (line: Record<string, unknown>) => void,
    step: number,
    sessionId: string,
    anchorId: string,
  ): Promise<void> => {
    const waitMs = opts.policy.recall.anchorWaitMs;
    const graph = graphFor(sessionId);
    const windowN = opts.policy.recall.window;
    // **A cell that never recalls never scores.** With `recall.tier1: 'off'` the assembler builds no recall block
    // at all (`assembler.ts`), so a walk here would buy rows nothing reads - which is the eager path's defect
    // arrived at from the other side. The old wiring did start a sweep on this path regardless, because upkeep was
    // scoring the whole session anyway and one more sweep changed the order rather than the cost; with demand-driven
    // scoring the walk *is* the cost, so it follows the knob that decides whether there is a recall to serve.
    // C0 and C1 in this build resolve that way (and have no lane either), so their graphs now record the arrival
    // order and no pairs - which is what a cell whose whole design is "no recall selection" should cost.
    if (opts.policy.recall.tier1 === 'off') return;
    // The graph has to hold every segment the walk is about to ask about, and the session-event stream is the lane
    // most segments arrive on. Under eager scoring this drain was what let the queue's in-flight `scoreNew`
    // finish; under on-demand scoring the queue's handler no longer scores, and what the drain is for is that the
    // newest events are *nodes* before the walk looks for them.
    queue.drain();
    const canJudge = opts.scoreBatch !== undefined;
    // Read once, before the walk: it is what the *report* is about, and it is the old early-return's question
    // ("was there anything to wait for?"). The walk itself is not conditional on it - the rows behind the anchor
    // are as unscored as they ever were, and asking for them is the mechanism - but a step whose anchor is already
    // judged and whose walk found nothing unknown has nothing to report, and the silent case is the ordinary one.
    const unknownBefore = graph.unjudgedWithin(anchorId, windowN).length;
    // Whether this wait can *cause* the anchor's row, as opposed to only waiting for it. A batch scorer is the
    // difference: without one, every row the walk writes is lexical, and `unjudgedWithin` counts a lexical row as
    // unjudged - correctly, since a failed System-1 call writes one too - so no amount of time could complete it.
    // This used to be spelled "no batch scorer *and* an empty queue *and* nothing in flight", which was a proxy for
    // the same fact while the queue was where scoring happened; the fact itself is this one line.
    if (!canJudge) {
      // Nothing in this process can judge a pair, so there is nothing to wait for - but the *recall* still
      // happens, and so does the graph it scores. The walk is local, synchronous and free here: running it is what
      // keeps a session with no System-1 lane working, which is what the queue's own lexical fallback used to do
      // as segments arrived. The outcome is `not-started`, and the remainder it reports is re-read *after* the
      // walk, because that is the number the fail-open rule will actually see.
      await demandWalk(graph, sessionId, anchorId, probe, step, 0);
      const unknownAfter = graph.unjudgedWithin(anchorId, windowN).length;
      if (unknownBefore > 0 || unknownAfter > 0) {
        reportAnchorWait(probe, step, 'not-started', waitMs, 0, unknownAfter, false);
      }
      return;
    }
    // `0`, or anything below it, disables the wait: the panel sets this, and a researcher turning it off must get
    // the step's own timing back rather than a small wait. The walk is still started - scoring begins when the
    // recall is called, which is what on-demand scoring means - but the step does not wait for a single row of it,
    // and nothing is reported, because the wait was not asked for.
    if (!(waitMs > 0)) {
      void demandWalk(graph, sessionId, anchorId, probe, step, waitMs);
      return;
    }
    // The walk is scoring the anchor's row as its first level, so the loop below no longer starts a sweep of its
    // own - it watches the one the design requires, and the deadline is the same deadline the walk's budget is
    // bounded by. `started: true` says exactly that: the wait is the walk's, and the row it is waiting for is being
    // bought.
    const walk = demandWalk(graph, sessionId, anchorId, probe, step, waitMs);
    if (unknownBefore === 0) return;
    const deadline = opts.now() + waitMs;
    // A poll ceiling as well as a deadline, because the deadline came from the injected clock: a caller whose `now()`
    // does not advance would otherwise spin on a resolved sleep until something else stopped it. At the documented
    // 50 ms interval, `waitMs` allows `waitMs / 50` polls, so a real wait is never cut short by this.
    const maxPolls = Math.max(1, Math.ceil(waitMs / 50)) + 1;
    let polls = 0;
    let unknown = 0;
    for (;;) {
      // Draining keeps the graph's node set current while the walk is in flight - the walk is asking for rows of
      // segments, and a segment still queued is not a node yet. It no longer *drives* the scoring: the walk does
      // that itself, which is why the sleep below is now the only thing this loop needs and the poll count is a
      // count of round trips the row took rather than of drains that happened to find it.
      queue.drain();
      polls += 1;
      // Re-read after the drain, because the row may have completed inside it.
      unknown = graph.unjudgedWithin(anchorId, windowN).length;
      // The success is an outcome and belongs on the tape: without this line the only waits anyone can count are
      // the ones that failed, so "the wait works" was unfalsifiable from a round's own artifacts.
      if (unknown === 0) {
        reportAnchorWait(probe, step, 'completed', waitMs, polls, 0, true);
        return;
      }
      // The deadline is tested *before* the sleep, not after it, so that the row is re-read between the last sleep
      // and giving up. The first version tested it after the sleep and broke straight out of the loop, which made the
      // sleep the final act: work completed during it was thrown away and the diagnostic below reported a remainder
      // that was already judged. Measured on a fixture whose drain completes the row, that turned a finished wait
      // into a reported failure.
      if (polls >= maxPolls || opts.now() >= deadline) break;
      await sleep(50);
    }
    // Giving up is not a failure: assembly carries on, and the pairs it could not wait for are counted as
    // `unknownAdmitted`. The wait makes the fail-open rule rarer; it does not replace it - and the walk it started
    // is not cancelled here, so the rows it named are still being bought while the step assembles and are there for
    // the next step that recalls from them. `walk` is deliberately not awaited here: the deadline is the step's,
    // not the walk's, and the walk's own tape line is written when it settles.
    void walk;
    reportAnchorWait(probe, step, 'gave-up', waitMs, polls, unknown, true);
  };

  // The queued unit is an event *plus the session it belongs to*. The id is captured at enqueue time, in the
  // handler that received the event, and travels with the item: reading `stats.sessionId` at drain time attributed
  // a late-draining event to whichever session happened to be current then, which is exactly the cross-session
  // leak this is here to close.
  //
  // `waitForAnchorRow` above drains this queue, and reads it at call time rather than at definition time: a step is
  // observed long after `createStepObserver` has returned, so the binding is always initialised by then.
  const queue = createUpkeepQueue<{ sessionId: string; event: unknown }>({
    maxLagTurns: opts.maxLagTurns ?? 2,
    onWarn: (message) => opts.onWarn?.(message),
    onEvent: async (item) => {
      const event = item.event;
      const sessionId = item.sessionId;
      const graph = graphFor(sessionId);
      // Asynchronous upkeep, which is what the session-event stream is FOR: adapt, segment, fold into the
      // graph, score the new segment against the last w. No assemble happens here - this is not a step, and
      // assembling per event would be both wrong and expensive. The model view is assembled once, at pre-step.
      //
      // The previous version ran a full observeStep() per event on the raw event wrapper. That could only ever
      // produce zero segments - a session event has no `role`, so the adapter reported the shape as unknown and
      // dropped it - which is why the graph was empty in live sessions and every recall count read zero.
      const now = opts.now();
      const { events: raw, report } = adaptSessionEvent(event, {
        sessionId,
        startSeq: seq,
        now,
      });
      for (const type of report.unknownPartTypes) {
        if (!stats.unknownPartTypes.includes(type)) stats.unknownPartTypes.push(type);
      }
      for (const role of report.unknownRoles) {
        if (!stats.unknownRoles.includes(role)) stats.unknownRoles.push(role);
      }
      if (raw.length === 0) {
        // Lifecycle events (step/start, turn/end, request/header, delivery notices) land here by design.
        //
        // `todo/write` lands here too, and it is worth saying what happened to it: it carries no message, so it
        // adapts to nothing, and it used to be read here for the plan gate. The gate is gone from the policy
        // (`packages/core/src/types.ts` says why: round `20261002-2037` produced zero `plan_gate` records because
        // the model never wrote a plan in either of the two forms the gate could read). Nothing replaces it on
        // this path; the todos are still the model's own plan, and a future arm that wants to order them has to
        // wire a gate back in and feed it from here.
        stats.upkeepEmpty += 1;
        return;
      }
      // The ingestion gate, on the path production actually takes.
      //
      // A context block S1CAP delivered is appended to the session log by the harness, so it arrives here as an
      // ordinary user message on the very next event. It must not become a segment: that would put S1CAP's own
      // text into the graph, and from there into the recall candidates (relevance would re-select a summary of
      // the conversation), into the verbatim tail, and into `fullTokens` — the denominator of
      // `wouldSaveTokens`, which would make the headline saving self-referential. The method manages which of
      // the harness's own context is in the prompt; its own output is not part of that accounting.
      //
      // The host keeps its copy in the log and builds the request from the log, so the model still reads what
      // was delivered. The session-content stream below is still fed these events, because that file is a
      // faithful record of the session and not a view of what S1CAP chose to measure.
      const ingestable = raw.filter((ev) => !isS1capInjected(ev.id));
      stats.upkeepSelfDropped += raw.length - ingestable.length;
      const segments = ingestable.flatMap((ev) => segmentEvent(ev));
      graph.addSegments(segments);
      // The session-content stream, written from the same RawEvents that just entered the graph, so the file and
      // the graph can never disagree about what the session said. A throw here costs the stream line, not the
      // segment or the round - the same containment every other optional surface gets.
      if (opts.onSessionEvent !== undefined) {
        for (const ev of raw) {
          try {
            opts.onSessionEvent(ev);
          } catch (err) {
            stats.errors += 1;
            opts.onWarn?.(`[s1cap] session stream write failed (ignored): ${String(err)}`);
          }
        }
      }
      // **Upkeep no longer scores, and that is the design rather than a saving on top of it.** It used to call
      // `scoreNew` here, once per event, which is what made scoring *eager*: every segment was scored against its
      // window as it arrived, oldest-first, whatever any walk would later need - and on a lane that settles pairs
      // slower than the session produces them (round `20261004-1239`: 15.1 pairs/s against 70.1/s) the segments a
      // step actually recalls from were the last to be offered, which is why 19 of that round's 26 assemblies
      // found nothing. Demoting this call - keeping it for the anchor only, say - would leave the lane's throughput
      // where it was and the saving would be a fraction of the volume; removing it is what makes the scoring
      // demand-driven. The ingestion above is deliberately *not* removed: a segment belongs to the session from the
      // moment it arrives, and the step's walk asks the graph for rows of segments, so the queue is still the lane
      // that keeps the graph's node set current - off the step's critical path, which is what it is for.
      stats.upkeepEvents += 1;
      stats.upkeepSegments += segments.length;
      // The graph changed here and nowhere else on this path, so this is the point to make it survive. Written
      // per upkeep event rather than per step: a step only reads.
      persistGraph(sessionId);
      stats.graphSegments = graph.segmentCount;
      stats.graphEdges = graph.edgeCount;
      seq += raw.length;
      // The advisory plan gate used to be asked here, once per `assistant`/`trace` RawEvent, and the code that
      // did it is gone with the policy field. `packages/core/src/types.ts` carries the evidence for the removal:
      // the gate's record appears in no artifact of round `20261002-2037`, because the model wrote no numbered
      // plan and emitted no `todo/write`, so there was never anything to order. Note for whoever wires a gate
      // back: both kinds must be offered - a message whose parts are only text adapts to `assistant`, and one
      // carrying reasoning *and* text, which is what this model emits, adapts to `trace` with both merged.
      // Filtering on `assistant` alone inspects nothing while the model writes numbered plans the whole time.
    },
  });

  function tick(): void {
    scheduled = false;
    // The queue is synchronous in shape (bounded drain, counted failures) and its handler may be async. The
    // handler's own promise is caught inside the queue, so nothing escapes this timer.
    queue.flush();
  }

  // The diagnostic sink as a plain function, so the anchor wait can reach it without going through the object being
  // built here. `this.probe` inside `observe` would have worked at call time, and `observe` is called as a method -
  // but that is exactly the kind of thing the erasure-only build cannot check, so it is not relied on.
  const writeProbe = (line: Record<string, unknown>): void => {
    stats.probes += 1;
    opts.onProbe?.(line);
  };

  return {
    /**
     * Observe one step and return what it assembled, or `undefined` when nothing was assembled.
     *
     * The return value exists for context delivery: the caller needs the layout's segments, not just the
     * token counts in the record, to be able to put the view in front of the model. It is `undefined` on the
     * empty, failed and skipped paths, and none of those throws.
     */
    async observe(payload: unknown, options?: ObserveOptions): Promise<StepObservation | undefined> {
      stats.steps += 1;
      const messages = readMessages(payload);
      if (messages === undefined) {
        stats.skipped += 1;
        return undefined;
      }
      const assemble = options?.assemble !== false;
      const started = opts.now();
      try {
        const sessionId = readSessionId(payload, opts.sessionId ?? 'unassigned');
        let proxyCache = proxyCaches.get(sessionId);
        if (proxyCache === undefined) {
          proxyCache = { id: '', text: '' };
          proxyCaches.set(sessionId, proxyCache);
        }
        // Assigned *here*, before anything that reads it, and that placement is the whole of this fix (F10). It
        // used to sit with the other `stats` writes after `opts.emit(...)`, i.e. after the tape line below - so
        // the tape carried the *previous* step's session id and the first line of a session carried
        // `'unassigned'`. The round's own tape shows it: line 1 `"sessionId":"unassigned"`, the other 276 the real
        // id. It matters beyond cosmetics because `noteSessionEvent` uses `stats.sessionId` as the fallback when
        // an event envelope carries none (envelopes are `{type, seq, time, data, surfaceOp}`) and `graphFor` keys
        // the per-session graph on it - so a content event arriving before the first assembled step would be
        // folded into a shared `'unassigned'` graph, which is the cross-session leak `rg-session-isolation.test.ts`
        // exists to prevent. `stats.sessionId` is also what `/s1` reports.
        stats.sessionId = sessionId;
        // The step number, read once and in scope for the whole call. The anchor wait's probe line needs it and
        // the wait runs inside `observeStep`, so it travels through the callback below rather than being re-read
        // from a payload the callback does not have.
        const step = readStep(payload);
        // The step path reads the graph and adds to it, but it does not score: scoring is upkeep's job, and the
        // graph scores each segment only once. A step that scored here would do it with the local lexical scorer
        // and leave upkeep nothing to ask the System-1 backend about, which is how a session ended up with a
        // populated graph, zero `assoc` calls and every edge labelled as if a model had scored it.
        const observation = await observeStep({
          sessionId,
          scoreOnStepPath: false,
          step,
          seq,
          messages,
          systemPrompt,
          policy: opts.policy,
          now: started,
          contextWindow: opts.contextWindow,
          reserveOutputTokens: opts.reserveOutputTokens,
          fixedOverheadTokens: opts.fixedOverheadTokens,
          lambdaMs: opts.lambdaMs,
          graph: graphFor(sessionId),
          // A dropped session event is content the graph will never hold, so the count travels to the record
          // instead of living only on `/s1`: `upkeep.dropped` is a number a round does not persist, and a recall
          // measurement over a session with an unnoticed hole in it is the kind of wrong number this pass exists
          // to remove.
          upkeepDropped: queue.stats().dropped,
          // The decision carried no messages, so the caller asked for the read and not for the view. This reaches
          // `observeStep`, which stops after the graph write, and it is the whole fix for a lane that measured
          // 1,205,029 recalled tokens assembled against 1,597 delivered.
          assemble,
          // The two anchor positions live in different arrays and the walk was rooted in the wrong one for 273 of
          // 277 invocations. A disagreement is normal - the two lists coincide only when a session starts empty -
          // and writing it down is what makes the spaces legible in the tape instead of only in this code.
          //
          // The *lines* are bounded, the count is not. `writeProbe` is the one sink this module has and a line per
          // step for the rest of a session would bury the shapes the probe budget exists to record; four lines plus
          // `anchorMismatches` on `/s1` say both what the disagreement looks like and how often it happens.
          onAnchorMismatch: (detail) => {
            stats.anchorMismatches += 1;
            if (stats.anchorMismatches <= ANCHOR_MISMATCH_LINES) {
              writeProbe({ schema: 0, kind: 'anchor-mismatch', ...detail, n: stats.anchorMismatches });
            }
          },
          // The anchor id is computed inside `observeStep` and the queue that drains scoring lives here, so the wait
          // has to travel back out as a callback. It is called after the anchor is chosen and before `assemble()`,
          // and it never throws: a wait that gave up is reported and the fail-open rule covers the rest.
          //
          // **The wrapper is not decoration.** `observeStep` contains this call in a silent `catch` (`a throw here
          // is a caller bug`), which is right for the step and wrong for this mechanism: a walk that threw on the
          // way in - a claim path, a scorer lookup, a bad option - would look exactly like a step that assembled
          // from an empty graph, and the tape would say nothing at all. Every exit now leaves a line, the failure
          // included.
          beforeAssemble: async (anchorId: string) => {
            try {
              if (options?.visibleMessages !== undefined && opts.policy.recall.tier1 !== 'off') {
                // Drain first: newly arrived content must be included in the proof.
                queue.drain();
                const visibility = contextVisibility(options.visibleMessages);
                const graph = graphFor(sessionId);
                if (graph.orderedSegments().every((seg) => seg.kind === 'systemPinned' || visibility.containsSegment(seg))) {
                  stats.recallVisibleSkips += 1;
                  writeProbe({ schema: 0, kind: 'recall-visible', step, sessionId, segments: graph.segmentCount });
                  return;
                }
              }
              await waitForAnchorRow(writeProbe, step, sessionId, anchorId);
            } catch (err) {
              stats.errors += 1;
              stats.lastError = `anchor wait: ${String(err)}`;
              writeProbe({ schema: 0, kind: 'anchor-wait', step, anchor: anchorId, error: String(err) });
            }
          },
          // One slot for the whole observer, so T survives between steps. It is created here rather than inside
          // observeStep because that function is pure: a per-call cache would rebuild T every step, and T's
          // stability across steps is the property the whole block placement rests on.
          proxyCache,
          // The recalled block's order for this session, mutated in place by the assembly below. Per session for
          // the reason `recallOrders` above states: it is a list of ids and carries no session of its own.
          recallOrder: recallOrderFor(sessionId),
        });
        seq += messages.length;
        // The step added its own segments to the graph even though it did not score them, so this is a change
        // worth surviving: a restart should resume at this cursor, not re-ingest a turn that is already in.
        persistGraph(sessionId);
        stats.graphSegments = graphFor(sessionId).segmentCount;
        stats.graphEdges = graphFor(sessionId).edgeCount;

        const elapsed = Math.max(0, opts.now() - started);
        // The tape is written first, on purpose: it records what the harness actually sent, and that is worth
        // most exactly when the adapter could make no sense of it. Skipping it for empty steps would delete the
        // only evidence of the shape we do not understand yet.
        opts.onTape?.(step, messages, systemPrompt, sessionId);
        // Read, and deliberately not assembled: the caller said this step cannot receive context. Reported once
        // per step through `ingestOnly` and never as an error - a skip is the lane working as designed, and the
        // only thing that would make it a defect is the caller getting the condition wrong.
        //
        // The adapter's shape report is still folded in, and that is not tidiness: with the skip in place this is
        // the path most payloads now take, and a role or part type the adapter could not read would stop being
        // reported exactly where it is most likely to appear.
        if (observation.kind === 'ingested') {
          stats.ingestOnly += 1;
          stats.lastSegments = observation.segments.length;
          stats.lastObserveMs = elapsed;
          for (const type of observation.report.unknownPartTypes) {
            if (!stats.unknownPartTypes.includes(type)) stats.unknownPartTypes.push(type);
          }
          for (const role of observation.report.unknownRoles) {
            if (!stats.unknownRoles.includes(role)) stats.unknownRoles.push(role);
          }
          return undefined;
        }
        // Nothing to assemble: no record is emitted, and the step is counted as empty rather than as an
        // observation. It used to throw from the assembler and be swallowed, which is why a real session could
        // log exactly one record (the primer's) while looking perfectly healthy.
        if (observation.kind === 'empty') {
          stats.empty += 1;
          opts.onWarn?.(`[s1cap] step ${step} observed nothing: ${observation.reason}`);
          return undefined;
        }
        opts.emit(observation.event);

        stats.observed += 1;
        // `stats.sessionId` is no longer assigned here: it is set at the top of this call, before the tape line,
        // which is the fix for the round whose first tape line read `"sessionId":"unassigned"` (F10). Assigning it
        // twice would also be a second thing to keep in step, so the one assignment stands.
        stats.lastWouldSaveTokens = observation.wouldSaveTokens;
        stats.lastSelected = observation.event.selected;
        stats.lastCandidates = observation.event.candidates;
        stats.lastSegments = observation.segments.length;
        stats.lastObserveMs = elapsed;
        for (const type of observation.report.unknownPartTypes) {
          if (!stats.unknownPartTypes.includes(type)) stats.unknownPartTypes.push(type);
        }
        for (const role of observation.report.unknownRoles) {
          if (!stats.unknownRoles.includes(role)) stats.unknownRoles.push(role);
        }

        opts.onObserved?.(
          `step ${step}: ${observation.segments.length} segments, ` +
            `${observation.event.selected} recalled of ${observation.event.candidates} candidates, ` +
            `${observation.wouldSaveTokens} tokens below the full history, ${elapsed}ms`,
        );
        if (!announcedShapes && (stats.unknownPartTypes.length > 0 || stats.unknownRoles.length > 0)) {
          announcedShapes = true;
          opts.onWarn?.(
            `harness shapes without a rule — parts: ${stats.unknownPartTypes.join(', ') || 'none'}; ` +
              `roles: ${stats.unknownRoles.join(', ') || 'none'} (kept and reported, never dropped)`,
          );
        }
        return observation;
      } catch (err) {
        stats.errors += 1;
        stats.lastError = `observation: ${String(err)}`;
        opts.onWarn?.(`observation failed (ignored): ${String(err)}`);
        return undefined;
      }
    },

    noteSessionEvent(event: unknown): void {
      try {
        const prompt = extractSystemPrompt(event);
        if (prompt !== undefined && prompt !== systemPrompt) {
          systemPrompt = prompt;
          systemPromptTokens = estimateTokens(prompt);
          stats.systemPromptTokens = systemPromptTokens;
        }
        // Probe the first event of each type, and spend the budget on the content types first.
        //
        // Two corrections are folded in here, both from the same mistake. The first rule spent its whole budget
        // on `turn/start`, `step/start` and `agent/inbox/spliced` - the lifecycle events that arrive first and
        // carry nothing - so the shapes that matter were never recorded while the question looked answered. The
        // second rule fixed that by type but still raced: a session emits eight distinct lifecycle types before
        // it emits `tool/call`, so the two tool shapes were still never seen. Content types now get the budget
        // first and the lifecycle ones only take what is left.
        const eventType = readEventType(event);
        const isContent = eventType !== undefined && CONTENT_EVENT_TYPES.includes(eventType);
        const budgetLeft = probedTypes.size < (isContent ? 12 : 6);
        if (eventType !== undefined && !probedTypes.has(eventType) && budgetLeft) {
          probedTypes.add(eventType);
          eventProbes += 1;
          // `data` is the envelope this host actually uses: measured keys are `type, seq, time, data, surfaceOp`,
          // so the harness message is not at the top level and a reader looking for `message` finds nothing at
          // all. Probing one level in is what turns "the stream carries no content" into "the reader is looking
          // in the wrong place", and the two look identical from every counter.
          const record = typeof event === 'object' && event !== null ? (event as { data?: unknown }) : undefined;
          const data = record?.data;
          // For an assistant message, also probe the nested `data.usage` shape: `llm_call` needs promptTokens,
          // cacheHit/cacheMiss and output token fields, and the field names are the host's contract, not ours.
          // Measuring them is the only honest next step for cost accounting; until a live probe reports the
          // keys, `llm_call` stays unwired rather than filled with guessed field names.
          const usage =
            typeof data === 'object' && data !== null ? (data as { usage?: unknown }).usage : undefined;
          const shape =
            typeof event === 'object' && event !== null
              ? {
                  type: eventType,
                  keys: Object.keys(event as object).slice(0, 14),
                  ...(typeof data === 'object' && data !== null
                    ? {
                        dataKeys: Object.keys(data as object).slice(0, 14),
                        ...(typeof usage === 'object' && usage !== null
                          ? { usageKeys: Object.keys(usage as object).slice(0, 14) }
                          : {}),
                      }
                    : { dataType: typeof data }),
                }
              : { type: typeof event };
          this.probe({ schema: 0, kind: 'session-event-probe', ...shape });
        }
        // The session is decided now, in the handler that received the event, and travels with the queued item.
        // The envelope carries no session id of its own (measured keys: `type, seq, time, data, surfaceOp`), so
        // this reads the step's id when the event happens to expose one and falls back to the session the
        // observer last saw a step for. That is still an attribution made at arrival time rather than at drain
        // time, which is the difference that matters: a drain-time read gave every late event to whichever
        // session happened to be current, mixing one session's content into another's graph.
        queue.enqueue({ sessionId: readSessionId(event, stats.sessionId), event });
        if (!scheduled) {
          scheduled = true;
          schedule(tick);
        }
        // A turn boundary drains the queue, and it is free to do so: the turn is over, nothing is waiting on
        // this work, and the alternative is what a live session actually did - the model's own message sat in
        // the queue while the session ended, so the plan gate never saw the plan it was built to reorder, and
        // the graph carried every event of the turn except its last. `maxLagTurns` bounds the lag by counting;
        // this bounds it by ending it.
        //
        // `queue.drain()` and not the `flushUpkeep` method: that is a property of the object being returned, not
        // a binding in this scope, so calling it by name threw a ReferenceError straight into the catch below -
        // where it was counted as a bad event and swallowed. The queue stayed full and nothing said so.
        if (readEventType(event) === 'turn/end') queue.drain();
      } catch (err) {
        stats.errors += 1;
        opts.onWarn?.(`session event ignored: ${String(err)}`);
      }
    },

    probe(line: Record<string, unknown>): void {
      writeProbe(line);
    },

    setSystemPrompt(text: string, tokens?: number): void {
      const trimmed = text.trim();
      if (trimmed === '' || trimmed === systemPrompt) return;
      systemPrompt = trimmed;
      systemPromptTokens = tokens ?? estimateTokens(trimmed);
      stats.systemPromptTokens = systemPromptTokens;
      opts.onWarn?.(`[s1cap] system prompt pinned: ${systemPromptTokens} tokens`);
    },

    flushUpkeep(): number {
      return queue.drain();
    },

    stats(): StepObserverStats {
      // Summed across the sessions this process holds, and reported per session as well: a single number for a
      // per-session structure answers a question nobody asked - it reads as if one conversation had produced
      // every segment in the window, which is precisely the confusion that made this a bug to begin with.
      let segments = 0;
      let edges = 0;
      for (const g of graphs.values()) {
        segments += g.segmentCount;
        edges += g.edgeCount;
      }
      return {
        ...stats,
        graphSegments: segments,
        graphEdges: edges,
        sessions: [...graphs.entries()].map(([id, g]) => ({
          sessionId: id,
          segments: g.segmentCount,
          edges: g.edgeCount,
        })),
        systemPromptTokens,
        upkeep: queue.stats(),
      };
    },
  };
}
