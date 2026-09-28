/**
 * STEP OBSERVER — the plugin's read-only wiring of the M1 observation mode.
 *
 * Split out of `index.ts` on purpose: this module contains the logic (extract the payload, run the
 * observer, emit the record, keep counters) and no Cordis, no filesystem and no clock of its own — the
 * clock and the emit function are injected. That keeps the plugin's own tests deterministic and lets the
 * wiring stay a few lines.
 *
 * Nothing here can change a round: `observe()` never throws, never rewrites the payload, and is called
 * *after* the harness's own middleware chain has produced its decision.
 */
import { AssociationGraph, observeStep } from '@s1cap/core';
import type { AssemblyPolicy, TelemetryEvent } from '@s1cap/core';

export interface StepObserverOptions {
  policy: AssemblyPolicy;
  emit(event: TelemetryEvent): void;
  now(): number;
  /** model context window in tokens (harness token meter when available, else the configured default) */
  contextWindow: number;
  reserveOutputTokens: number;
  fixedOverheadTokens: number;
  lambdaMs: number;
  sessionId?: string;
  onWarn?(message: string): void;
  onObserved?(summary: string): void;
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
  unknownPartTypes: string[];
  unknownRoles: string[];
  graphSegments: number;
  graphEdges: number;
}

export interface StepObserver {
  observe(payload: unknown): void;
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
 * Opportunistic session id: the payload carries `agent`, and a session exposes an id. Read defensively —
 * an absent id only costs correlation in the control-plane log, never correctness.
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
    unknownPartTypes: [],
    unknownRoles: [],
    graphSegments: 0,
    graphEdges: 0,
  };
  /** own monotonic sequence: the harness's session-log sequence is not exposed on this payload */
  let seq = 0;
  let announcedShapes = false;

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

        stats.observed += 1;
        stats.sessionId = sessionId;
        stats.lastWouldSaveTokens = observation.wouldSaveTokens;
        stats.lastSelected = observation.event.selected;
        stats.lastCandidates = observation.event.candidates;
        stats.lastSegments = observation.segments.length;
        stats.lastObserveMs = elapsed;
        const graphStats = graph.stats();
        stats.graphSegments = graphStats.segments;
        stats.graphEdges = graphStats.edges;
        for (const type of observation.report.unknownPartTypes) {
          if (!stats.unknownPartTypes.includes(type)) stats.unknownPartTypes.push(type);
        }
        for (const role of observation.report.unknownRoles) {
          if (!stats.unknownRoles.includes(role)) stats.unknownRoles.push(role);
        }

        // One line per observed step is the visible proof that observation mode is alive; the first
        // observation additionally names any harness shape we do not yet have a rule for.
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
    stats(): StepObserverStats {
      const graphStats = graph.stats();
      return { ...stats, graphSegments: graphStats.segments, graphEdges: graphStats.edges };
    },
  };
}
