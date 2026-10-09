/**
 * SEGMENTER — message-level segmentation.
 * Never token-level: a segment is a message / tool result / reasoning-trace block,
 * chunked only when it exceeds the token budget (docs/AGENT_BRIEF.md §5.1).
 */
                                                       
import { assertSessionEvent } from './provenance.js';

export const DEFAULT_CHUNK_TOKENS = 512;
export const DEFAULT_CHUNK_OVERLAP = 64;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * Heuristic token estimate: ~1 token per CJK char, ~4 chars per token otherwise.
 * In production the harness tokenMeter supplies the real count; this keeps the
 * core package dependency-free and testable offline.
 */
export function estimateTokens(text        )         {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

                           
             
                    
                                                
              
                    
                
               
             
                   
                      
                      
 

/**
 * The id prefix a delivered context block carries, and the test for it.
 *
 * This exists because a delivered block is appended to the session log by the harness, the segmenter turns it
 * into an ordinary user segment like any other, and relevance then selects it as one of the most relevant
 * things in the conversation — because it is a summary of the conversation. A live C2 run showed exactly that:
 * the headers of one injection read `## state proxy T | ## recalled · user · s1cap-895b6ae1 | ## state proxy T |
 * ## recalled · trace · …`, the `s1cap-895b6ae1` being the *previous* injection, and by the last step of the run
 * one message carried 30 recalled blocks. The context was mostly S1CAP's own earlier output, which is not a
 * measurement of anything.
 *
 * The block has to stay in the log — the harness put it there and the request is built from the log, so the model
 * sees it as part of the transcript either way. What must stop is S1CAP *re-selecting* it and re-injecting its
 * text, so the exclusion is applied where the recall candidates are built, not where segments are ingested: the
 * graph stays a faithful record of the session, and the tail stays verbatim.
 */
export const S1CAP_INJECTED_ID_PREFIX = 's1cap-';

/** true for a segment that is one of our own delivered context blocks. */
export function isS1capInjected(id        )          {
  return id.startsWith(S1CAP_INJECTED_ID_PREFIX);
}

                                   
                       
                         
 

/** Split one session event into one or more segments. */
export function segmentEvent(ev          , opts                   = {})            {
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
    ...(ev.toolCallId !== undefined ? { toolCallId: ev.toolCallId } : {}),
    ...(ev.toolError !== undefined ? { toolError: ev.toolError } : {}),
  };

  const total = estimateTokens(ev.text);
  if (total <= chunkTokens) {
    return [{ id: ev.id, ...base, tokens: total, text: ev.text }];
  }

  // Paragraph-aware first. The line packer survives only for text with neither structure nor prose - a minified
  // JSON blob, a long base64 line - where the two strategies would produce the same characters anyway. A single
  // paragraph on one long line is *not* that case: it has sentence structure, and the first version fell back to
  // the hard character split there, which is exactly the mid-sentence cut this replaced.
  const blocks = splitBlocks(ev.text);
  const singleBlock = blocks.length === 1 ? (blocks[0]?.text ?? '') : undefined;
  const useBlocks = blocks.length > 1 || (singleBlock !== undefined && countSentenceCuts(singleBlock) > 0);
  const pieces = useBlocks
    ? packBlocks(blocks, chunkTokens, overlapTokens)
    : packLines(ev.text.split(/\r?\n/), chunkTokens, overlapTokens);
  return pieces.map((text, i) => ({
    id: `${ev.id}#${i}`,
    ...base,
    chunkOf: ev.id,
    tokens: estimateTokens(text),
    text,
  }));
}

/**
 * Paragraph-aware chunking.
 *
 * A segment used to be packed by line, which is a unit chosen by the text format rather than by the text's
 * meaning: a `diff` or a `stack trace` has one item per line and loses its structure, while a prose paragraph
 * has none and gets cut through the middle of a sentence. Cutting mid-sentence is the expensive case, because
 * the two halves then score differently against a query and recall can keep both - the model pays for the
 * overlap twice and sees the same fact twice.
 *
 * So blocks are found first and packed second. A block is the smallest unit that can stand alone:
 *   - a fenced code block, always whole, because a diff or a trace is not two facts;
 *   - a bulleted or numbered list, always whole, because an item without its neighbours loses the enumeration;
 *   - a heading together with the block under it, because a heading without its body is a label;
 *   - a blank-line-separated paragraph otherwise.
 * A block that is still too large is split on sentence boundaries, and only a paragraph with no sentence
 * boundary in it at all falls back to the old hard character split.
 */

/** One structural unit. `text` keeps its own newlines; blocks are rejoined with a blank line. */
                 
               
 

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s)/;
const BLANK = /^\s*$/;
/** Sentence end, kept with its punctuation; the lookahead keeps an abbreviation or a decimal from splitting. */
const SENTENCE_END = /[.!?。！？](?:["')\]}]*)\s+/;

/**
 * Split one text into paragraph-aware blocks.
 *
 * Exported because the assembly-side de-duplication and the tests both need to agree on what a block is.
 */
export function splitBlocks(text        )          {
  const lines = text.split(/\r?\n/);
  const blocks          = [];
  let buf           = [];
  let inFence = false;
  let fenceMarker = '';
  let inList = false;

  const flush = ()       => {
    if (buf.length > 0) blocks.push({ text: buf.join('\n') });
    buf = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]          ;

    // Inside a fence nothing breaks the block: the closing fence is the only thing that does.
    if (inFence) {
      buf.push(line);
      if (FENCE.test(line) && line.trim().startsWith(fenceMarker)) {
        inFence = false;
        flush();
      }
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      inList = false;
      inFence = true;
      fenceMarker = (fence[1] ?? '```').trim();
      buf.push(line);
      continue;
    }

    // A blank line ends a block, except inside a list: a wrapped bullet is separated from its first line by
    // indentation, and an occasional blank line inside a list is still the same list.
    if (BLANK.test(line)) {
      if (!inList) flush();
      else buf.push(line);
      continue;
    }

    const wasList = inList;
    inList = LIST_ITEM.test(line);
    if (wasList && !inList) {
      // the list ended where a non-item line began
      flush();
    }
    if (HEADING.test(line)) {
      // A heading binds to the block beneath it, unless the previous block was already a heading-led block.
      if (buf.length > 0 && !wasList) flush();
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

/** How many sentence ends the text has; 0 means "this is not prose". */
export function countSentenceCuts(text        )         {
  const re = new RegExp(SENTENCE_END, 'gu');
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/** Split an oversized block on sentence boundaries, keeping `overlapTokens` of context between pieces. */
function splitSentences(text        , chunkTokens        , overlapTokens        )           {
  if (estimateTokens(text) <= chunkTokens) return [text];

  // Cut points are the ends of sentences; a run with no punctuation is not prose and falls through to the hard
  // split rather than being mangled into one enormous "sentence".
  const cuts           = [];
  const re = new RegExp(SENTENCE_END, 'gu');
  let match                        ;
  while ((match = re.exec(text)) !== null) {
    cuts.push(match.index + match[0].length);
  }
  if (cuts.length === 0) return hardSplit(text, chunkTokens, overlapTokens);

  const pieces           = [];
  let start = 0;
  while (start < text.length) {
    let end = cuts.filter((c) => c > start && estimateTokens(text.slice(start, c)) <= chunkTokens).at(-1) ?? -1;
    if (end === -1) {
      // Nothing single fits. Take the last cut that at least makes progress, else hard-split the remainder.
      const fitting = cuts.filter((c) => c > start);
      if (fitting.length === 0) {
        const rest = text.slice(start);
        pieces.push(...hardSplit(rest, chunkTokens, overlapTokens));
        return pieces;
      }
      const first = fitting[0]          ;
      if (estimateTokens(text.slice(start, first)) > chunkTokens) {
        pieces.push(...hardSplit(text.slice(start, first), chunkTokens, overlapTokens));
        start = first;
        continue;
      }
      end = first;
    }
    pieces.push(text.slice(start, end).trim());
    // Overlap: rewind to roughly `overlapTokens` of the previous piece, snapped forward to a sentence start.
    let next = end;
    if (overlapTokens > 0 && pieces.length > 0) {
      const back = end - suffixCharsForTokens(text.slice(start, end), overlapTokens);
      const snapped = cuts.find((c) => c >= back && c > start && c < end);
      if (snapped !== undefined) next = snapped;
    }
    if (next <= start) next = end;
    start = next;
  }
  return pieces.filter((p) => p !== '');
}

/** Last resort for a block with no sentence structure at all (minified JSON, a long base64 line). */
function hardSplit(text        , chunkTokens        , overlapTokens        )           {
  const pieces           = [];
  let rest = text;
  while (estimateTokens(rest) > chunkTokens && rest.length > chunkTokens) {
    const end = prefixCharsForTokens(rest, chunkTokens);
    const piece = rest.slice(0, end);
    pieces.push(piece);
    const overlap = suffixCharsForTokens(piece, Math.min(overlapTokens, chunkTokens - 1));
    rest = rest.slice(Math.max(1, end - overlap));
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/** Convert token budgets to Unicode-safe character spans only at the fallback. */
function prefixCharsForTokens(text        , budget        )         {
  let cost = 0, chars = 0;
  for (const ch of text) {
    const next = CJK.test(ch) ? 1 : 0.25;
    if (cost + next > budget) break;
    cost += next;
    chars += ch.length;
  }
  return chars;
}

function suffixCharsForTokens(text        , budget        )         {
  let cost = 0, chars = 0;
  for (const ch of Array.from(text).reverse()) {
    const next = CJK.test(ch) ? 1 : 0.25;
    if (cost + next > budget) break;
    cost += next;
    chars += ch.length;
  }
  return chars;
}

/**
 * Pack paragraph-aware blocks into chunks, carrying an overlap so a boundary never lands inside a sentence.
 *
 * The overlap is the tail of the previous chunk, snapped to a block or sentence boundary. Dropping it would make
 * the split cheaper and lossy; keeping the whole previous block would make the overlap grow without bound.
 */
function packBlocks(blocks         , chunkTokens        , overlapTokens        )           {
  const chunks           = [];
  let current           = [];
  let currentTokens = 0;

  const flush = ()       => {
    if (current.length === 0) return;
    chunks.push(current.join('\n\n'));
    // Carry the tail of the finished chunk: whole blocks while they fit the overlap budget, otherwise the
    // sentence-level tail of the last block, and nothing at all when even one sentence is too big.
    const carry           = [];
    let carryTokens = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const block = current[i]          ;
      const t = estimateTokens(block);
      if (carryTokens + t > overlapTokens) {
        const tail = splitSentences(block, Math.max(1, overlapTokens), Math.min(16, overlapTokens));
        const last = tail.at(-1);
        if (last !== undefined && carryTokens + estimateTokens(last) <= overlapTokens) {
          carry.unshift(last);
        }
        break;
      }
      carry.unshift(block);
      carryTokens += t;
    }
    current = carry;
    currentTokens = current.length === 0 ? 0 : estimateTokens(current.join('\n\n'));
  };

  for (const block of blocks) {
    const t = estimateTokens(block.text);
    if (t > chunkTokens) {
      // A single block over budget: flush what is open, then split this block on sentences.
      if (current.length > 0) flush();
      const pieces = splitSentences(block.text, chunkTokens, overlapTokens);
      for (const piece of pieces) {
        const pt = estimateTokens(piece);
        if (currentTokens + pt + (current.length > 0 ? 1 : 0) > chunkTokens && current.length > 0) flush();
        if (currentTokens + pt + (current.length > 0 ? 1 : 0) > chunkTokens) { current = []; currentTokens = 0; }
        current.push(piece);
        currentTokens = estimateTokens(current.join('\n\n'));
      }
      continue;
    }
    if (currentTokens + t + (current.length > 0 ? 1 : 0) > chunkTokens && current.length > 0) flush();
    if (currentTokens + t + (current.length > 0 ? 1 : 0) > chunkTokens) { current = []; currentTokens = 0; }
    current.push(block.text);
    currentTokens = estimateTokens(current.join('\n\n'));
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));
  return chunks;
}

/** Greedy line packing with a trailing-line overlap between chunks. */
function packLines(lines          , chunkTokens        , overlapTokens        )           {
  const chunks             = [];
  let current           = [];
  let currentTokens = 0;

  const flush = ()       => {
    if (current.length === 0) return;
    chunks.push(current);
    // carry the tail of the finished chunk into the next one (overlap)
    const carry           = [];
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
    currentTokens = current.length === 0 ? 0 : estimateTokens(current.join('\n'));
  };

  for (const line of lines) {
    let piece = line;
    // Pathological single line longer than the budget: hard-split by characters.
    while (estimateTokens(piece) > chunkTokens && piece.length > chunkTokens) {
      if (current.length > 0) flush();
      const end = prefixCharsForTokens(piece, chunkTokens);
      const head = piece.slice(0, end);
      chunks.push([head]);
      piece = piece.slice(Math.max(1, end - suffixCharsForTokens(head, Math.min(overlapTokens, chunkTokens - 1))));
    }
    const t = estimateTokens(piece);
    if (currentTokens + t + (current.length > 0 ? 1 : 0) > chunkTokens && current.length > 0) flush();
    if (currentTokens + t + (current.length > 0 ? 1 : 0) > chunkTokens) { current = []; currentTokens = 0; }
    current.push(piece);
    currentTokens = estimateTokens(current.join('\n'));
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((c) => c.join('\n'));
}
