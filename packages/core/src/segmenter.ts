/**
 * SEGMENTER — message-level segmentation.
 * Never token-level: a segment is a message / tool result / reasoning-trace block,
 * chunked only when it exceeds the token budget (docs/AGENT_BRIEF.md §5.1).
 */
import type { Segment, SegmentKind } from './types.ts';
import { assertSessionEvent } from './provenance.ts';

export const DEFAULT_CHUNK_TOKENS = 512;
export const DEFAULT_CHUNK_OVERLAP = 64;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * Heuristic token estimate: ~1 token per CJK char, ~4 chars per token otherwise.
 * In production the harness tokenMeter supplies the real count; this keeps the
 * core package dependency-free and testable offline.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

export interface RawEvent {
  id: string;
  sessionId: string;
  /** position in the append-only session log */
  seq: number;
  kind: SegmentKind;
  role?: string;
  text: string;
  ts: number;
  taskTag?: string;
}

export interface SegmenterOptions {
  chunkTokens?: number;
  overlapTokens?: number;
}

/** Split one session event into one or more segments. */
export function segmentEvent(ev: RawEvent, opts: SegmenterOptions = {}): Segment[] {
  // I2 (docs/CONTROL_PLANE_LOGGING.md): control-plane records — S1 calls, telemetry, the
  // backend's own server logs — must never reach the segmenter. Segmenting them would make
  // System-1 score its own output on the next turn.
  assertSessionEvent(ev);
  const chunkTokens = opts.chunkTokens ?? DEFAULT_CHUNK_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_CHUNK_OVERLAP;
  const base = {
    sessionId: ev.sessionId,
    kind: ev.kind,
    seq: ev.seq,
    ts: ev.ts,
    ...(ev.role !== undefined ? { role: ev.role } : {}),
    ...(ev.taskTag !== undefined ? { taskTag: ev.taskTag } : {}),
  };

  const total = estimateTokens(ev.text);
  if (total <= chunkTokens) {
    return [{ id: ev.id, ...base, tokens: total, text: ev.text }];
  }

  const pieces = packLines(ev.text.split(/\r?\n/), chunkTokens, overlapTokens);
  return pieces.map((text, i) => ({
    id: `${ev.id}#${i}`,
    ...base,
    chunkOf: ev.id,
    tokens: estimateTokens(text),
    text,
  }));
}

/** Greedy line packing with a trailing-line overlap between chunks. */
function packLines(lines: string[], chunkTokens: number, overlapTokens: number): string[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current);
    // carry the tail of the finished chunk into the next one (overlap)
    const carry: string[] = [];
    let carryTokens = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const line = current[i];
      if (line === undefined) break;
      const t = estimateTokens(line);
      if (carryTokens + t > overlapTokens) break;
      carry.unshift(line);
      carryTokens += t;
    }
    current = carry;
    currentTokens = carryTokens;
  };

  for (const line of lines) {
    let piece = line;
    // Pathological single line longer than the budget: hard-split by characters.
    while (estimateTokens(piece) > chunkTokens && piece.length > chunkTokens) {
      if (current.length > 0) flush();
      const head = piece.slice(0, chunkTokens);
      chunks.push([head]);
      piece = piece.slice(Math.max(0, chunkTokens - overlapTokens));
    }
    const t = estimateTokens(piece);
    if (currentTokens + t > chunkTokens && current.length > 0) flush();
    current.push(piece);
    currentTokens += t;
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((c) => c.join('\n'));
}
