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
export function extractSystemPrompt(event         )                     {
  // Unwrap up to two levels: the harness emits `{ type, message }` for some events and `{ type, data: { … } }`
  // for others, so `data.message` has to be reachable without guessing what `data` holds.
  const queue            = [event];
  const seen = new Set         ();
  for (let depth = 0; depth < 3 && queue.length > 0; depth += 1) {
    const batch = queue.splice(0, queue.length);
    for (const candidate of batch) {
      if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) continue;
      seen.add(candidate);
      const record = candidate                                                                             ;
      if (record.role === 'system' || record.role === 'developer') {
        const parts = Array.isArray(record.content) ? record.content : [];
        const report = newAdapterReport();
        const text = parts
          .map((part) => partText(part, report, new Set(DEFAULT_REASONING_PART_TYPES)))
          .join('\n')
          .trim();
        if (text !== '') return text;
      }
      for (const key of ['message', 'data', 'payload']         ) {
        if (record[key] !== undefined) queue.push(record[key]);
      }
    }
  }
  return undefined;
}

export function newAdapterReport()                {
  return { messages: 0, empty: 0, parts: 0, roles: {}, unknownRoles: [], unknownPartTypes: [], rawParts: 0 };
}

/** Fold one report into another, so a caller's report describes everything it was shown. */
function mergeReport(into               , from               )       {
  into.messages += from.messages;
  into.empty += from.empty;
  into.parts += from.parts;
  into.rawParts += from.rawParts;
  for (const role of from.unknownRoles) {
    if (!into.unknownRoles.includes(role)) into.unknownRoles.push(role);
  }
  for (const part of from.unknownPartTypes) {
    if (!into.unknownPartTypes.includes(part)) into.unknownPartTypes.push(part);
  }
  for (const [role, kind] of Object.entries(from.roles)) into.roles[role] = kind;
}

/** The session-event types that carry conversation content, read from the packaged agent loop. */
export const CONTENT_EVENT_TYPES                    = [
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
];

const TOOL_ARGS_MAX_CHARS = 2000;

/**
 * Map ONE harness session event onto raw session events.
 *
 * This is the input that actually carries the conversation, and the reason it exists: `agent/pre-step` hands a
 * plugin only `inbox.claim(...)` - the messages that arrived for *this* step - which is one user message on the
 * first step and an empty array on every step after. Measured on a 46-step session, the step payload carried
 * 1 message and then nothing, while the session-event stream carried 28 content events (user, assistant, tool
 * call, tool result). An observer fed from the step payload therefore builds a graph with no history in it and
 * reports zero candidates, and it reports them honestly rather than crashing - which is exactly how this was
 * found.
 *
 * The payload shapes are read from the packaged agent loop, not guessed:
 *   user/message      -> { turn, step, message }          (dsh-agent-loop:1061)
 *   assistant/message -> { turn, step, message }          (dsh-agent-loop:1086)
 *   tool/call         -> { turn, step, callId, name, arguments }  (dsh-agent-loop:682)
 *   tool/result       -> { turn, step, message, error?, meta? }  (dsh-agent-loop:697)
 *
 * Three of the four carry a harness message and reuse the message adapter unchanged. `tool/call` does not, so it
 * is rendered into a text segment: the call's name and arguments are what a later step would need to judge
 * whether this call is relevant, and dropping them would lose the tool's *intent* while keeping its result.
 *
 * Lifecycle events (`step/start`, `turn/end`, `request/header`, `agent/inbox/spliced`, delivery notices) carry
 * no conversation and produce no event. They are counted in `report.empty` rather than being invented into
 * segments, so the ratio between them and real content stays visible instead of becoming silent padding.
 */
export function adaptSessionEvent(event         , opts              )                                                {
  const report = newAdapterReport();
  if (typeof event !== 'object' || event === null) {
    report.empty += 1;
    return { events: [], report };
  }
  const record = event     
                   
                  
                      
                     
                   
                        
   ;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type !== '' && !CONTENT_EVENT_TYPES.includes(type)) {
    report.empty += 1;
    return { events: [], report };
  }

  // The session log's own sequence number is the segment's seq: it is the position in the append-only log,
  // which is what the replay digest and the graph's ordering both mean. `startSeq` is only the fallback.
  const logSeq = typeof record.seq === 'number' && Number.isFinite(record.seq) ? record.seq : opts.startSeq;
  const withSeq = { ...opts, startSeq: logSeq };

  // The payload is under `data`, and where the message sits inside it depends on the event. Measured on a live
  // session (probe: `session-event-probe`), the envelope is `{type, seq, time, data}` and:
  //   - `user/message`      -> `data` IS the message: `{content, source, role, id}`
  //   - `assistant/message` -> `data` is a wrapper: `{turn, step, message, usage, stream}`
  //   - `tool/call`         -> `{turn, step, callId, name, arguments}`
  //   - `tool/result`       -> `{turn, step, message}`
  // The first version read `record.message` at the top level, which exists on none of them, so every content
  // event produced zero segments - and `upkeepEmpty` counted them as lifecycle noise, so the counters read as
  // "the stream carries nothing" rather than "the reader is looking in the wrong place".
  const data =
    typeof record.data === 'object' && record.data !== null ? (record.data                           ) : undefined;
  const message = data?.message ?? (data !== undefined && 'content' in data ? data : undefined);
  const payload = { ...record, ...(data ?? {}) };

  if (message !== undefined) {
    const sub = adaptMessages([message], withSeq);
    mergeReport(report, sub.report);
    return { events: sub.events, report };
  }

  // tool/call has no message. Render it: the arguments are the model's stated intent, which is the part a
  // later step can be related to, and the part that would otherwise be lost while the result is kept.
  if (type === 'tool/call') {
    const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : '(unnamed)';
    const rawArgs =
      typeof payload.arguments === 'string'
        ? payload.arguments
        : JSON.stringify(payload.arguments ?? null) ?? '';
    const args = rawArgs.length > TOOL_ARGS_MAX_CHARS ? `${rawArgs.slice(0, TOOL_ARGS_MAX_CHARS)}…` : rawArgs;
    const id = typeof payload.callId === 'string' && payload.callId !== '' ? payload.callId : `toolcall-${logSeq}`;
    report.messages += 1;
    report.roles['tool-call'] = 'toolCall';
    return {
      events: [
        {
          id,
          sessionId: opts.sessionId,
          seq: logSeq,
          kind: 'toolCall',
          role: 'tool',
          text: `tool call: ${name}\n${args}`,
          ts: opts.now,
        },
      ],
      report,
    };
  }

  report.empty += 1;
  return { events: [], report };
}

/**
 * Role -> segment kind. `developer` is a system-ish producer in DSH (developer instructions), so it pins;
 * `tool` carries a tool result. An unrecognised role pins as well — it is almost always a harness-injected
 * notice — and is reported so the table can be completed.
 */
const ROLE_TO_KIND                              = {
  user: 'user',
  assistant: 'assistant',
  system: 'systemPinned',
  developer: 'systemPinned',
  tool: 'toolResult',
};

const DEFAULT_REASONING_PART_TYPES                    = ['reasoning', 'thinking', 'trace'];
const RAW_PART_MAX_CHARS = 2000;

                               
                    
                                                               
                   
              
                                                                                            
                                         
 

/** Flatten one message's parts into text, recording every shape we do not have a verified rule for. */
function partText(part         , report               , reasoning                     )         {
  if (typeof part === 'string') return part;
  if (typeof part !== 'object' || part === null) return '';
  const record = part                                      ;
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
  messages                    ,
  opts              ,
)                                                {
  const report = newAdapterReport();
  const reasoning = new Set(opts.reasoningPartTypes ?? DEFAULT_REASONING_PART_TYPES);
  const events             = [];

  messages.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      report.empty += 1;
      return;
    }
    const message = raw                  ;
    const role = typeof message.role === 'string' ? message.role : '';
    const mapped = ROLE_TO_KIND[role];
    if (mapped === undefined && !report.unknownRoles.includes(role || '(none)')) {
      report.unknownRoles.push(role || '(none)');
    }
    const kind              = mapped ?? 'systemPinned';

    const parts = Array.isArray(message.content) ? message.content : message.content === undefined ? [] : [message.content];
    const texts           = [];
    let sawReasoning = false;
    for (const part of parts) {
      const type = typeof part === 'object' && part !== null ? (part                      ).type : undefined;
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
