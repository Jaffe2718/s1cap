/**
 * STEP OBSERVER — the plugin's read-only wiring of M1.
 *
 * Contains the logic (capture the system prompt, keep the graph fresh off the critical path, run the
 * observer, emit the record, keep counters) with no Cordis, no filesystem and no clock of its own: the clock,
 * the scheduler and the emit function are injected. That keeps the plugin's tests deterministic and the
 * wiring in `index.ts` a few lines.
 *
 * Nothing here can change a round: `observe()` never throws, never rewrites the payload, and is called
 * *after* the harness's own middleware chain produced its decision. Upkeep never runs inside it — new session
 * events go into a bounded queue and are folded into the graph on a later tick.
 */
import { AssociationGraph, CONTENT_EVENT_TYPES, adaptSessionEvent, createUpkeepQueue, estimateTokens, extractSystemPrompt, observeStep, segmentEvent } from '@s1cap/core';
import type {
  AssemblyPolicy,
  RawEvent,
  RgStore,
  StepObservation,
  TelemetryEvent,
  UpkeepQueueStats,
} from '@s1cap/core';
import { extractTodoEvent } from './plan-gate-runtime.ts';
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
   * One S1 call per new segment, scoring the whole window at once. Present only when a backend is configured;
   * its absence is what falls the graph back to lexical scoring, so observation mode stays free and offline.
   */
  scoreBatch?: (
    current: Segment,
    candidates: readonly Segment[],
  ) => readonly number[] | Promise<readonly number[]>;
  /**
   * The advisory plan gate. Optional, and its return value is only recorded: the observer has no way to feed an
   * order back into the prompt, which is the property that makes "never vetoes stop" true by construction.
   */
  planGate?: {
    consider(text: string, sessionId: string, step: number): Promise<unknown>;
    /** The same gate for a plan the model wrote with a tool rather than in prose. Called from upkeep. */
    considerTodos(todos: readonly unknown[], sessionId: string, step: number): Promise<unknown>;
    /** Gate counters for status; `null` when the gate is armed but has never seen a plan. */
    stats(): unknown;
  };
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
  /** M1 N3: record one tape line per call (opt-in; a tape contains session content) */
  onTape?(step: number, messages: readonly unknown[], systemPrompt: string | undefined): void;
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

export interface StepObserver {
  /**
   * `agent/pre-step`: observe one LLM call, and hand back what it assembled.
   *
   * Returns a promise because scoring a new segment may be one System-1 call. The caller in `index.ts` awaits
   * it inside its own try/catch, so a rejected scorer still costs the record and never the step. The returned
   * observation carries the layout, which is what lets the caller deliver the view instead of only recording it;
   * `undefined` means there was nothing to assemble, and the caller then passes the decision through untouched.
   */
  observe(payload: unknown): Promise<StepObservation | undefined>;
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

function readMessages(payload: unknown): readonly unknown[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
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
    upkeepEvents: 0,
    upkeepEmpty: 0,
    upkeepSegments: 0,
    upkeepSelfDropped: 0,
    upkeepScoredPairs: 0,
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

  // The queued unit is an event *plus the session it belongs to*. The id is captured at enqueue time, in the
  // handler that received the event, and travels with the item: reading `stats.sessionId` at drain time attributed
  // a late-draining event to whichever session happened to be current then, which is exactly the cross-session
  // leak this is here to close.
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
        stats.upkeepEmpty += 1;
        // One exception, and it is a real one: `todo/write` is a lifecycle event by shape — it carries no message,
        // so it adapts to nothing — but its `todos` are the model's own written plan, which is precisely what the
        // gate scores. It is asked here, before this early return, because the alternative was a gate that only
        // ever saw plans typed as prose and reported `inspected: 0` for a model that was planning with a tool all
        // along. The decision stays advisory: the order is computed, recorded, and handed back.
        if (opts.planGate !== undefined) {
          const todos = extractTodoEvent(event);
          if (todos !== undefined) {
            try {
              await opts.planGate.considerTodos(todos, sessionId, stats.upkeepEvents);
            } catch (err) {
              stats.errors += 1;
              opts.onWarn?.(`[s1cap] plan gate failed on a todo/write (ignored): ${String(err)}`);
            }
          }
        }
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
      let scored: { scoredPairs: number; edges: number } = { scoredPairs: 0, edges: 0 };
      try {
        scored = await graph.scoreNew({
          windowN: opts.policy.recall.window,
          threshold: opts.policy.recall.relevanceThreshold,
          ...(opts.scoreBatch !== undefined ? { scoreBatch: opts.scoreBatch } : {}),
        });
      } catch (err) {
        stats.errors += 1;
        stats.lastError = `upkeep scoring: ${String(err)}`;
        opts.onWarn?.(`[s1cap] upkeep scoring failed for a new ${segments.length}-segment batch: ${String(err)}`);
      }
      stats.upkeepEvents += 1;
      stats.upkeepSegments += segments.length;
      stats.upkeepScoredPairs += scored.scoredPairs;
      // The graph changed here and nowhere else on this path, so this is the point to make it survive. Written
      // per upkeep event rather than per step: a step only reads.
      persistGraph(sessionId);
      stats.graphSegments = graph.segmentCount;
      stats.graphEdges = graph.edgeCount;
      seq += raw.length;

      // The plan gate reads the model's own step list out of its own output. It runs here, after the segments
      // are in the graph, because that output is where both arrive, and its failure is contained here for the
      // same reason the scoring is: an advisory order that cannot be computed must not cost the session a
      // segment.
      //
      // Both kinds count, and that is the correction of a real bug: a message whose parts are only text adapts
      // to `assistant`, but a message carrying reasoning *and* text - which is what this model actually emits -
      // adapts to `trace`, with the reasoning and the answer merged. Filtering on `assistant` alone silently
      // inspected nothing: the gate reported `inspected: 0` for a whole session while the model was writing
      // numbered plans the entire time.
      if (opts.planGate !== undefined) {
        for (const ev of raw) {
          if (ev.kind !== 'assistant' && ev.kind !== 'trace') continue;
          try {
            await opts.planGate.consider(ev.text, sessionId, stats.upkeepEvents);
          } catch (err) {
            stats.errors += 1;
            opts.onWarn?.(`[s1cap] plan gate failed (ignored): ${String(err)}`);
          }
        }
      }
    },
  });

  function tick(): void {
    scheduled = false;
    // The queue is synchronous in shape (bounded drain, counted failures) and its handler may be async. The
    // handler's own promise is caught inside the queue, so nothing escapes this timer.
    queue.flush();
  }

  return {
    /**
     * Observe one step and return what it assembled, or `undefined` when there was nothing to assemble.
     *
     * The return value exists for context delivery: the caller needs the layout's segments, not just the
     * token counts in the record, to be able to put the view in front of the model. It is `undefined` on the
     * empty and failed paths, and neither of those throws.
     */
    async observe(payload: unknown): Promise<StepObservation | undefined> {
      stats.steps += 1;
      const messages = readMessages(payload);
      if (messages === undefined) {
        stats.skipped += 1;
        return undefined;
      }
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
        opts.onTape?.(readStep(payload), messages, systemPrompt);
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
      stats.probes += 1;
      opts.onProbe?.(line);
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
