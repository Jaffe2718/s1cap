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
 * graph on a later tick. It can, however, be *advanced* there, and that is deliberate. A measured System-1 call
 * takes a median of 15.3 s, so a step can arrive before the segment it recalls from has been scored at all, and
 * BFS from an unscored anchor returns nothing while the block is silently refilled from the recency window.
 * `waitForAnchorRow` therefore drains already-queued upkeep, bounded by `recall.anchorWaitMs` and skipped
 * entirely when the row is complete or when nothing is queued or in flight. The bounded wait is the exception
 * path; the fail-open rule in `assemble()` is what runs when it expires. Both outcomes are recorded, and
 * differently: a wait that ran out of time and a wait that was never worth starting are not the same event, and
 * the tape line for each says which one it was (`waited`).
 */
import { AssociationGraph, CONTENT_EVENT_TYPES, adaptSessionEvent, createUpkeepQueue, estimateTokens, extractSystemPrompt, observeStep, segmentEvent } from '@s1cap/core';
import type {
  AssemblyPolicy,
  RawEvent,
  RgStore,
  S1Deferral,
  StepObservation,
  TelemetryEvent,
  UpkeepQueueStats,
} from '@s1cap/core';
import { isS1capInjected } from '@s1cap/core';

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
   * The most pairs one upkeep tick may offer, across every segment it folds in (passed to `scoreNew`).
   *
   * The upkeep queue starts several scoring loops per tick, and each scores each of its new segments against its
   * whole window, so a tick that folds in a burst offers `segments x w` pairs at once. Pairs the budget holds
   * back are deferred, not scored lexically: the graph's cursor does not advance over them. Undefined means no
   * budget (the local-only callers want every pair at once).
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
  /** pairs scored by upkeep, across every new session segment */
  upkeepScoredPairs: number;
  /**
   * Of `upkeepScoredPairs`, the pairs the backend actually answered. Absent from this object until a verification
   * run reported it as `undefined`: the counter existed on the graph and in every assembly record, and the status
   * route - the one place an operator looks - could not see it. Read together, the difference is the size of the
   * gap between "the window was offered" and "the window was judged".
   */
  upkeepJudgedPairs: number;
  /**
   * Pairs the backend was too busy to be asked about, so upkeep deferred them to a later tick rather than scoring
   * them lexically. Beside `upkeepScoredPairs`, not inside it: the first is what was offered, this is what was
   * held back, and only the two together say how much of the session the backend was actually shown.
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
  /** T's one-entry memo, alive for as long as the observer is. The anchor id is a segment id, and a new session's task has a new one. */
  const proxyCache = { id: '', text: '' };
  let systemPrompt: string | undefined;
  let systemPromptTokens = 0;
  let scheduled = false;
  const stats: StepObserverStats = {
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

  // The bounded anchor wait (`recall.anchorWaitMs`): at most one diagnostic line per step, and only when the wait
  // gave up with pairs still unjudged. The poll count is what makes a stuck wait legible - a line per poll would be
  // hundreds of lines for one slow backend, and no line at all would leave `unknownAdmitted` in the record with
  // nothing explaining it.
  // The bounded anchor wait (`recall.anchorWaitMs`): at most one diagnostic line per step, and only when pairs are
  // about to be admitted unjudged. The poll count is what makes a stuck wait legible - a line per poll would be
  // hundreds of lines for one slow backend, and no line at all would leave `unknownAdmitted` in the record with
  // nothing explaining it.
  //
  // Two outcomes reach this function and the record distinguishes them, because they are not the same event and
  // used to be written identically. `waited` is the wait that ran and lost: polling happened and the deadline or
  // the poll ceiling arrived with the row still incomplete. `not-started` is the wait that was never worth taking:
  // nothing was queued and no scoring call was in flight, so no amount of time could have completed the row. The
  // tape from a real round carries `{ms:10000, polls:0, unknown:2}` - a line that reads as a completed wait with
  // no polls, which is the one thing it cannot be - and the step proceeded down the fail-open path with nothing
  // saying that the fail-open path is what happened. `gaveUp` states the outcome for a reader with no code in
  // front of them, and it is true in both cases: the pairs were admitted unjudged either way.
  const reportAnchorWait = (
    probe: (line: Record<string, unknown>) => void,
    waitMs: number,
    polls: number,
    unknown: number,
    waited: boolean,
  ): void => {
    probe({ schema: 0, kind: 'anchor-wait', ms: waitMs, polls, unknown, waited, gaveUp: true });
    opts.onWarn?.(
      waited
        ? `[s1cap] anchor wait gave up after ${waitMs}ms (${polls} drain(s)): ` +
          `${unknown} pair(s) inside the window still unjudged; the fail-open rule admits them`
        : `[s1cap] anchor wait not started (${waitMs}ms available): nothing queued and no scoring call in flight, ` +
          `so the anchor's own row cannot be completed by waiting; the fail-open rule admits its ${unknown} pair(s)`,
    );
  };

  const waitForAnchorRow = async (probe: (line: Record<string, unknown>) => void, sessionId: string, anchorId: string): Promise<void> => {
    const waitMs = opts.policy.recall.anchorWaitMs;
    // `0`, or anything below it, disables the wait: the panel sets this, and a researcher turning it off must get
    // the step's own timing back rather than a small wait. Nothing is admitted on this path either - the fail-open
    // rule in `assemble()` still is - but the wait is not asked for, so it reports nothing.
    if (!(waitMs > 0)) return;
    const graph = graphFor(sessionId);
    // The common case, and the reason this is an exception path rather than a per-step cost: the anchor's row has
    // already been judged by the backend, so this check is one `indexOf` plus a map lookup per pair inside `w`.
    // Returns without saying anything, because there is nothing to report.
    //
    // It asks for a *judgement*, not for a row: a row written by the lexical fallback after a failed System-1 call
    // is a row there is still something to wait for, and treating it as complete is how the wait would stand down
    // through a round of backend failures with the fail-open rule none the wiser.
    const unknownBefore = graph.unjudgedWithin(anchorId, opts.policy.recall.window).length;
    if (unknownBefore === 0) return;
    // Nothing queued and nothing in flight means there is no scoring call to wait for, so waiting could only be
    // answered by time passing. That is not a hypothetical saving: it is what a step should do in a session whose
    // upkeep has not been asked for anything yet, and it is what keeps a caller with a clock that does not advance (a
    // deterministic test) from holding a step open for the whole deadline over a queue nobody is going to fill. The
    // line is still written - the fail-open rule is about to admit these pairs, and the record has to say so - with
    // `waited: false`, which is what makes it distinguishable from a wait that ran out of time.
    if (queue.stats().pending === 0 && scoringInFlight === 0) {
      reportAnchorWait(probe, waitMs, 0, unknownBefore, false);
      return;
    }
    const deadline = opts.now() + waitMs;
    // A poll ceiling as well as a deadline, because the deadline came from the injected clock: a caller whose `now()`
    // does not advance would otherwise spin on a resolved sleep until something else stopped it. At the documented
    // 50 ms interval, `waitMs` allows `waitMs / 50` polls, so a real wait is never cut short by this.
    const maxPolls = Math.max(1, Math.ceil(waitMs / 50)) + 1;
    let polls = 0;
    let unknown = 0;
    for (;;) {
      // Draining is what makes the wait able to succeed at all: the System-1 calls happen in the queue's handler, so
      // a loop that only slept would hold the step for the full deadline and learn nothing. It is synchronous, which
      // is why the loop needs the sleep below: a drain cannot await a call that is still in flight.
      queue.drain();
      polls += 1;
      // Re-read after the drain, because the row may have completed inside it.
      unknown = graph.unjudgedWithin(anchorId, opts.policy.recall.window).length;
      if (unknown === 0) return;
      // The deadline is tested *before* the sleep, not after it, so that the row is re-read between the last sleep
      // and giving up. The first version tested it after the sleep and broke straight out of the loop, which made the
      // sleep the final act: work completed during it was thrown away and the diagnostic below reported a remainder
      // that was already judged. Measured on a fixture whose drain completes the row, that turned a finished wait
      // into a reported failure.
      if (polls >= maxPolls || opts.now() >= deadline) break;
      await sleep(50);
    }
    // Giving up is not a failure: assembly carries on, and the pairs it could not wait for are counted as
    // `unknownAdmitted`. The wait makes the fail-open rule rarer; it does not replace it.
    reportAnchorWait(probe, waitMs, polls, unknown, true);
  };

  // How many upkeep scoring calls are in flight right now.
  //
  // The queue cannot answer this: it counts an event as `applied` the moment its handler is entered, and the handler is
  // `async`, so a System-1 call that will take fifteen seconds is indistinguishable from one that has already
  // returned. The anchor wait has to tell those apart - waiting is only worth anything while a call is actually
  // running - so the count is kept here, around the one `scoreNew` call upkeep makes.
  let scoringInFlight = 0;

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
      // Upkeep is where most pairs are scored now, so it is also where most S1 calls happen. It stays off the
      // critical path: the queue already defers this to a timer, and a failure here must cost the edges, not
      // the session - so a backend that is down degrades to no edges for that segment rather than throwing.
      let scored: { scoredPairs: number; edges: number; deferredPairs: number } = { scoredPairs: 0, edges: 0, deferredPairs: 0 };
      scoringInFlight += 1;
      try {
        scored = await graph.scoreNew({
          windowN: opts.policy.recall.window,
          threshold: opts.policy.recall.threshold,
          ...(opts.scoreBatch !== undefined ? { scoreBatch: opts.scoreBatch } : {}),
          ...(opts.maxPairsPerSweep !== undefined ? { maxPairsPerSweep: opts.maxPairsPerSweep } : {}),
        });
      } catch (err) {
        stats.errors += 1;
        stats.lastError = `upkeep scoring: ${String(err)}`;
        opts.onWarn?.(`[s1cap] upkeep scoring failed for a new ${segments.length}-segment batch: ${String(err)}`);
      } finally {
        scoringInFlight -= 1;
      }
      stats.upkeepEvents += 1;
      stats.upkeepSegments += segments.length;
      stats.upkeepScoredPairs += scored.scoredPairs;
      stats.upkeepJudgedPairs += scored.judgedPairs;
      // Pairs the backend was too busy to be asked about. Counted apart from `upkeepScoredPairs` rather than inside
      // it: they were never offered to a scorer, so a coverage ratio computed over them would be a ratio over work
      // the run declined to do. This is the counter that makes "we stopped asking" visible next to "it answered
      // little", which are otherwise the same two numbers on a `/s1` panel.
      stats.upkeepDeferredPairs += scored.deferredPairs;
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
        // The step path reads the graph and adds to it, but it does not score: scoring is upkeep's job, and the
        // graph scores each segment only once. A step that scored here would do it with the local lexical scorer
        // and leave upkeep nothing to ask the System-1 backend about, which is how a session ended up with a
        // populated graph, zero `assoc` calls and every edge labelled as if a model had scored it.
        const observation = await observeStep({
          sessionId,
          scoreOnStepPath: false,
          step: readStep(payload),
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
          beforeAssemble: (anchorId: string) => waitForAnchorRow(writeProbe, sessionId, anchorId),
          // One slot for the whole observer, so T survives between steps. It is created here rather than inside
          // observeStep because that function is pure: a per-call cache would rebuild T every step, and T's
          // stability across steps is the property the whole block placement rests on.
          proxyCache,
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
        opts.onTape?.(readStep(payload), messages, systemPrompt, sessionId);
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
          opts.onWarn?.(`[s1cap] step ${readStep(payload)} observed nothing: ${observation.reason}`);
          return undefined;
        }
        opts.emit(observation.event);

        stats.observed += 1;
        stats.sessionId = sessionId;
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
          `step ${readStep(payload)}: ${observation.segments.length} segments, ` +
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
