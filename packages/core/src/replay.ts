/**
 * REPLAY — the gate before the plugin is ever allowed to rewrite a prompt.
 *
 * A tape is a JSONL file with one line per LLM call: `{ "step": n, "messages": [ …harness messages… ] }`.
 * Replaying one through the same pure pipeline must reproduce the same records, field for field. If it does
 * not, no later result can be attributed to S1CAP rather than to noise, which is exactly why this exists
 * before the rewrite switch (docs/STATUS.md, item N3).
 *
 * The digest is deliberately **not** cryptographic: it is an equality check for replays, cheap and
 * dependency-free, over a stable serialisation of the records.
 */
import type { AssemblyPolicy } from './types.ts';
import { AssociationGraph } from './assoc-graph.ts';
import { observeStep } from './observer.ts';
import type { StepObservation } from './observer.ts';
import type { AssemblyEvent } from './telemetry.ts';

export const TAPE_SCHEMA_VERSION = 1 as const;

export interface TapeStep {
  step: number;
  messages: readonly unknown[];
  systemPrompt?: string;
}

export interface Tape {
  schema: typeof TAPE_SCHEMA_VERSION;
  sessionId: string;
  steps: TapeStep[];
}

export interface ReplayOptions {
  policy: AssemblyPolicy;
  /** fixed clock: replays must not depend on wall time */
  now: number;
  contextWindow: number;
  reserveOutputTokens: number;
  fixedOverheadTokens: number;
  lambdaMs: number;
}

export interface ReplayResult {
  records: AssemblyEvent[];
  selectedIds: string[][];
  wouldSaveTokens: number[];
  digest: string;
}

/** Key-order-independent serialisation, so a digest cannot change because a field moved. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** FNV-1a, 32-bit. Non-cryptographic on purpose: an equality check, not a signature. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function digestRecords(records: readonly AssemblyEvent[]): string {
  return fnv1a(records.map((record) => stableStringify(record)).join('\n'));
}

/** Parse a tape, skipping blank lines and refusing anything that is not a step. */
export function parseTape(text: string, fallbackSessionId = 'tape'): Tape {
  const steps: TapeStep[] = [];
  let sessionId = fallbackSessionId;
  let schema: number = TAPE_SCHEMA_VERSION;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed['sessionId'] !== undefined && typeof parsed['sessionId'] === 'string') sessionId = parsed['sessionId'];
    if (typeof parsed['schema'] === 'number') schema = parsed['schema'];
    const messages = parsed['messages'];
    if (Array.isArray(messages)) {
      steps.push({
        step: typeof parsed['step'] === 'number' ? parsed['step'] : steps.length + 1,
        messages,
        ...(typeof parsed['systemPrompt'] === 'string' ? { systemPrompt: parsed['systemPrompt'] } : {}),
      });
    }
  }
  return { schema: schema === TAPE_SCHEMA_VERSION ? TAPE_SCHEMA_VERSION : TAPE_SCHEMA_VERSION, sessionId, steps };
}

/** Replay a tape through the pipeline. Pure: the same tape and options give the same digest. */
export function replayTape(tape: Tape, opts: ReplayOptions): ReplayResult {
  const graph = new AssociationGraph();
  const records: AssemblyEvent[] = [];
  const selectedIds: string[][] = [];
  const wouldSaveTokens: number[] = [];
  let seq = 0;
  // the rendered prompt persists across calls, so a step that does not tape its own inherits the last one
  let carriedPrompt: string | undefined;

  for (const step of tape.steps) {
    if (step.systemPrompt !== undefined) carriedPrompt = step.systemPrompt;
    const observation: StepObservation = observeStep({
      sessionId: tape.sessionId,
      step: step.step,
      seq,
      messages: step.messages,
      ...(carriedPrompt !== undefined ? { systemPrompt: carriedPrompt } : {}),
      policy: opts.policy,
      now: opts.now,
      contextWindow: opts.contextWindow,
      reserveOutputTokens: opts.reserveOutputTokens,
      fixedOverheadTokens: opts.fixedOverheadTokens,
      lambdaMs: opts.lambdaMs,
      graph,
    });
    seq += step.messages.length;
    records.push(observation.event);
    selectedIds.push(observation.selectedIds);
    wouldSaveTokens.push(observation.wouldSaveTokens);
  }

  return { records, selectedIds, wouldSaveTokens, digest: digestRecords(records) };
}
