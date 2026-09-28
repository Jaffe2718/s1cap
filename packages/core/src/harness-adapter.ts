/**
 * HARNESS ADAPTER — one harness's step payload into S1CAP's segment vocabulary.
 *
 * Nothing here is guessed. The shapes come from the packaged DSH 0.1.7-rc.2 source, read with
 * `node scripts/scan-dsh-asar.cjs --dump dsh-llm\lib\types\message.js`:
 *
 *   message: { id, role: 'user' | 'developer' | 'assistant' | 'system' | 'tool',
 *              content: Part[], source: { kind: 'model' | 'system-prompt' | 'tool' | 'model-selection' | … },
 *              toolCallId?, isError? }
 *   part:    { type: 'text', text }
 *
 * DSH tags parts with `type`; S1CAP tags segments with `kind`. This file is the single explicit
 * translation point — no other module in this repository ever sees a harness shape.
 *
 * Part vocabulary status: `text` is verified. Anything else is *reported* rather than silently dropped
 * (`AdapterReport.unknownPartTypes` plus a control-plane record), so the first real session completes the
 * table. Reasoning-like parts are labelled `trace` only through the caller-overridable
 * `reasoningPartTypes` list, never through an assumption baked in here.
 */
import type { SegmentKind } from './types.ts';
import type { RawEvent } from './segmenter.ts';

export interface HarnessMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  source?: { kind?: unknown };
  toolCallId?: unknown;
  isError?: unknown;
}

export interface AdapterReport {
  /** messages that produced a segment */
  messages: number;
  /** messages skipped because they carried no text */
  empty: number;
  parts: number;
  /** how often each harness role was seen, and the S1CAP kind it mapped to */
  roles: Record<string, string>;
  unknownRoles: string[];
  unknownPartTypes: string[];
  /** parts kept as raw JSON because they carried no `text` field */
  rawParts: number;
}

/**
 * Best-effort read of a rendered system prompt out of a harness session event.
 *
 * Why this is defensive rather than contract-driven: the session-event vocabulary is only partly verified
 * (`event.type === 'step/end'` is confirmed in `dsh-agent-instructions`) and `dsh-llm` renders system
 * prompts through `createSystemMessage(text)` → `{ role: 'system', content: [{ type: 'text', text }] }`.
 * So this function accepts anything shaped like a system message — directly, or wrapped in an event's
 * `message`/`data`/`payload` field — and returns `undefined` rather than guessing. Anything it cannot read
 * stays reported by `AdapterReport`, never silently dropped.
 */
export function extractSystemPrompt(event: unknown): string | undefined {
  // Unwrap up to two levels: the harness emits `{ type, message }` for some events and `{ type, data: { … } }`
  // for others, so `data.message` has to be reachable without guessing what `data` holds.
  const queue: unknown[] = [event];
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 3 && queue.length > 0; depth += 1) {
    const batch = queue.splice(0, queue.length);
    for (const candidate of batch) {
      if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) continue;
      seen.add(candidate);
      const record = candidate as HarnessMessage & { message?: unknown; data?: unknown; payload?: unknown };
      if (record.role === 'system' || record.role === 'developer') {
        const parts = Array.isArray(record.content) ? record.content : [];
        const report = newAdapterReport();
        const text = parts
          .map((part) => partText(part, report, new Set(DEFAULT_REASONING_PART_TYPES)))
          .join('\n')
          .trim();
        if (text !== '') return text;
      }
      for (const key of ['message', 'data', 'payload'] as const) {
        if (record[key] !== undefined) queue.push(record[key]);
      }
    }
  }
  return undefined;
}

export function newAdapterReport(): AdapterReport {
  return { messages: 0, empty: 0, parts: 0, roles: {}, unknownRoles: [], unknownPartTypes: [], rawParts: 0 };
}

/**
 * Role -> segment kind. `developer` is a system-ish producer in DSH (developer instructions), so it pins;
 * `tool` carries a tool result. An unrecognised role pins as well — it is almost always a harness-injected
 * notice — and is reported so the table can be completed.
 */
const ROLE_TO_KIND: Record<string, SegmentKind> = {
  user: 'user',
  assistant: 'assistant',
  system: 'systemPinned',
  developer: 'systemPinned',
  tool: 'toolResult',
};

const DEFAULT_REASONING_PART_TYPES: readonly string[] = ['reasoning', 'thinking', 'trace'];
const RAW_PART_MAX_CHARS = 2000;

export interface AdaptOptions {
  sessionId: string;
  /** session-log sequence of the first message in this list */
  startSeq: number;
  now: number;
  /** part types that should be labelled `trace` rather than folded into the message kind */
  reasoningPartTypes?: readonly string[];
}

/** Flatten one message's parts into text, recording every shape we do not have a verified rule for. */
function partText(part: unknown, report: AdapterReport, reasoning: ReadonlySet<string>): string {
  if (typeof part === 'string') return part;
  if (typeof part !== 'object' || part === null) return '';
  const record = part as { type?: unknown; text?: unknown };
  const type = typeof record.type === 'string' ? record.type : '';
  report.parts += 1;
  if (type === 'text' && typeof record.text === 'string') return record.text;
  // A reasoning part has a deliberate rule (it labels the message `trace`), so it is not "unknown".
  if (type !== '' && !reasoning.has(type) && !report.unknownPartTypes.includes(type)) {
    report.unknownPartTypes.push(type);
  }
  if (typeof record.text === 'string') return record.text;
  // No text field: keep the payload so token estimates stay honest, bounded and clearly marked.
  report.rawParts += 1;
  const json = JSON.stringify(part) ?? '';
  const clipped = json.length > RAW_PART_MAX_CHARS ? `${json.slice(0, RAW_PART_MAX_CHARS)}…` : json;
  return `[${type || 'unknown-part'}] ${clipped}`;
}

/**
 * Map a harness message list onto raw session events.
 *
 * Deterministic by construction, which the replay test depends on: ids fall back to `m<index>`, sequence
 * numbers are `startSeq + index`, and every event carries the supplied `now` (the payload exposes no
 * per-message timestamp — documented limitation, to be closed by reading the session log).
 */
export function adaptMessages(
  messages: readonly unknown[],
  opts: AdaptOptions,
): { events: RawEvent[]; report: AdapterReport } {
  const report = newAdapterReport();
  const reasoning = new Set(opts.reasoningPartTypes ?? DEFAULT_REASONING_PART_TYPES);
  const events: RawEvent[] = [];

  messages.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      report.empty += 1;
      return;
    }
    const message = raw as HarnessMessage;
    const role = typeof message.role === 'string' ? message.role : '';
    const mapped = ROLE_TO_KIND[role];
    if (mapped === undefined && !report.unknownRoles.includes(role || '(none)')) {
      report.unknownRoles.push(role || '(none)');
    }
    const kind: SegmentKind = mapped ?? 'systemPinned';

    const parts = Array.isArray(message.content) ? message.content : message.content === undefined ? [] : [message.content];
    const texts: string[] = [];
    let sawReasoning = false;
    for (const part of parts) {
      const type = typeof part === 'object' && part !== null ? (part as { type?: unknown }).type : undefined;
      if (typeof type === 'string' && reasoning.has(type)) sawReasoning = true;
      const text = partText(part, report, reasoning);
      if (text !== '') texts.push(text);
    }
    if (parts.length === 0 && typeof message.content === 'string') texts.push(message.content);

    const text = texts.join('\n').trim();
    if (text === '') {
      report.empty += 1;
      return;
    }

    const id = typeof message.id === 'string' && message.id !== '' ? message.id : `m${index}`;
    const sourceKind = typeof message.source?.kind === 'string' ? message.source.kind : undefined;
    events.push({
      id,
      sessionId: opts.sessionId,
      seq: opts.startSeq + index,
      // A message made of reasoning parts is a trace; otherwise the role decides.
      kind: sawReasoning && kind === 'assistant' ? 'trace' : kind,
      role,
      text,
      ts: opts.now,
      ...(sourceKind !== undefined ? { taskTag: sourceKind } : {}),
    });
    report.messages += 1;
    const label = sawReasoning && kind === 'assistant' ? 'trace' : kind;
    report.roles[role || '(none)'] = label;
  });

  return { events, report };
}
