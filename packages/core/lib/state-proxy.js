/**
 * STATE PROXY T — the serialized task state that Trace as State puts in place of the raw trace.
 *
 * The idea this implements is that a long reasoning trace is a bad thing to carry verbatim: it is large, it is
 * written for a reader who was there at the time, and the part of it that still matters a few turns later is
 * small. So the trace is replaced by a compact statement of *where the task stands* - the task, what has already
 * happened to it, and what the model last said it was about to do - and that statement is what goes into the
 * prompt. It is the `T` in `[P | T | recalled | tail | x]`.
 *
 * Three properties it has to have, all of which follow from being a cache-stable block:
 *
 *   - **Bounded.** `tas.tMaxChars` is a hard ceiling, not a target, because T sits in front of everything that
 *     varies and an unbounded T would drag the whole prompt's prefix with it.
 *   - **Derived, not generated.** Every line is a rendering of something the model actually said or a tool
 *     actually returned. T is a *proxy* for the trace, not a summary written by a model, so nothing in it can be
 *     a claim the model never made. This is also why it needs no System-1 call: the expensive model does not
 *     participate in building it.
 *   - **Stable per task.** With `updatePolicy: perTask` the text changes only when the task changes, which is
 *     what lets it sit in the byte-stable head ahead of the moving blocks.
 */
                                          

/** Share of the ceiling each section may take before the others are cut, so a long task cannot eat the budget. */
const TASK_SHARE = 0.4;
const NEXT_SHARE = 0.25;
/** One line per action in the "done" section; the rest are dropped, most recent first. */
const MAX_DONE_LINES = 8;

                                  
                                                         
                               
                                         
                   
                      
                   
                         
                                      
              
 

/** One line, one line length. Truncation is marked so a cut mid-word is not read as the model's own wording. */
function line(text        , max        )         {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  if (max <= 1) return '';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The single most useful sentence-ish prefix of a segment: a first line, not the whole thing. */
function head(text        , max        )         {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return line(firstLine, max);
}

/**
 * Build T. Returns an empty string when there is no anchor, because an empty T costs zero tokens and the
 * assembler accounts for that specifically - a one-token estimate for "nothing" would quietly inflate every
 * budget number the paper reports.
 */
export function buildStateProxy(input                 )         {
  const ceiling = Math.max(0, Math.floor(input.maxChars));
  if (ceiling === 0) return '';

  const anchorIndex = input.segments.findIndex((s) => s.id === input.anchorId);
  if (anchorIndex < 0) return '';

  const task = head(input.segments[anchorIndex]?.text ?? '', Math.floor(ceiling * TASK_SHARE));
  // Everything the model produced *for this task* comes after the anchor in the append-only log, which is the
  // same append-order fact the tail block is built on.
  const after = input.segments.slice(anchorIndex + 1);

  const done           = [];
  for (const seg of after) {
    if (seg.kind === 'toolResult') {
      done.push(`ran: ${head(seg.text, 160)}`);
    } else if (seg.kind === 'toolCall') {
      done.push(`called: ${head(seg.text, 160)}`);
    }
  }
  const kept = done.slice(Math.max(0, done.length - MAX_DONE_LINES));

  // "Next" is the model's own most recent statement of intent, taken from its last assistant text after the
  // anchor. It is the one line that must never be a guess, so it is quoted rather than paraphrased.
  const lastAssistant = [...after].reverse().find((s) => s.kind === 'assistant');
  const next = lastAssistant === undefined ? '' : head(lastAssistant.text, Math.floor(ceiling * NEXT_SHARE));

  const sections           = [];
  if (task !== '') sections.push(`task: ${task}`);
  if (kept.length > 0) sections.push(`done:\n${kept.map((d) => `  - ${d}`).join('\n')}`);
  if (next !== '') sections.push(`next: ${next}`);

  const text = sections.join('\n');
  // The ceiling is a ceiling: the sections are sized so this rarely bites, but a pathological anchor must not
  // be able to push T past the budget it was given.
  return text.length <= ceiling ? text : `${text.slice(0, Math.max(0, ceiling - 1))}…`;
}
