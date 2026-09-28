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
import { AssociationGraph, createUpkeepQueue, estimateTokens, extractSystemPrompt, observeStep } from '@s1cap/core';
import type { AssemblyPolicy, TelemetryEvent, UpkeepQueueStats } from '@s1cap/core';

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
  sessionId?: string;
  onWarn?(message: string): void;
  onObserved?(summary: string): void;
  /** diagnostic sink; the plugin writes it to the tape file */
  onProbe?(line: Record<string, unknown>): void;
  /** M1 N3: record one tape line per call (opt-in; a tape contains session content) */
  onTape?(step: number, messages: readonly unknown[], systemPrompt: string | undefined): void;
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
  upkeep: UpkeepQueueStats;
}

export interface StepObserver {
  /** `agent/pre-step`: observe one LLM call, change nothing */
  observe(payload: unknown): void;
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

export function createStepObserver(opts: StepObserverOptions): StepObserver {
  const graph = new AssociationGraph();
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
    graphSegments: 0,
    graphEdges: 0,
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

  const schedule =
    opts.schedule ??
    ((tick: () => void): void => {
      const timer = setTimeout(tick, 0);
      // never hold the process open just to drain a queue
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    });

  const queue = createUpkeepQueue<unknown>({
    maxLagTurns: opts.maxLagTurns ?? 2,
    onWarn: (message) => opts.onWarn?.(message),
    onEvent: (event) => {
      // A session event may be a message, or wrap one; the adapter reports anything it cannot read.
      const wrapped =
        typeof event === 'object' && event !== null && (event as { message?: unknown }).message !== undefined
          ? [(event as { message: unknown }).message]
          : [event];
      const observation = observeStep({
        sessionId: stats.sessionId,
        step: 0,
        seq,
        messages: wrapped,
        systemPrompt,
        policy: opts.policy,
        now: opts.now(),
        contextWindow: opts.contextWindow,
        reserveOutputTokens: opts.reserveOutputTokens,
        fixedOverheadTokens: opts.fixedOverheadTokens,
        lambdaMs: opts.lambdaMs,
        graph,
      });
      seq += wrapped.length;
      for (const type of observation.report.unknownPartTypes) {
        if (!stats.unknownPartTypes.includes(type)) stats.unknownPartTypes.push(type);
      }
      for (const role of observation.report.unknownRoles) {
        if (!stats.unknownRoles.includes(role)) stats.unknownRoles.push(role);
      }
    },
  });

  function tick(): void {
    scheduled = false;
    queue.flush();
  }

  return {
    observe(payload: unknown): void {
      stats.steps += 1;
      const messages = readMessages(payload);
      if (messages === undefined) {
        stats.skipped += 1;
        return;
      }
      const started = opts.now();
      try {
        const sessionId = readSessionId(payload, opts.sessionId ?? 'unassigned');
        const observation = observeStep({
          sessionId,
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
          graph,
        });
        seq += messages.length;

        const elapsed = Math.max(0, opts.now() - started);
        opts.emit(observation.event);
        opts.onTape?.(readStep(payload), messages, systemPrompt);

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
      } catch (err) {
        stats.errors += 1;
        opts.onWarn?.(`observation failed (ignored): ${String(err)}`);
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
        if (eventProbes < 3) {
          eventProbes += 1;
          const shape =
            typeof event === 'object' && event !== null
              ? { type: (event as { type?: unknown }).type, keys: Object.keys(event as object).slice(0, 14) }
              : { type: typeof event };
          this.probe({ schema: 0, kind: 'session-event-probe', ...shape });
        }
        queue.enqueue(event);
        if (!scheduled) {
          scheduled = true;
          schedule(tick);
        }
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
      const graphStats = graph.stats();
      return {
        ...stats,
        systemPromptTokens,
        graphSegments: graphStats.segments,
        graphEdges: graphStats.edges,
        upkeep: queue.stats(),
      };
    },
  };
}
