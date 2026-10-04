#!/usr/bin/env node
/**
 * check-doc-pointers.mjs — the machine check that stops the documentation cascade from recurring.
 *
 * WHY IT EXISTS
 * One design change — one arm's `deliver` flag and one `tier1` value — forced edits across ~10 documents in three
 * sweep passes. The cause is measured and stated in `docs/DOC-CONTRACT.md` §2: *a document sentence that repeats a
 * value the code owns is a defect of the documentation, not a convenience. The fix is a pointer, never a
 * synchronised copy.* Rules live in the run book and the briefs; values live in the code, the presets and the run
 * records. Nothing detected when a copy went stale, so this does:
 *
 *   1. DEAD REFERENCES — a document naming a file, a script or a policy field that the tree does not have.
 *   2. DEAD SECTION ANCHORS — a document pointing at a section that the file it names does not have (`§9.1`, `§"Cells"`,
 *      `docs/X.md §5.1`, `docs/X.md "A heading"`), resolved against that file's real headings and never document
 *      against document. A number that moved still lands the reader nowhere, so it is a finding of its own class
 *      (`dead-section`), kept apart from `dead-reference` and reported with the headings the file does have.
 *   3. STALE VALUE CLAIMS — a document stating a value the code owns and stating it *wrongly*. Every claim is
 *      resolved per cell against the **effective** policy for that cell: `cellPolicy(cell)` merged with that cell's
 *      `bench/cells/<cell>.json` preset, which is what a cell actually runs. `defaultPolicy()` alone is not the
 *      authority for a cell, and the first draft of this script that used it produced a dozen false positives on
 *      correct sentences — exactly the failure mode this file has to avoid.
 *   4. PRESET OVERRIDES — a switch written into a preset that the code owns, which would silently override the cell
 *      (the presets' own `_meta` say this is why `deliver`/`tracePlacement` are absent).
 *   5. POINTER DISCIPLINE, COUNTED — how many restated values remain per document, reported as informational counts
 *      so the number can be watched falling. Informational hits never change the exit code.
 *
 * HONESTY RULES (a checker that cries wolf gets ignored, so each one is deliberate)
 *   - A claim is only *flagged* when it is attributed to a cell (or to `defaultPolicy()`), resolves to a different
 *     value than the code, and sits in a live document. Unattributed prose is counted, never flagged.
 *   - An anchor is only *flagged* when the file it names was read and its headings do not contain the anchor. The
 *     tool never compares two documents' numbering to each other, and it never guesses which section was meant.
 *   - A passage that is *history* is never flagged: it is a frozen record (a dated round report, an audit) or it
 *     marks itself as history ("until 2026-10-02", "was", "carried", "previously", "no longer", an old cell label).
 *     Frozen records and old cell labels are reported separately as informational, with the reason. A section anchor
 *     inside a record is exempt the same way: the record is not edited, and a `*ARCHIVE*.md` is full of numbering
 *     that no longer exists by design.
 *   - Old cell labels (`C3`, `C4`, round `20261001-1300`'s `C2`) are not dead references: the tree maps them
 *     (`docs/AGENT_BRIEF.md` §"Experiment design (three arms: two controls, one arm under test)", the round-label
 *     table in that section; `docs/CELLS-RUN.md`). A *wrong* value stated about today's `C0`/`C1`/`C2` is.
 *   - Frozen files (`docs/STATUS.md`, the audits, every `round-…` directory) are records by `docs/DOC-CONTRACT.md` §4,
 *     so a claim
 *     there is informational; a file that documents itself as current (`.s1cap-ablation/WORK-STATE.md`) is not.
 *
 * WHAT IT DELIBERATELY DOES NOT ATTEMPT (false-positive classes that were considered and refused)
 *   - Prose polarities ("nothing is delivered", "recorded, not delivered", "the only delivering cell"). They are
 *     real claims and they are where the cascade's worst sentences lived, but a regex that reads them cannot tell a
 *     claim about the `deliver` switch from a claim about the *layout*, and a checker that flags those is wrong more
 *     often than it is right. The backticked `key: value` form is the form that is unambiguous.
 *   - An anchor that *exists* but names the wrong subject (`§9` where the pools moved to `§5`). The number resolves to
 *     a real heading, so no mechanical rule can tell it from a correct pointer; it is listed for a reader, not flagged.
 *   - Single-letter knob aliases (`w`, `d`, `k`, `K`, `ρ`, `μ`) that appear without their full path in the same
 *     document. They are restated values and they are counted only when the document also spells the path out.
 *   - Paths inside fenced code blocks (transcripts, dumps), URL-encoded links, and `{a,b}` brace expansions. The
 *     expanded members are checked, the expansions themselves are not.
 *   - Metric values quoted from a run (token counts, percentages, step counts). They are owned by a run record, not
 *     by the code, and `docs/DOC-CONTRACT.md` classifies documents quoting them as dated records.
 *   - A value that is *missing* (a document that stopped mentioning a knob). Absence is not a defect.
 *
 * USAGE
 *   node scripts/check-doc-pointers.mjs [--check] [--json] [--root <dir>] [--quiet] [--verbose] [--self-test]
 *
 * `--check` is the tree's convention for "report, change nothing" (as in `build-route-svg.mjs --check`); this tool
 * only ever checks, so it is an explicit spelling of the default run.
 *
 * EXIT CODES (the convention of every other tool in scripts/)
 *   0 clean · 1 findings · 2 usage error or an unreadable source of truth
 *
 * READ-ONLY. It opens documents, sources and presets for reading and writes nothing outside a system temp
 * directory during `--self-test`, which removes what it wrote.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL = 'check-doc-pointers';
export const VERSION = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = dirname(HERE);

/** Where a value is owned. A claim is checked against whichever of these owns it. */
const POLICY_SOURCE = 'packages/core/src/types.ts';

/**
 * Documents that carry current facts. Everything else that this tool reads is a record: a dated round report, an
 * audit, a scratch note — frozen by `docs/DOC-CONTRACT.md` §4, and read for dead references only.
 */
const LIVE_DOCS = new Set(['README.md', 'bench/README.md', 'docs/DOC-CONTRACT.md', 'docs/AGENT_BRIEF.md', 'docs/ARCHITECTURE.md', 'docs/CELLS-RUN.md', 'docs/FORMULAS.md', 'docs/PROJECT.md', 'docs/PROPOSAL.md', 'docs/RELATED_WORK.md', 'docs/REPO_METADATA.md', '.s1cap-ablation/RUNBOOK.md', '.s1cap-ablation/WORK-STATE.md']);

/**
 * Files that document themselves as partly frozen. A claim in one of these is reported as informational unless the
 * document marks it live, because `docs/DOC-CONTRACT.md` §4 forbids rewriting a dated record — the fix there is a
 * dated correction, not an edit. `docs/STATUS.md`'s own header says its entries "were written while it was a
 * four-cell scheme" and "are left as written".
 */
const PARTLY_FROZEN_DOCS = new Set(['docs/STATUS.md']);

/**
 * `docs/DOC-CONTRACT.md` §4(3): every dated round directory, the audits, and anything a document labels an archive
 * are frozen records. `STATUS.md` is being split into a live file plus a frozen archive, and an archive full of
 * values the code no longer has is exactly what a record is for — it may not be flagged, only counted.
 */
const FROZEN_PATH_RE = /(^|\/)round-[^/]*\/|(^|\/)s1cap-audit-[^/]*\.md$|-report\.md$|ROUND-REPORT\.md$|(^|\/)[A-Za-z0-9._-]*ARCHIVE[A-Za-z0-9._-]*\.md$/i;

/** Inline marker that promotes prose inside a frozen record to a live claim. */
const LIVE_MARKER = '<!-- doc-pointer:live -->';

/**
 * Phrases that mark a sentence as history rather than as a statement of the current value. Kept deliberately wide on
 * dates and corrections, and deliberately narrow on bare past tense: "was" anywhere in a sentence would exempt a
 * present-tense claim that happened to share the line with it, which is how a checker stops catching the very defect
 * it was written for. Every entry was chosen from a real sentence in this tree.
 */
const B = '\\u0008';
const HISTORY_RE = new RegExp(
  [
    `until \\d{4}-\\d{2}-\\d{2}`, `since \\d{4}-\\d{2}-\\d{2}`, `before \\d{4}-\\d{2}-\\d{2}`, `as of \\d{4}`, `\\d{4}-\\d{2}-\\d{2}`,
    'corrected', 'correction', 'previously', 'used to', 'no longer', 'removed', 'formerly', 'histor',
    'read as', 'old label', 'old name', 'renamed', 'the earlier', 'earlier', 'no successor',
    `${B}carried${B}`, `${B}had been${B}`, `${B}dropped${B}`, `round .?\\d{6,8}`,
  ].join('|'),
  'i',
);

/** Backticked `key: value` / `key = value` / `key === value`. The one claim form this tool reads. */
const CLAIM_RE = /`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*(?:===|!==|==|=|:)\s*('[^'`]*'|"[^"`]*"|[A-Za-z0-9_-]+)`/g;

/** A cell mention, not part of a longer identifier (`C0test` is a profile name, not the cell `C0`). */
const CELL_TOKEN = '(C[0-9])(?![A-Za-z0-9_])';

/**
 * Knob names the documents use bare, mapped to the policy path that owns them. Only names that are unambiguous in
 * this tree are here; `ρ`, `μ`, `w` and `d` are not, because prose uses them as formula symbols as well.
 */
const KNOB_ALIASES = {
  tier1: 'recall.tier1', deliver: 'deliver',
  tracePlacement: 'tracePlacement',
  tMaxChars: 'tas.tMaxChars', updatePolicy: 'tas.updatePolicy', tasOn: 'tas.on',
  threshold: 'recall.threshold', depth: 'recall.depth',
  // `fanout: 'recall.fanout'` was here until 2026-10-05 and is deleted rather than kept, for the reason the two
  // entries below spell out: the path it named no longer exists (`recall.fanout` is retired - the per-node
  // expansion cap was never in the originating brief, in no wiring record and in no panel; `core/src/config.ts`,
  // `LEGACY_POLICY_KEYS`), and an alias to a dead path is worse than no alias. It resolves to a truthy string, so
  // the dead-field check below reads the name as a knob it knows and stops instead of reading the mention, and a
  // `fanout: <value>` claim resolves against a path that does not exist - silence in both directions, when what a
  // retired knob should produce is a mention that is *read*. A live document that still backticks the bare name
  // now gets the `dead-policy-field` finding, which is the reading it should produce; the field is still named in
  // prose (never backticked) by the retirement itself and by the dated corrections, and those are not claims.
  // `budgetRatio` was here until 2026-10-05 and is deleted rather than kept: the path it named no longer exists,
  // and an alias to a dead path is worse than no alias. It resolves to a truthy string, so a doc sentence about it
  // would be skipped by the dead-field check instead of flagged, and a `budgetRatio: <value>` claim would not be
  // resolved at all - silence in both directions. A document that still mentions the retired knob is now a
  // `dead-policy-field` finding, which is the reading a retired knob should produce.
  //
  // `questionPlacement` was here until the same day and is deleted for the same reason and one more: the path it
  // named is itself gone - the field was **deleted rather than renamed**, because the paper places the question last
  // in every condition, so the question's position is not a variable (`packages/core/src/config.ts` carries the
  // deletion). An alias to a dead path is worse than no alias there too: it resolves to a truthy string, so the
  // dead-field check reads the name as a knob it knows and stops instead of reading the mention, and a
  // `questionPlacement: <value>` claim resolves against a path that does not exist, which is not a comparison.
  // Silence in both directions, when what a retired knob should produce is a mention that is read: a retired path
  // named under a field the policy does declare is the `dead-policy-field` finding
  // (`.s1cap-ablation/DEFECT-GATE.md` carries the `recall.budgetRatio` one).
  minRecalledShare: 'recall.minRecalledShare',
  minRecalledSegments: 'recall.minRecalledSegments', anchorWaitMs: 'recall.anchorWaitMs',
  window: 'recall.window', retryAttempts: 's1.retryAttempts', admissionLimit: 's1.admissionLimit',
  questionsPerCall: 's1.questionsPerCall', reselectPolicy: 'cache.reselectPolicy',
  blockTokens: 'cache.blockTokens', maxLagTurns: 'rgMaintenance.maxLagTurns',
  assemblyDeadlineMs: 'assemblyDeadlineMs',
};

/**
 * Paths a preset may not carry: the code owns them, and a value in a preset would silently override the cell. `cell`
 * is deliberately not here — a preset names its own cell, which is how a loader selects it, and `cellPolicy()` sets
 * the same value. What is checked instead is that the name agrees with the file it is in.
 *
 * The field the code owns is `tracePlacement`, and it is now the whole list.
 *
 * It is on the list for the reason the single boolean `xFirst` was: it is the paper's own contrast, the only layout
 * axis this build has (the question's position was deleted rather than renamed — the paper places it last in every
 * condition, so it is not a variable), `cellPolicy()` fixes it at `'trace-as-state'`, and a preset carrying
 * `'trace-append'` would put that cell on the other side of the paper's control and quietly redefine which arm it
 * *is* (`packages/core/src/types.ts`, above `cellPolicy()`).
 *
 * **`deliver` was removed from this list on 2026-10-05, and that is a change of architecture rather than a
 * relaxation.** It was here because `cellPolicy()` set it per cell, so a preset carrying it would have overridden a
 * value the code owned. The ownership moved: `deliver` now comes from `bench/cells/<cell>.json` — the file a
 * researcher can edit and the file a round copies into its own home — and `cellPolicy()` no longer sets it. The
 * guard's premise was "the code owns this", and the code stopped owning it. What protects against the silent
 * override it was written for is now different and stronger: the preset is an explicit layer with a recorded
 * provenance (`cellPreset.fromPreset` / `.overridden` on the wiring record), so a preset value is never a surprise.
 */
const CODE_OWNED_SWITCHES = ['tracePlacement'];

/** Extensions a document reference may carry. A path without one of these is not treated as a file reference. */
const REF_EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'py', 'json', 'jsonl', 'md', 'yml', 'yaml', 'svg', 'html', 'png', 'txt'];
const REF_ROOT_RE = /(?<![\w./-])(packages\/[A-Za-z0-9._/{},-]+|scripts\/[A-Za-z0-9._/{},-]+|bench\/[A-Za-z0-9._/{},-]+|docs\/[A-Za-z0-9._/{},-]+|\.s1cap-ablation\/[A-Za-z0-9._/{},-]+)/g;
const REF_DOC_RE = /(?<![\w./-])((?:docs|bench)\/[A-Za-z0-9._/{},-]+\.md)(?![\w/])/g;

/**
 * `§` followed by a numbered (`9.1`, `6b`, `A.1`), quoted (`§"Cells"`) or bare-word (`§Setup`) anchor. A dot belongs
 * to the anchor only when a character follows it, so the full stop that ends the sentence — `… in §1.`, `… see §8.2.` —
 * is not read as part of the section's name, and a qualifier after a hyphen (`§1.8-style`) is not either.
 */
const SECTION_REF_RE = /§\s*(?:"([^"\n]{1,140})"|\u201c([^\u201d\n]{1,140})\u201d|([A-Za-z0-9](?:[A-Za-z0-9_]|\.(?=[A-Za-z0-9]))*))/g;

/** `§5-6` writes a range of two anchors; the second half is read from just past the first. */
const SECTION_RANGE_RE = /^-\s*([A-Za-z]?\d+(?:\.\d+)*)(?![\w.])/;

/** A document named by path: `docs/AGENT_BRIEF.md`, `[X](./x.md)`, `.s1cap-ablation/RUNBOOK.md`, `s1cap-audit-core.md`. */
const FILE_MENTION_RE = /(?<![\w./-])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:md|markdown|txt))(?![\w/])/g;

/**
 * A document named without its extension, which is how this tree's prose points (`AGENT_BRIEF §5`, `FORMULAS §8`).
 * Only the documents this project actually has, so a capitalised word in prose is not read as a file name.
 */
const DOC_NAME_RE = /(?<![\w`/-])(AGENT_BRIEF|ARCHITECTURE|CELLS-RUN|CONTROL_PLANE_LOGGING|DEFECT-GATE|DOC-CONTRACT|FORMULAS|LAYA_RUNTIME|PROPOSAL|README|RELATED_WORK|REPO_METADATA|RUNBOOK|STATUS|WORK-STATE)(?![\w-])(?!\.md)/g;

/** A heading's own numbering: `3`, `3.1`, `6b`, `7.3a`, `A`, `A.1`. A heading with no number is a named heading. */
const HEADING_NUMBER_RE = /^(\d+(?:\.\d+)*[a-z]?|[A-Z](?:\.\d+)*)(?:[.)])?(?:\s+|$)/;

/** A label a document's own body carries (`| A. Back-pressure analysis |`): an anchor may name a label, not a heading. */
const LABEL_RE = /^\s*\|?\s*\*{0,2}([A-Za-z]?\d+(?:\.\d+)*[a-z]?|[A-Z](?:\.\d+)*)[.)]\s/;

/** Spaces a named anchor may be followed by in a heading, before the rest of the heading stops being the same name. */
const NAME_BOUNDARY_RE = /^[\s,;:.(\u2014\u2013-]/;

const headingCache = new Map();

/** Heading text as it is compared: no markdown emphasis, one space, lower case. Never the file path. */
function normalizeHeading(text) {
  return text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The real headings of one file — numbers, named text, and the labels its own body carries. Read from the file, never
 * from the document that points at it: a checker that compares two documents' numbering to each other is how this
 * class of defect was missed in the first place. Fenced code is skipped, because a run book's `# comment` inside a
 * ```powershell block is not a heading and would otherwise invent anchors that do not exist.
 */
export function readHeadings(abs) {
  if (headingCache.has(abs)) return headingCache.get(abs);
  let text = '';
  try { text = readFileSync(abs, 'utf8'); } catch { /* unreadable: it has no headings to find */ }
  const headings = [];
  const numbers = new Set();
  const labels = new Set();
  const lines = text.split(/\r?\n/);
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*$/.exec(line);
    if (m) {
      const raw = m[1].replace(/\s*#+\s*$/, '');
      const numbered = HEADING_NUMBER_RE.exec(raw);
      const number = numbered ? numbered[1] : null;
      const body = numbered ? raw.slice(numbered[0].length).trim() : raw;
      if (number) numbers.add(number.toLowerCase());
      headings.push({ number, text: body || raw, norm: normalizeHeading(body || raw), line: i + 1 });
      continue;
    }
    const label = LABEL_RE.exec(line);
    if (label) labels.add(label[1].toLowerCase());
  }
  const index = { abs, headings, numbers, labels };
  headingCache.set(abs, index);
  return index;
}

/** Does this file have the anchor? A number, a lettered sub-number, a named heading, or a label its body carries. */
export function resolveAnchor(index, anchor) {
  const want = anchor.toLowerCase();
  const numeric = /^(?:[A-Za-z]?\d+(?:\.\d+)*[a-z]?|[A-Z](?:\.\d+)*)$/.test(anchor);
  if (numeric && index.numbers.has(want)) return { ok: true, how: `§${anchor}` };
  if (numeric && index.labels.has(want)) return { ok: true, how: `the label "${anchor}." in its body` };
  const norm = normalizeHeading(anchor);
  if (norm) {
    for (const h of index.headings) {
      if (h.norm === norm) return { ok: true, how: `the heading "${h.text}"` };
      if (h.norm.startsWith(norm) && NAME_BOUNDARY_RE.test(h.norm.slice(norm.length))) {
        return { ok: true, how: `the heading "${h.text}"` };
      }
    }
  }
  return { ok: false };
}

/** The headings a file does have, so a wrong number is a mechanical fix rather than a hunt. */
export function headingListText(index, limit = 12) {
  if (index.headings.length === 0) return 'no headings at all';
  const all = index.headings.map((h) => (h.number ? `§${h.number} ${h.text}` : `§"${h.text}"`));
  if (all.length <= limit) return all.join(' · ');
  return `${all.slice(0, limit).join(' · ')} · … (${all.length} headings in all)`;
}
// ---------------------------------------------------------------------------------------------------------------
// Source parsing: read the policy the code declares, without importing it.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A tokenizer for the object literals in `types.ts`. Comments are turned into spaces so that every token keeps its
 * offset in the original text — that is what lets a finding cite the file and line that owns the value.
 */
function tokenizeObjectLiteral(text) {
  const tokens = [];
  let pending = '';
  let pendingAt = 0;
  const flush = () => {
    if (pending.trim()) tokens.push({ kind: 'raw', text: pending.trim(), at: pendingAt });
    pending = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { pending += ' '; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      if (!pending) pendingAt = i;
      const end = text.indexOf('\n', i);
      pending += ' ';
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      if (!pending) pendingAt = i;
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      pending += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) break;
        j += 1;
      }
      const end = j < text.length ? j : text.length;
      const body = text.slice(i + 1, end);
      if (c === '`') {
        if (!pending) pendingAt = i;
        pending += ' ' + body;
      } else {
        flush();
        tokens.push({ kind: 'string', text: body, at: i });
      }
      i = end + 1;
      continue;
    }
    if ('{}=:,;!'.includes(c)) {
      flush();
      tokens.push({ kind: c, text: c, at: i });
      i += 1;
      continue;
    }
    if (/\s/.test(c)) { pending += c; i += 1; continue; }
    if (!pending) pendingAt = i;
    pending += c;
    i += 1;
  }
  flush();
  return tokens;
}

/** Parse one `{ ... }` literal, starting just after its `{`. Values are JS primitives; nested objects stay nested. */
function parseObjectLiteral(tokens, pos) {
  const out = {};
  while (pos < tokens.length && tokens[pos].kind !== '}') {
    const key = tokens[pos];
    if (key.kind !== 'raw' && key.kind !== 'string') break;
    pos += 1;
    if (tokens[pos] && tokens[pos].kind === ':') pos += 1;
    const next = tokens[pos];
    if (next && next.kind === '{') {
      const [value, after] = parseObjectLiteral(tokens, pos + 1);
      out[key.text] = { __object: value, __at: key.at };
      pos = after;
    } else if (next && next.kind === '[') {
      let depth = 0;
      const parts = [];
      while (pos < tokens.length) {
        if (tokens[pos].kind === '[') depth += 1;
        if (tokens[pos].kind === ']') { depth -= 1; if (depth === 0) { pos += 1; break; } }
        parts.push(tokens[pos].text);
        pos += 1;
      }
      out[key.text] = { __array: parts.join(' '), __at: key.at };
    } else {
      if (next && next.kind === '!') pos += 1;
      const lit = tokens[pos];
      let value = lit ? lit.text : '';
      if (lit && lit.kind === 'raw' && /^(true|false|null)$/.test(lit.text)) value = lit.text === 'true' ? true : lit.text === 'false' ? false : null;
      else if (lit && lit.kind === 'raw' && /^[-+]?[\d_]+(\.[\d_]+)?$/.test(lit.text)) value = Number(lit.text.replace(/_/g, ''));
      out[key.text] = { __value: value, __at: key.at };
      pos += 1;
    }
    while (pos < tokens.length && (tokens[pos].kind === ',' || tokens[pos].kind === ';')) pos += 1;
  }
  return [out, pos + 1];
}

/** The `{ ... }` body of `export function <name>`, by brace matching that ignores strings and comments. */
function functionBody(source, name) {
  const at = source.indexOf(`export function ${name}`);
  if (at === -1) return null;
  const open = source.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { const e = source.indexOf('\n', i); i = e === -1 ? source.length : e; continue; }
    if (c === '/' && source[i + 1] === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? source.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length) { if (source[j] === '\\') { j += 2; continue; } if (source[j] === c) break; j += 1; }
      i = j + 1;
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open, i + 1), at: open, line: source.slice(0, open).split('\n').length };
    }
    i += 1;
  }
  return null;
}

/** Blank out comments, keeping offsets, so the assignment scan cannot read a `case` out of a comment. */
function blankComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const stop = e === -1 ? text.length : e; out += ' '.repeat(stop - i); i = stop; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const stop = e === -1 ? text.length : e + 2; out += text.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** Unwrap the `{ __object }` / `{ __value }` wrapper into a plain value. */
function plain(node) {
  if (node && typeof node === 'object' && '__object' in node) {
    const out = {};
    for (const [k, v] of Object.entries(node.__object)) out[k] = plain(v);
    return out;
  }
  if (node && typeof node === 'object' && '__value' in node) return node.__value;
  if (node && typeof node === 'object' && '__array' in node) return node.__array;
  return node;
}

/**
 * Read `defaultPolicy()` and `cellPolicy()` out of `packages/core/src/types.ts`. This is the code that owns the
 * values, so it is the authority every claim is resolved against — a document is never compared to another document.
 */
export function readPolicySource(repoRoot) {
  const file = join(repoRoot, POLICY_SOURCE);
  if (!existsSync(file)) throw new Error(`${POLICY_SOURCE} not found under ${repoRoot} — is this the s1cap root?`);
  const source = readFileSync(file, 'utf8');
  const lineOf = (index) => source.slice(0, index).split('\n').length;

  const defaultsBody = functionBody(source, 'defaultPolicy');
  if (!defaultsBody) throw new Error(`${POLICY_SOURCE} has no defaultPolicy() — the policy source moved?`);
  const [root] = parseObjectLiteral(tokenizeObjectLiteral(defaultsBody.body), 1);
  const wrapped = root.return ?? root.policy ?? Object.values(root)[0];
  if (!wrapped || !('__object' in wrapped)) throw new Error(`${POLICY_SOURCE}: defaultPolicy() does not return an object literal`);
  const defaults = plain(wrapped);

  const cellsBody = functionBody(source, 'cellPolicy');
  if (!cellsBody) throw new Error(`${POLICY_SOURCE} has no cellPolicy() — the policy source moved?`);
  const clean = blankComments(cellsBody.body);
  const overrides = {};
  const parts = clean.split(new RegExp(`case\\s+'${CELL_TOKEN}'\\s*:`));
  for (let s = 1; s < parts.length; s += 2) {
    const cell = parts[s];
    const body = parts[s + 1] ?? '';
    overrides[cell] = overrides[cell] ?? {};
    for (const m of body.matchAll(/p\.([A-Za-z0-9_.]+)\s*=\s*([^;]+);/g)) {
      let value = m[2].trim();
      if (/^'.*'$/s.test(value) || /^".*"$/s.test(value)) value = value.slice(1, -1);
      else if (/^[-+]?[\d_]+(\.[\d_]+)?$/.test(value)) value = Number(value.replace(/_/g, ''));
      else if (value === 'true') value = true;
      else if (value === 'false') value = false;
      overrides[cell][m[1]] = value;
    }
  }

  // Every leaf path the policy declares, with the line that declares it. Used for dead-field references.
  const leaves = new Map();
  const containers = new Set(['']);
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      containers.add(path);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
      else leaves.set(path, { value: v, line: 0 });
    }
  };
  walk(defaults, '');

  return {
    file,
    relFile: POLICY_SOURCE,
    defaults,
    overrides,
    leaves,
    containers,
    defaultsLine: defaultsBody.line,
    cellsLine: cellsBody.line ?? lineOf(cellsBody.at),
    hasPath: (path) => leaves.has(path),
    valueAt: (policy, path) => {
      let cur = policy;
      for (const seg of path.split('.')) {
        if (!cur || typeof cur !== 'object' || !(seg in cur)) return { ok: false };
        cur = cur[seg];
      }
      return { ok: true, value: cur };
    },
    /** `cellPolicy(cell)` — defaults plus that cell's toggles, and nothing else. */
    cellPolicy: (cell) => {
      const out = structuredClone(defaults);
      const set = overrides[cell];
      if (!set) return null;
      for (const [path, value] of Object.entries(set)) {
        const segs = path.split('.');
        let cur = out;
        for (const seg of segs.slice(0, -1)) {
          if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = {};
          cur = cur[seg];
        }
        cur[segs.at(-1)] = value;
      }
      return out;
    },
  };
}

/** Deep merge, so a preset's `{ s1: { provider } }` keeps the code's other `s1` fields. */
function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/**
 * The policy a cell actually runs: `cellPolicy(cell)` merged with `bench/cells/<cell>.json`. This is the authority
 * for a claim attributed to that cell — `s1.provider: 'none'` in `defaultPolicy()` is `'jev'`, and a document that
 * says the control arms pin `none` is describing the preset, correctly.
 */
export function effectivePolicy(policy, repoRoot, cell) {
  const base = policy.cellPolicy(cell);
  if (!base) return null;
  const file = join(repoRoot, 'bench', 'cells', `${cell}.json`);
  if (!existsSync(file)) return { policy: base, preset: null };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const preset = {};
  for (const [k, v] of Object.entries(raw)) if (k !== '_meta') preset[k] = v;
  return { policy: deepMerge(base, preset), preset: { file, raw, config: preset } };
}

// ---------------------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every document this run reads: `README.md`, the markdown files under `docs/`, `bench/README.md`, and the run book
 * / working state under the workspace's `.s1cap-ablation/`, when that directory is reachable. A record's own report
 * files are read for dead references only — they are frozen by `docs/DOC-CONTRACT.md` §4.
 */
export function collectDocuments(repoRoot, options = {}) {
  const found = [];
  const add = (abs) => {
    if (!existsSync(abs) || !statSync(abs).isFile()) return;
    const rel = relative(repoRoot, abs).replace(/\\/g, '/');
    found.push({ abs, rel, text: readFileSync(abs, 'utf8') });
  };
  add(join(repoRoot, 'README.md'));
  add(join(repoRoot, 'bench', 'README.md'));
  for (const name of readdirSync(join(repoRoot, 'docs')).sort()) {
    if (name.endsWith('.md')) add(join(repoRoot, 'docs', name));
  }
  const ablation = options.ablationRoot ?? join(dirname(repoRoot), '.s1cap-ablation');
  if (ablation && existsSync(ablation)) {
    if (options.ablationRoot) {
      for (const name of readdirSync(ablation).sort()) if (name.endsWith('.md')) add(join(ablation, name));
    } else {
      // Reachable by the default relative path: the two documents that carry rules and working state. The rest of
      // that directory is round evidence and scratch tooling.
      for (const name of ['RUNBOOK.md', 'WORK-STATE.md', 'DEFECT-GATE.md']) add(join(ablation, name));
    }
  }
  return found;
}

/** Headings that say the text under them is a record of what was, not a statement of what is. */
const HISTORY_HEADING_RE = /^\s{0,3}#{1,6}\s.*(history|historical|record|dated|earlier|previous|old label|what changed|audit|milestone|superseded|retired)/i;

/** Split a document into blocks with the heading trail that governs each line. */
export function markSections(doc) {
  const lines = doc.text.split(/\r?\n/);
  const inFence = [];
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    inFence[i] = fence || /^\s*(```|~~~)/.test(lines[i]);
  }
  const headingHistory = [];
  let history = false;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m) history = HISTORY_HEADING_RE.test(lines[i]);
    headingHistory[i] = history;
  }
  let live = false;
  const liveMarker = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(LIVE_MARKER)) live = true;
    liveMarker[i] = live;
  }
  return { lines, inFence, headingHistory, liveMarker };
}

/** Is this document, or this passage, a record rather than a statement about the current tree? */
export function isHistorical(doc, lineIndex, sections) {
  if (sections.liveMarker[lineIndex]) return false;
  if (FROZEN_PATH_RE.test(doc.rel)) return true;
  if (!LIVE_DOCS.has(doc.rel)) return true;
  if (PARTLY_FROZEN_DOCS.has(doc.rel) && sections.headingHistory[lineIndex]) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 1 — dead references
// ---------------------------------------------------------------------------------------------------------------

/**
 * Paths a document legitimately names without the file existing yet. Each one is a *documented* absence in this tree,
 * with the document that says so — the checker is not allowed to flag a sentence that is telling the truth about a
 * missing file. Anything not on this list that does not resolve is a finding.
 */
const KNOWN_PLANNED_PATHS = new Map([
  ['packages/proxy', 'the model-view write-back, carried as 🔜 in docs/ARCHITECTURE.md §5 and named unwritten in README.md, docs/PROPOSAL.md and docs/AGENT_BRIEF.md'],
  ['bench/stats', 'the statistics runner, listed under "Planned layout" in bench/README.md and deferred to M2/M3'],
  ['bench/runners', 'the benchmark runners, listed under "Planned layout" in bench/README.md and deferred to M2'],
  ['bench/analysis', 'the Pareto/cache-waterfall figures, listed under "Planned layout" in bench/README.md'],
  ['packages/s1-client/src/embed.ts', 'the embed mode, designed and not implemented (docs/FORMULAS.md §2)'],
]);

/** Roots of a path that are not policy fields, so a backticked dotted name is not read as a knob. */
const NON_POLICY_ROOTS = new Set(['window', 'globalThis', 'document', 'process', 'module', 'require', 'console', 'navigator', 'localStorage', 'sessionStorage']);

/** Paths a document legitimately names without the file existing yet, each with the words that say so. */
const PLANNED_RE = new RegExp(
  [
    'not written', 'not exist', 'do not exist', 'does not exist', 'not yet', 'planned', 'designed',
    'to be written', 'is missing', 'still missing', 'pending', 'future', 'intended', 'no successor',
    'dropped', 'absent', 'separate project', 'M[0-9]\\b', '🔜',
  ].join('|'),
  'i',
);

/**
 * The strongest absence markers: a marker next to the path is about *that* path, so `🔜 packages/proxy` and a
 * sentence that says a file "is not written" both count. A marker elsewhere on a long table row is not about this
 * path — `ARCHITECTURE.md`'s Event-intake row names a file that exists in another package and then, in a different
 * cell, carries a 🔜 about something else. Reading the whole line is what would hide exactly that defect.
 */
const NEAR_ABSENCE_RE = /🔜|not written|not exist|not implemented|to be written/i;

/**
 * The text that says whether a path is absent: a window around the path itself, stopped at a table-cell separator so
 * a marker in a neighbouring cell cannot cover it, plus the next line when that line continues the same sentence
 * (unwrapped markdown splits "which does not exist" from the path it is about).
 */
function contextAround(doc, index, match) {
  const line = doc.lines[index] ?? '';
  const here = match
    ? line.slice(Math.max(0, match.index - 100), match.index + match[0].length + 100).split('|')[0]
    : line;
  const next = doc.lines[index + 1] ?? '';
  const continued = /^[a-z(]/.test(next.trim()) ? next : '';
  return `${here}\n${continued}`;
}

/**
 * Expand a shell-style brace pair, so `docs/figures/route.{light,dark}.svg` is checked as the two files it names.
 * A path with no brace, or with a brace this does not understand, is returned as itself — one member, unchanged.
 */
export function braceExpand(path) {
  const open = path.indexOf('{');
  const close = open === -1 ? -1 : path.indexOf('}', open);
  if (open === -1 || close === -1) return [path];
  const head = path.slice(0, open);
  const tail = path.slice(close + 1);
  const options = path.slice(open + 1, close).split(',');
  if (options.length < 2 || options.some((option) => option === '')) return [path];
  return options.flatMap((option) => braceExpand(`${head}${option}${tail}`));
}

function fileSet(repoRoot) {
  const files = new Set();
  const dirs = new Set();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      const rel = relative(repoRoot, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        dirs.add(rel);
        walk(abs, depth + 1);
      } else {
        files.add(rel);
      }
    }
  };
  walk(repoRoot, 0);
  return { files, dirs };
}

export function checkDeadReferences({ repoRoot, documents, tree, policy }) {
  const checks = [];
  const findings = [];
  /** Dead pointers left alone because the passage that carries them is a record: counted, printed as informational. */
  const records = [];
  const workspaceRoot = dirname(repoRoot);

  /**
   * Resolve a reference the way a reader would: relative to the document that names it first (an ablation document
   * says `cells.mjs`, meaning the file beside it), then to the project root, then to the workspace for the
   * `.s1cap-ablation/` harness — which lives outside the project and is reachable from both.
   */
  const resolveReference = (doc, member) => {
    const docDir = dirname(doc.abs);
    const candidates = [resolve(docDir, member), resolve(repoRoot, member)];
    if (member.startsWith('.s1cap-ablation/')) candidates.push(resolve(workspaceRoot, member));
    for (const candidate of candidates) if (existsSync(candidate)) return { ok: true, at: candidate };
    return { ok: false, at: candidates[0] };
  };

  /**
   * The file a *section* reference is read against. Same resolution order as a path, plus the workspace root for the
   * ablation documents' `s1cap/docs/...` spelling. A document named without its directory (`AGENT_BRIEF.md`,
   * `AGENT_BRIEF`) is looked for in `docs/` too, because that is where the tree keeps them and the prose of this tree
   * names them exactly that way.
   */
  const findMentionedFile = (doc, member) => {
    const names = /\.(?:md|markdown|txt)$/.test(member) ? [member, `docs/${member}`, `bench/${member}`] : [`docs/${member}.md`, `${member}.md`];
    for (const name of names) {
      for (const candidate of [resolve(dirname(doc.abs), name), resolve(repoRoot, name), resolve(workspaceRoot, name)]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
    }
    return null;
  };

  /** Every document a line names, with where on the line it named it. Read per line, once. */
  const mentionCache = new Map();
  const mentionsOn = (doc, lines, index) => {
    const key = `${doc.rel}:${index}`;
    if (mentionCache.has(key)) return mentionCache.get(key);
    const found = [];
    const line = lines[index] ?? '';
    const add = (at, end, name) => {
      const abs = findMentionedFile(doc, name);
      if (abs) found.push({ at, end, abs, rel: relative(repoRoot, abs).replace(/\\/g, '/') });
    };
    for (const m of line.matchAll(FILE_MENTION_RE)) add(m.index, m.index + m[0].length, m[1].replace(/[.,;:)]+$/, ''));
    for (const m of line.matchAll(DOC_NAME_RE)) {
      if (found.some((f) => m.index >= f.at && m.index + m[0].length <= f.end)) continue;
      add(m.index, m.index + m[0].length, m[1]);
    }
    found.sort((a, b) => a.at - b.at);
    mentionCache.set(key, found);
    return found;
  };

  /**
   * The document a section reference belongs to, read the way a reader reads it: the nearest document named before the
   * reference in the same sentence, else the nearest named earlier on the same line, else — when the reference sits in
   * a clause with no sentence end before it — the document named at the end of one of the three lines above, which is
   * how a hard-wrapped sentence reads. With no document named anywhere, the reference is about the document it sits
   * in: `§3.3 of this file` and `the note at the head of §5.1` are both that form.
   */
  const attributeSection = (doc, lines, index, at) => {
    const line = lines[index] ?? '';
    const before = line.slice(0, at);
    const boundaries = ['. ', ': ', '; ', '? ', '! '].map((p) => before.lastIndexOf(p));
    const sentenceStart = Math.max(-1, ...boundaries) + 1;
    const here = mentionsOn(doc, lines, index);
    const inSentence = here.filter((m) => m.at >= sentenceStart && m.at < at);
    if (inSentence.length > 0) return inSentence.at(-1);
    const onLine = here.filter((m) => m.at < at);
    if (onLine.length > 0) return onLine.at(-1);
    if (/[.!?]\s/.test(before)) return null;
    for (let back = 1; back <= 3 && index - back >= 0; back += 1) {
      const prev = lines[index - back] ?? '';
      if (/[.!?:;]\s*$/.test(prev)) break;
      const above = mentionsOn(doc, lines, index - back);
      if (above.length > 0) return above.at(-1);
    }
    return null;
  };

  /** The section references a line carries: `§9.1`, `§"Cells"`, and a named heading right after a document name. */
  const sectionRefsOn = (doc, lines, index) => {
    const line = lines[index] ?? '';
    const refs = [];
    for (const m of line.matchAll(SECTION_REF_RE)) {
      const quoted = m[1] ?? m[2];
      const anchor = quoted ?? m[3];
      if (!anchor) continue;
      refs.push({ at: m.index, raw: m[0], anchor, quoted: Boolean(quoted) });
      // `§5-6` names two sections, and both are read: the tree writes a range as `§5–§6`, and this keeps the rarer
      // hyphenated spelling from being resolved as one anchor that matches nothing.
      const second = quoted ? null : SECTION_RANGE_RE.exec(line.slice(m.index + m[0].length));
      if (second) refs.push({ at: m.index, raw: `${m[0]}-${second[1]}`, anchor: second[1], quoted: false });
    }
    for (const mention of mentionsOn(doc, lines, index)) {
      const after = line.slice(mention.end);
      // A name may be backticked, and the heading it names may follow in quotes (`` `docs/X.md` "A heading" ``) —
      // the form a document uses when it names a section without the `§`. Nothing else may sit between them.
      const q = /^[`\s]*(?:"([^"\n]{2,140})"|\u201c([^\u201d\n]{2,140})\u201d)/.exec(after);
      if (!q) continue;
      const anchor = q[1] ?? q[2];
      refs.push({ at: mention.end + q[0].indexOf(anchor), raw: `"${anchor}"`, anchor, quoted: true, mention });
    }
    refs.sort((a, b) => a.at - b.at);
    return refs;
  };

  for (const doc of documents) {
    const sections = markSections(doc);
    const withLines = { ...doc, lines: sections.lines };
    for (let i = 0; i < sections.lines.length; i += 1) {
      const line = sections.lines[i];
      if (sections.inFence[i]) continue;
      for (const m of line.matchAll(REF_ROOT_RE)) {
        const raw = m[1].replace(/[.,;:)]+$/, '');
        // A path with a placeholder (`round-<id>/`) or a glob (`*.md`) names a shape, not a file. The brace form is
        // different and is expanded below, because `route.{light,dark}.svg` does name two files exactly.
        if (/[<>*]/.test(raw)) continue;
        // A brace-expanded pair (`route.{light,dark}.svg`) names two files, not one path with a brace in it. Both
        // members must exist; the expression itself is never reported as a missing path.
        const members = braceExpand(raw).filter((member) => !member.includes('..'));
        if (members.length === 0) continue;
        // A match that ends in `-` or `/` came from a placeholder it could not consume (`round-<id>/`) or a URL
        // escape (`%7Bl`), not from a real path. Naming a shape is not naming a file.
        if (/(?:[-/]|%[0-9A-Fa-f]{2})$/.test(raw)) continue;
        const unresolved = members.filter((member) => !resolveReference(doc, member).ok);
        const exists = unresolved.length === 0;
        const planned = KNOWN_PLANNED_PATHS.has(raw);
        const nearby = contextAround(withLines, i, m);
        const stated = !planned && NEAR_ABSENCE_RE.test(nearby);
        if (process.env.S1CAP_DOC_POINTERS_DEBUG && !exists && !planned && !stated) process.stderr.write(`[debug] missing ${raw} in ${doc.rel}:${i + 1}\n`);
        const record = {
          kind: 'dead-reference',
          file: doc.rel,
          line: i + 1,
          target: raw,
          members,
          status: exists ? 'resolves' : planned ? 'planned' : stated ? 'stated-absent' : 'missing',
          history: isHistorical(doc, i, sections),
          why: exists
            ? members.length > 1
              ? `${raw} expands to ${members.join(' and ')}, and both exist`
              : `${raw} exists in the tree`
            : planned
              ? `${raw} is a documented planned path — ${KNOWN_PLANNED_PATHS.get(raw)} — not flagged`
              : stated
                ? `${unresolved.join(', ')} does not exist, and the passage says so (planned/unwritten) — not flagged`
                : `${unresolved.join(', ')} does not exist from the document, the project root or the workspace`,
        };
        checks.push(record);
        // A dead reference is a dead reference in a record too: the pointer is read, so it has to resolve. History
        // exempts a *value* from being current; it does not exempt a file name from existing.
        if (!exists && !planned && !stated) findings.push({ ...record, message: `${unresolved.join(', ')} does not exist in the tree` });
      }
      for (const m of line.matchAll(REF_DOC_RE)) {
        const raw = m[1].replace(/[.,;:)]+$/, '');
        if (raw.endsWith('/*.md') || raw.endsWith('/*') || /[<>*]/.test(raw)) continue;
        const members = braceExpand(raw);
        const unresolved = members.filter((member) => !resolveReference(doc, member).ok);
        const exists = unresolved.length === 0;
        const planned = KNOWN_PLANNED_PATHS.has(raw) || PLANNED_RE.test(line);
        const record = {
          kind: 'dead-reference',
          file: doc.rel,
          line: i + 1,
          target: raw,
          members,
          status: exists ? 'resolves' : planned ? 'planned' : 'missing',
          history: isHistorical(doc, i, sections),
          why: exists ? `${raw} exists` : planned ? `${raw} does not exist, and the passage says so — not flagged` : `${raw} does not exist`,
        };
        checks.push(record);
        if (!exists && !planned) findings.push({ ...record, message: `${raw} does not exist in the tree` });
      }
      // Section anchors: the reader follows the number, so the number has to exist in the file that is named.
      for (const ref of sectionRefsOn(doc, sections.lines, i)) {
        const mention = ref.mention ?? attributeSection(doc, sections.lines, i, ref.at);
        const targetAbs = mention ? mention.abs : doc.abs;
        const targetRel = mention ? mention.rel : doc.rel;
        const headings = readHeadings(targetAbs);
        const found = resolveAnchor(headings, ref.anchor);
        const history = isHistorical(doc, i, sections);
        // A bare anchor with no document named is read against the document it sits in — but only when that document
        // numbers its own sections (or, for a named anchor, has headings at all). `… implements §8's protocol` inside
        // a gate note with no numbering of its own is about a document the sentence never names, and guessing that it
        // is about *this* file is precisely the "checker that cries wolf" failure this tool refuses.
        const unreadable = !mention && (ref.quoted ? headings.headings.length === 0 : headings.numbers.size === 0);
        const record = {
          kind: 'dead-section',
          file: doc.rel,
          line: i + 1,
          target: ref.raw.trim(),
          section: ref.anchor,
          inFile: targetRel,
          sameDocument: !mention,
          status: found.ok ? 'resolves' : unreadable ? 'unread' : 'missing',
          history,
          headings: headings.headings.map((h) => (h.number ? `§${h.number} ${h.text}` : `"${h.text}"`)),
          why: found.ok
            ? `${targetRel} has ${found.how}`
            : unreadable
              ? `${ref.raw.trim()} names no document, and this document has no ${ref.quoted ? 'headings' : 'numbered sections'} of its own to read it against — counted, not flagged`
              : `${ref.raw.trim()} names no anchor in ${targetRel}, which has ${headings.headings.length} heading(s)`,
        };
        checks.push(record);
        if (found.ok || unreadable) continue;
        const where = mention ? `\`${targetRel}\`` : 'this document';
        // The finding itself carries the headings the file does have, so the reader's fix is mechanical. The
        // informational form keeps the sentence short: nobody edits a record to match today's numbering.
        const message = history
          ? `${ref.raw.trim()} names no anchor in ${where} — left alone: this passage is a record`
          : `${ref.raw.trim()} names no ${ref.quoted ? 'heading' : 'section'} in ${where} — it has ${headingListText(headings)}`;
        // An anchor that no longer exists inside a record is reported and counted, never failed: a frozen archive is
        // full of numbering that has moved, and `docs/DOC-CONTRACT.md` §4 forbids rewriting it to match today.
        if (history) records.push({ ...record, message });
        else findings.push({ ...record, message });
      }
      // Policy fields: a knob that was removed, or a path the policy never declared.
      for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)`/g)) {
        const span = m[1];
        const parts = span.split('.');
        // `window.__ModuleLoader__` and `x.y` in prose are dotted names, not policy paths: a root that is not a
        // declared field, a global, or a dunder is not read as a knob. Skipping is the honest choice — flagging it
        // would be the "checker that cries wolf" failure this tool exists to avoid.
        if (NON_POLICY_ROOTS.has(parts[0]) || parts.some((part) => part.startsWith('__'))) continue;
        const rooted = policy.containers.has(parts[0]) || KNOB_ALIASES[span] || KNOB_ALIASES[parts[0]];
        if (!rooted) continue;
        const canonical = policy.hasPath(span) ? span : KNOB_ALIASES[span] ?? (policy.hasPath(parts[0]) ? parts[0] : null);
        // A declared leaf is a restatement (rule 2). A declared container (`s1`, `recall`) is a pointer to a whole
        // block and is exactly what DOC-CONTRACT asks a document to write instead of a copy.
        if (canonical || policy.containers.has(span)) continue;
        const known = policy.containers.has(parts[0]);
        const history = isHistorical(doc, i, sections);
        const record = {
          kind: 'dead-policy-field',
          file: doc.rel,
          line: i + 1,
          target: span,
          status: history ? 'recorded' : 'missing',
          history,
          why: known
            ? `\`${parts[0]}\` is declared in ${policy.relFile}, but it has no \`${parts.slice(1).join('.')}\` — the field was removed or never existed`
            : `no policy path \`${span}\` under ${policy.relFile} (root \`${parts[0]}\` is not an AssemblyPolicy field)`,
        };
        // This document is a record (a frozen file or a dated section): a field that existed then and not now is what
        // the record says, so it is reported and counted, not failed — DOC-CONTRACT §4 forbids rewriting it.
        if (history) {
          checks.push(record);
          records.push({ ...record, message: `removed/absent policy field \`${span}\` — left alone: this passage is a record` });
          continue;
        }        findings.push({ ...record, message: known ? `removed/absent policy field \`${span}\`` : `unknown policy path \`${span}\`` });
      }
    }
  }
  return { checks, findings, records };
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 2 — value claims the code owns
// ---------------------------------------------------------------------------------------------------------------

/** Cells named on a line, with the index they appear at. `C0test` is a profile name and does not match. */
function cellMentions(line) {
  const out = [];
  const re = new RegExp(`cellPolicy\\(\\s*['"]${CELL_TOKEN}['"]\\s*\\)|\`${CELL_TOKEN}\`|\\b${CELL_TOKEN}\\b`, 'g');
  for (const m of line.matchAll(re)) out.push({ cell: m[1] ?? m[2] ?? m[3], at: m.index });
  return out;
}

/** The sentence a claim sits in — a claim may not borrow a cell name from a different sentence. */
function sentenceBounds(line, index) {
  let start = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (/[.!?]/.test(line[i]) && (i + 1 >= line.length || /\s/.test(line[i + 1])) && !(/[\d)]/.test(line[i - 1] ?? ''))) {
      if (index < i) return [start, i];
      start = i + 1;
    }
  }
  return [start, line.length];
}

/** A `key: value` claim is attributed to the nearest cell name in its own sentence, nearest-first. */
function attributeCell(line, index) {
  const [start, end] = sentenceBounds(line, index);
  const mentions = cellMentions(line).filter((m) => m.at >= start && m.at <= end);
  if (mentions.length === 0) return null;
  const before = mentions.filter((m) => m.at < index);
  const pool = before.length > 0 ? before : mentions.filter((m) => m.at > index);
  const nearest = pool.sort((a, b) => Math.abs(a.at - index) - Math.abs(b.at - index))[0];
  if (!nearest) return null;
  // 160 characters is roughly one clause; further than that and the cell name is about something else.
  if (Math.abs(nearest.at - index) > 160) return null;
  return nearest.cell;
}

function claimMatches(value, text) {
  const want = String(value);
  if (want === text) return true;
  if (/^-?[\d.]+$/.test(want) && /^-?[\d.]+$/.test(text)) return Number(want) === Number(text);
  if (want === 'true' && (text === 'on' || text === 'yes')) return true;
  if (want === 'false' && (text === 'off' || text === 'no')) return true;
  if (want === 'on' && text === 'true') return true;
  if (want === 'off' && text === 'false') return true;
  return false;
}

export function checkValueClaims({ repoRoot, documents, policy }) {
  const info = [];
  const findings = [];
  const effectiveCache = new Map();
  const effectiveFor = (cell) => {
    if (!effectiveCache.has(cell)) {
      const computed = effectivePolicy(policy, repoRoot, cell);
      if (process.env.S1CAP_DOC_POINTERS_DEBUG) process.stderr.write(`[debug] effective(${cell}) deliver=${JSON.stringify(computed?.policy?.deliver)} preset=${JSON.stringify(computed?.preset?.config)} from ${repoRoot}\n`);
      effectiveCache.set(cell, computed);
    }
    return effectiveCache.get(cell);
  };
  for (const doc of documents) {
    const sections = markSections(doc);
    for (let i = 0; i < sections.lines.length; i += 1) {
      const line = sections.lines[i].replace(/\\\|/g, '¦');
      if (sections.inFence[i]) continue;
      const history = isHistorical(doc, i, sections);
      const sentenceHistory = (index) => {
        const [a, b] = sentenceBounds(line, index);
        return HISTORY_RE.test(line.slice(a, b));
      };
      for (const m of line.matchAll(CLAIM_RE)) {
        const key = m[1];
        const declared = policy.hasPath(key) ? key : KNOB_ALIASES[key];
        if (!declared || !policy.hasPath(declared)) continue;
        let text = m[2];
        if (/^['"]/.test(text)) text = text.slice(1, -1);
        // A value that is itself a path ("`w = recall.window`") is a pointer, not a value claim.
        if (policy.hasPath(text) || declared.startsWith(`${text}.`)) continue;

        const cell = attributeCell(line, m.index);
        const claimsDefault = /defaultPolicy\(\)|\bby default\b|\bdefaults? to\b/i.test(line);
        // History is read at the sentence the claim sits in, not the whole line and not the paragraph: a claim that
        // says "sets `deliver: true` today" is a statement about now even on a line that also says "was".
        const asRecord = history || sentenceHistory(m.index);
        const restatement = {
          file: doc.rel,
          line: i + 1,
          key: declared,
          asWritten: key,
          stated: text,
          cell,
          scope: cell ? `cell ${cell}` : claimsDefault ? 'defaultPolicy()' : 'unattributed',
          history: asRecord,
          text: sections.lines[i].trim().slice(0, 160),
        };
        if (!cell && !claimsDefault) { info.push({ ...restatement, why: 'no cell or defaultPolicy() attribution in the sentence — counted, not flagged' }); continue; }
        // A cell name the scheme no longer has (the dropped `C3`, the old four-cell labels) is history by
        // definition: the round-label table of `docs/AGENT_BRIEF.md` §"Experiment design (three arms: two controls,
        // one arm under test)" maps those labels, and `cellPolicy()` has no entry to compare against.
        if (cell && !policy.cellPolicy(cell)) {
          info.push({ ...restatement, why: `\`${cell}\` has no entry in cellPolicy() — an earlier labelling, mapped by the round-label table of docs/AGENT_BRIEF.md §"Experiment design (three arms: two controls, one arm under test)"; no current value to compare against` });
          continue;
        }
        const policies = cell ? [effectiveFor(cell)] : [{ policy: policy.defaults, preset: null }];
        const actual = policies.map((p) => ({ policy: p.policy, preset: p.preset, got: policy.valueAt(p.policy, declared) }));
        if (process.env.S1CAP_DOC_POINTERS_DEBUG && cell) process.stderr.write(`[debug] claim ${declared}=${text} cell ${cell} -> ${JSON.stringify(actual.map((a) => a.got))} (defaults deliver=${JSON.stringify(policy.defaults.deliver)}, cellPolicy deliver=${JSON.stringify(policy.cellPolicy(cell)?.deliver)})\n`);
        const mismatched = actual.filter((a) => !a.got.ok || !claimMatches(a.got.value, text));
        if (mismatched.length === 0) {
          info.push({ ...restatement, why: `matches ${restatement.scope}: ${actual.map((a) => String(a.got.value)).join(', ')}` });
          continue;
        }
        if (restatement.history) {
          info.push({ ...restatement, why: `the passage is a record ("${HISTORY_RE.exec(sections.lines[i])?.[0] ?? 'frozen file'}", or a dated record) — a copy that was true then is not a stale pointer` });
          continue;
        }
        const owner = cell ? `${policy.relFile} cellPolicy('${cell}')` : `${policy.relFile} defaultPolicy()`;
        findings.push({
          kind: 'stale-value',
          ...restatement,
          owner,
          code: actual.map((a) => `${a.got.ok ? String(a.got.value) : 'absent'}${a.preset ? ` (preset bench/cells/${cell}.json)` : ''}`).join(', '),
          message: `states \`${key}: ${text}\` for ${restatement.scope}, but ${owner} says ${actual.map((a) => (a.got.ok ? String(a.got.value) : 'absent')).join(', ')}`,
        });
      }
    }
  }
  return { info, findings };
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 3 — a preset may not carry a switch the code owns
// ---------------------------------------------------------------------------------------------------------------

export function checkPresetOverrides({ repoRoot, policy }) {
  const info = [];
  const findings = [];
  const cellsDir = join(repoRoot, 'bench', 'cells');
  if (!existsSync(cellsDir)) return { info, findings };
  for (const name of readdirSync(cellsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const rel = `bench/cells/${name}`;
    const cellFromName = name.replace(/\.json$/, '');
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(cellsDir, name), 'utf8'));
    } catch (error) {
      findings.push({ kind: 'preset-override', file: rel, line: 1, target: name, message: `${rel} is not parseable JSON: ${error.message}` });
      continue;
    }
    for (const key of CODE_OWNED_SWITCHES) {
      if (key in raw) {
        findings.push({
          kind: 'preset-override',
          file: rel,
          line: lineOfKey(join(cellsDir, name), key),
          target: key,
          message: `preset carries \`${key}: ${JSON.stringify(raw[key])}\`, which ${policy.relFile} owns — a value here silently overrides the cell`,
        });
      }
    }
    if ('cell' in raw && raw.cell !== cellFromName) {
      findings.push({ kind: 'preset-override', file: rel, line: lineOfKey(join(cellsDir, name), 'cell'), target: 'cell', message: `preset says \`cell: ${JSON.stringify(raw.cell)}\` but is named for ${cellFromName}` });
    }
    if (!raw._meta) findings.push({ kind: 'preset-override', file: rel, line: 1, target: '_meta', message: `${rel} carries no \`_meta\` block naming its role` });
    for (const [k, v] of Object.entries(raw)) {
      if (k === '_meta') continue;
      const root = policy.containers.has(k);
      if (!root) {
        findings.push({ kind: 'preset-override', file: rel, line: lineOfKey(join(cellsDir, name), k), target: k, message: `preset config key \`${k}\` is not an AssemblyPolicy field — unknown keys are reported and ignored` });
        continue;
      }
      const nested = typeof v === 'object' && v !== null && !Array.isArray(v);
      const declared = policy.containers.has(k) && !policy.hasPath(k);
      if (!nested && !declared) continue;
      for (const [sub, subValue] of Object.entries(nested ? v : { [k]: v })) {
        const path = nested ? `${k}.${sub}` : k;
        if (!policy.hasPath(path)) {
          findings.push({ kind: 'preset-override', file: rel, line: lineOfKey(join(cellsDir, name), sub), target: path, message: `preset sets \`${path}\`, which ${policy.relFile} does not declare` });
        } else if (!claimMatches(policy.valueAt(policy.defaults, path).value, String(subValue))) {
          const base = policy.valueAt(policy.cellPolicy(cellFromName) ?? policy.defaults, path);
          const note = base.ok && claimMatches(base.value, String(subValue)) ? ' (it restates the cell preset: the code already owns this value)' : '';
          info.push({ file: rel, line: lineOfKey(join(cellsDir, name), sub), path, stated: String(subValue), code: base.ok ? String(base.value) : 'absent', why: `the preset sets this value${note}` });
        }
      }
    }
  }
  return { info, findings };
}

function lineOfKey(file, key) {
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = new RegExp(`"${key}"\\s*:`).exec(lines[i]);
      if (m) return i + 1;
    }
  } catch { /* unreadable: line 1 */ }
  return 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 4 — the pointer discipline itself, counted
// ---------------------------------------------------------------------------------------------------------------

/**
 * How many restated values a document still carries. This is the number the owner watches fall: every entry is a
 * sentence that copies something the code owns and that a pointer would replace. Informational by construction —
 * a copy that is still correct is not a defect yet, it is the next cascade.
 */
export function countRestatements({ documents, valueInfo, refChecks }) {
  const perDocument = new Map();
  const bump = (file, kind) => {
    const entry = perDocument.get(file) ?? { values: 0, references: 0, dead: 0, total: 0 };
    entry[kind] += 1;
    entry.total = entry.values + entry.references + entry.dead;
    perDocument.set(file, entry);
  };
  for (const item of valueInfo) bump(item.file, 'values');
  for (const ref of refChecks) {
    bump(ref.file, 'references');
    if (ref.status === 'missing') bump(ref.file, 'dead');
  }
  return [...perDocument.entries()]
    .map(([file, counts]) => ({ file, ...counts }))
    .sort((a, b) => b.total - a.total || a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test — synthetic fixtures that must fail loudly, in a temp directory that is removed afterwards
// ---------------------------------------------------------------------------------------------------------------

const FIXTURE_POLICY = `export const CORE_SCHEMA_VERSION = 1 as const;
export interface AssemblyPolicy { deliver: boolean; tracePlacement: 'trace-as-state' | 'trace-append'; recall: { tier1: 'off' | 's1'; threshold: number }; tas: { on: boolean } }
export function defaultPolicy(): AssemblyPolicy {
  return { cell: 'C2', deliver: false, tracePlacement: 'trace-as-state', recall: { tier1: 's1', threshold: 0.55 }, tas: { on: true } };
}
export function cellPolicy(cell: 'C0' | 'C1' | 'C2') {
  const p = defaultPolicy();
  p.cell = cell;
  switch (cell) {
    case 'C0':
      p.tas.on = false;
      p.recall.tier1 = 'off';
      p.deliver = false;
      break;
    case 'C1':
      p.tas.on = true;
      p.recall.tier1 = 'off';
      p.deliver = false;
      break;
    case 'C2':
      p.recall.tier1 = 's1';
      p.deliver = true;
      break;
  }
  return p;
}
`;

const FIXTURE_FILES = {
  'packages/core/src/types.ts': FIXTURE_POLICY,
  // The codes the documents below point at. `plan-gate.ts` exists here on purpose: a fixture that names an existing
  // source must resolve, or the check is useless.
  'packages/core/src/plan-gate.ts': '// fixture: the mechanism the plan gate removal kept\nexport const orderPlans = () => [];\n',
  'packages/dsh-plugin/src/plan-gate-runtime.ts': '// fixture: the plugin-side runtime kept with the mechanism\nexport const planGateRuntime = () => {};\n',
  'scripts/check-doc-pointers.mjs': '// placeholder so scripts/ resolves\n',
  // Brace-expanded figure pair: `docs/figures/route.{light,dark}.svg` must not be read as one dead path.
  'docs/figures/route.light.svg': '<svg/>\n',
  'docs/figures/route.dark.svg': '<svg/>\n',
  'bench/cells/C0.json': JSON.stringify({ _meta: { role: 'baseline' }, cell: 'C0', tas: { on: false }, recall: { tier1: 'off' } }, null, 2),
  'bench/cells/C1.json': JSON.stringify({ _meta: { role: 'second control' }, cell: 'C1', recall: { tier1: 'off' } }, null, 2),
  'bench/cells/C2.json': JSON.stringify({ _meta: { role: 'full configuration' }, cell: 'C2', recall: { tier1: 's1' } }, null, 2),
  // Live documents. The marker is the same one a record uses to declare a passage current; here it is what makes a
  // synthetic tree behave like `docs/`, which the live-document list names by path.
  'docs/GOOD.md': [
    LIVE_MARKER,
    '# A document that points instead of copying',
    '',
    'The switches are owned by `cellPolicy()` in `packages/core/src/types.ts`; this file does not repeat them.',
    'C1 delivers nothing, so its model-visible input is `C0`\'s (`docs/GOOD.md`).',
    '`recall.threshold: 0.55` is the value C2 runs.',
    'The two route figures are `docs/figures/route.{light,dark}.svg` — a brace-expanded pair, not one path.',
    'The window\'s arithmetic is `docs/HEADINGS.md` §2.1, and its statement is `docs/HEADINGS.md` §"Named section".',
    'The same heading is reachable as `docs/HEADINGS.md` "Recall window w" — a named heading, not a number.',
    'A record\'s own numbering is still its own: `docs/OLD-ARCHIVE.md` §1.',
    '',
  ].join('\n'),
  // The file every section fixture resolves against: numbers, a numbered subsection, named headings, a lettered
  // section and a label its body carries. Read from the file, never inferred from the document that points at it.
  'docs/HEADINGS.md': [
    '# Fixture: the real headings of a file',
    '',
    '## 1. First section',
    '',
    '## 2. Second section',
    '',
    '### 2.1 A numbered subsection',
    '',
    '## Named section',
    '',
    '## Recall window w (`recall.window`)',
    '',
    '## A. A lettered section',
    '',
    '| A. A label the body carries |',
    '',
  ].join('\n'),
  // Live document, dead anchors: a number that moved, a named heading that is gone, and the quoted form a document
  // uses when it names a section without a `§`. Each one is a finding of its own class, apart from `dead-reference`.
  'docs/DEAD-SECTIONS.md': [
    LIVE_MARKER,
    '# Fixture: dead section references',
    '',
    '## 1. A numbered heading of its own, so a bare anchor has something to resolve against',
    '',
    '`docs/HEADINGS.md` §9.9 is a number the file does not have, and it has numbers of its own.',
    'The ablation scheme is `docs/HEADINGS.md` §"Cells" — a named heading that does not exist.',
    'The old mapping is `docs/HEADINGS.md` "The names changed after round 20261001-1300 ran".',
    'An anchor with no file named is read against this document: §12 does not exist here, unlike `docs/HEADINGS.md` §2.1.',
    'A bare anchor in a document that numbers nothing of its own is counted, never flagged (see `docs/UNNUMBERED.md`).',
    '',
  ].join('\n'),
  // A document with no numbering of its own: a bare `§8` in it names a document the sentence does not name, so it is
  // counted as unread rather than resolved against a file that has nothing to resolve it against.
  'docs/UNNUMBERED.md': [
    LIVE_MARKER,
    '# Fixture: a document with headings but no numbering',
    '',
    'The tool implements §8 of a document nobody named here.',
    '',
  ].join('\n'),
  // Frozen by its own name (`*ARCHIVE*.md`), so the numbering it quotes may not be flagged: a record is not edited.
  // Its own anchors are dead, and they have to be reported as informational rather than failed.
  'docs/OLD-ARCHIVE.md': [
    '# An archive whose numbering has moved — frozen, never edited',
    '',
    '## 1. What the round recorded',
    '',
    'That round used `docs/HEADINGS.md` §9.9 and `docs/HEADINGS.md` §"Cells"; neither exists today.',
    '',
  ].join('\n'),
  'docs/DEAD-POINTERS.md': [
    LIVE_MARKER,
    '# Dead references',
    '',
    'The gate lives in `packages/core/src/plan-gate.ts` and its runtime in `packages/dsh-plugin/src/plan-gate-runtime.ts`.',
    'The removed knob was `recall.timeoutMs`, and `packages/proxy` is not written yet.',
    'See `scripts/does-not-exist.mjs` for the sweep, and `docs/ALSO-MISSING.md` for the record.',
    '',
  ].join('\n'),
  'docs/STALE-COPIES.md': [
    LIVE_MARKER,
    '# A copy that went stale',
    '',
    '`C1` sets `deliver: true` today, beside `recall.tier1: \'off\'`.',
    '`C2` runs the full configuration with `recall.tier1: \'embed\'`.',
    // `tracePlacement` is the only layout axis, and the code names it, so a wrong value for it is the same class of
    // finding as a wrong `deliver`.
    '`C1` runs `tracePlacement: \'trace-append\'`, the control arm.',
    // The deleted question axis, asserted as absent rather than left untested: this line states a value for a path
    // the policy does not have, so it is not a value claim and no `stale-value` finding can be its reading. If the
    // field ever comes back, the line starts resolving and the assertion on it fails — which is the point of it.
    '`C2` runs `questionPlacement: \'first\'`, a layout the paper has no condition for.',
    '',
  ].join('\n'),
  'docs/DATED-RECORD.md': [
    LIVE_MARKER,
    '# A record that must not be flagged',
    '',
    '`C1` carried `deliver: true` until 2026-10-02 and could never fire, so it is a second control arm today.',
    'The arm then read as TAS alone; `recall.tier1` said `embed` previously and is `s1` now.',
    '',
  ].join('\n'),
  // Field case (a): the archive a live document is split into. Full of values the code no longer has, and none of
  // them may be flagged — the file is a record by its own name.
  'docs/STATUS-ARCHIVE.md': [
    '# the archived status entries — frozen',
    '',
    '`C2` declared `recall.tier1: "embed"` and carried `deliver: true`; `recall.tau` was the threshold then.',
    'The profile patched `cell: C4` and the arm delivered nothing.',
    '',
  ].join('\n'),
  // Field case (a), second form: a derived table that labels its own inputs and date, as `docs/FORMULAS.md` does.
  'docs/DERIVED-TABLE.md': [
    '# a derived table, labelled with its inputs and its date',
    '',
    'Derived 2026-10-01 from the round `20261001-1300` control plane; recompute if the policy moves.',
    '',
    '| quantity | C1 | C2 |',
    '| --- | --- | --- |',
    '| `deliver` at the time | true | true |',
    '| `recall.tier1` then | off | embed |',
    '',
  ].join('\n'),
};

const FIXTURE_BAD_PRESET = JSON.stringify({ _meta: { role: 'a preset that takes a switch back' }, cell: 'C9', deliver: true, tracePlacement: 'trace-append', recall: { tier1: 'off' } }, null, 2);

function writeFixtureRepo(dir) {
  for (const [rel, text] of Object.entries(FIXTURE_FILES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  // A separate preset, so the switch-claim fixtures above keep the presets the code and files agree on.
  writeFileSync(join(dir, 'bench/cells/C4.json'), FIXTURE_BAD_PRESET, 'utf8');
}

/**
 * `--self-test`: build a synthetic tree in a temp directory, run the real rules over it, and fail loudly if any
 * fixture behaves differently than declared. The fixtures that matter most: a dead reference must be a finding, a
 * wrong switch claim must be a finding, a section anchor that has moved must be a finding, and a legitimate
 * historical mention — a past-tense value, or a dead anchor inside a frozen archive — must NOT be one.
 */
export function selfTest({ quiet = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-doc-pointers-'));
  const lines = [];
  const problems = [];
  const say = (text) => { lines.push(text); if (!quiet) console.log(text); };
  try {
    writeFixtureRepo(dir);
    const report = run({ repoRoot: dir, documents: collectDocuments(dir), quiet: true });
    const fixtureTree = [];
    const walkFixture = (base, depth) => {
      if (depth > 4) return;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const abs = join(base, entry.name);
        fixtureTree.push(`${relative(dir, abs).replace(/\\/g, '/')}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory()) walkFixture(abs, depth + 1);
      }
    };
    walkFixture(dir, 0);
    const kinds = (list) => list.map((f) => `${f.kind} ${f.file}:${f.line}`);

    const expect = (label, ok, detail) => {
      say(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
      if (!ok) problems.push(label);
    };

    say('self-test fixtures (synthetic tree in a temp directory):');
    const dead = report.findings.filter((f) => f.kind === 'dead-reference');
    expect('a dead script reference is a finding', dead.some((f) => f.target === 'scripts/does-not-exist.mjs'), kinds(dead).join('; '));
    expect('a dead document reference is a finding', dead.some((f) => f.target === 'docs/ALSO-MISSING.md'));
    expect('a removed policy field is a finding', report.findings.some((f) => f.kind === 'dead-policy-field' && f.target === 'recall.timeoutMs'));
    expect('an existing source reference is not a finding', !dead.some((f) => f.target === 'packages/core/src/plan-gate.ts' || f.target === 'packages/dsh-plugin/src/plan-gate-runtime.ts' || f.target === 'scripts/check-doc-pointers.mjs'));
    expect('a reference the sentence marks as unwritten is not a finding', !dead.some((f) => f.target === 'packages/proxy'));
    expect('a brace-expanded pair whose members both exist is not a finding', !dead.some((f) => f.target.includes('{')), kinds(dead).join('; '));
    expect('both members of a brace-expanded pair are checked', report.checks.some((c) => c.target === 'docs/figures/route.{light,dark}.svg' && c.members.length === 2 && c.status === 'resolves'));

    // Section anchors (`dead-section`): resolved against the headings of the file that is named, never against
    // another document, and never flagged when the passage carrying them is a record.
    const anchors = report.checks.filter((c) => c.kind === 'dead-section');
    const deadSections = report.findings.filter((f) => f.kind === 'dead-section');
    expect('a valid `§N.M` reference resolves and is not a finding', anchors.some((c) => c.section === '2.1' && c.inFile === 'docs/HEADINGS.md' && c.status === 'resolves') && !deadSections.some((f) => f.section === '2.1'), kinds(deadSections).join('; '));
    expect('a valid named-heading reference resolves and is not a finding', anchors.some((c) => c.section === 'Named section' && c.status === 'resolves'), kinds(deadSections).join('; '));
    expect('a named heading right after a document name resolves too', anchors.some((c) => c.section === 'Recall window w' && c.status === 'resolves'));
    expect('a number that does not exist in a file that has other numbers is a finding', deadSections.some((f) => f.section === '9.9' && f.inFile === 'docs/HEADINGS.md'), kinds(deadSections).join('; '));
    expect('a named-heading reference that does not exist is a finding', deadSections.some((f) => f.section === 'Cells'));
    expect('the quoted heading form is a finding too', deadSections.some((f) => f.section === 'The names changed after round 20261001-1300 ran'));
    expect('an anchor with no document named is read against the document it sits in', deadSections.some((f) => f.section === '12' && f.sameDocument === true && f.inFile === 'docs/DEAD-SECTIONS.md'));
    expect('a bare anchor in a document that numbers nothing is counted, never flagged', anchors.some((c) => c.file === 'docs/UNNUMBERED.md' && c.status === 'unread') && !deadSections.some((f) => f.file === 'docs/UNNUMBERED.md'), kinds(deadSections.filter((f) => f.file === 'docs/UNNUMBERED.md')).join('; '));
    expect('the finding names the headings the file does have, so the fix is mechanical', deadSections.some((f) => f.section === '9.9' && /§2\.1 A numbered subsection/.test(f.message)), deadSections.find((f) => f.section === '9.9')?.message);
    expect('a dead anchor in a frozen record is not a finding', !deadSections.some((f) => f.file === 'docs/OLD-ARCHIVE.md'), kinds(deadSections.filter((f) => f.file === 'docs/OLD-ARCHIVE.md')).join('; '));
    expect('and it is still reported as informational', report.history.some((h) => h.kind === 'dead-section' && h.file === 'docs/OLD-ARCHIVE.md' && h.section === '9.9'));
    expect('a live document whose anchors all resolve carries no dead-section finding', !deadSections.some((f) => f.file === 'docs/GOOD.md'), kinds(deadSections.filter((f) => f.file === 'docs/GOOD.md')).join('; '));
    expect('section anchors are counted separately from dead references', report.summary.sections === anchors.length && report.summary.deadSections === anchors.filter((c) => c.status === 'missing').length, JSON.stringify({ sections: report.summary.sections, deadSections: report.summary.deadSections, checks: anchors.length }));
    // The three frozen-record classes the exemption has to cover, asserted on the predicate itself: a round directory,
    // an archive by its own name, and a dated STATUS section that marks itself as history.
    const frozenRound = { rel: 'round-20261001-1300/ROUND-REPORT.md', text: '# ROUND-REPORT\n\nSee §9.9 and `docs/HEADINGS.md` §9.9.\n' };
    const frozenStatus = { rel: 'docs/STATUS.md', text: '# status\n\n## 8. Round of 2026-10-01: token accounting is retired\n\nSee §9.9.\n' };
    const liveDoc = { rel: 'docs/FORMULAS.md', text: '# formulas\n\n## 2. Association graph\n\nSee §9.9.\n' };
    expect('a section reference inside a round directory is a record (not flagged)', isHistorical(frozenRound, 2, markSections(frozenRound)) === true);
    expect('a section reference inside a dated STATUS section that marks itself as history is a record', isHistorical(frozenStatus, 4, markSections(frozenStatus)) === true);
    expect('and a section in a live document is not a record', isHistorical(liveDoc, 4, markSections(liveDoc)) === false);

    const stale = report.findings.filter((f) => f.kind === 'stale-value');
    expect('a wrong deliver claim for C1 is a finding', stale.some((f) => f.key === 'deliver' && f.cell === 'C1' && f.stated === 'true'), kinds(stale).join('; '));
    expect('a wrong tier1 claim for C2 is a finding', stale.some((f) => f.key === 'recall.tier1' && f.cell === 'C2' && f.stated === 'embed'));
    expect('a correct claim is not a finding', !stale.some((f) => f.file === 'docs/GOOD.md'), kinds(stale.filter((f) => f.file === 'docs/GOOD.md')).join('; '));
    // `tracePlacement` is the layout axis the code names, so a document claiming the wrong arm must be a finding
    // rather than silently unchecked.
    expect('a wrong tracePlacement claim for C1 is a finding', stale.some((f) => f.key === 'tracePlacement' && f.cell === 'C1' && f.stated === 'trace-append'), kinds(stale).join('; '));
    // The deleted question axis (`questionPlacement`, removed on 2026-10-05 and not renamed): a document still
    // stating a value for it is stating it against a path the policy does not have, so it is not a value claim and
    // no `stale-value` finding is its reading. Pinned rather than dropped, so the deletion is asserted: if the field
    // ever returns, the fixture line above starts resolving and this expectation fails.
    expect('a claim about the deleted question axis is not a value claim (the field is gone)', !stale.some((f) => f.key === 'questionPlacement' || f.asWritten === 'questionPlacement'), kinds(stale).join('; '));
    expect('a dated record is not flagged for a value it states in the past tense', !stale.some((f) => f.file === 'docs/DATED-RECORD.md'), kinds(stale).join('; '));
    expect('the dated record is still reported as informational', report.history.some((h) => h.file === 'docs/DATED-RECORD.md' && h.key === 'deliver'));
    // Field cases verified by hand in this session.
    expect('an archive of old values is not flagged (field case a)', !stale.some((f) => f.file === 'docs/STATUS-ARCHIVE.md') && !report.findings.some((f) => f.file === 'docs/STATUS-ARCHIVE.md'), kinds(stale.filter((f) => f.file === 'docs/STATUS-ARCHIVE.md')).join('; '));
    expect('a derived table labelled with its inputs and date is not flagged (field case a)', !report.findings.some((f) => f.file === 'docs/DERIVED-TABLE.md'), kinds(report.findings.filter((f) => f.file === 'docs/DERIVED-TABLE.md')).join('; '));
    expect('a brace-expanded figure pair resolves (field case b)', report.checks.some((c) => c.target === 'docs/figures/route.{light,dark}.svg' && c.status === 'resolves' && c.members.length === 2));

    const preset = report.findings.filter((f) => f.kind === 'preset-override');
    expect('a code-owned switch written into a preset is a finding', preset.some((f) => f.file === 'bench/cells/C4.json' && f.target === 'deliver'), kinds(preset).join('; '));
    expect('the code-owned layout axis written into a preset is a finding', preset.some((f) => f.file === 'bench/cells/C4.json' && f.target === 'tracePlacement'), kinds(preset).join('; '));
    expect('a preset whose `cell` disagrees with its own file name is a finding', preset.some((f) => f.file === 'bench/cells/C4.json' && f.target === 'cell'), kinds(preset).join('; '));
    expect('the presets the code agrees with are not findings', !preset.some((f) => ['bench/cells/C0.json', 'bench/cells/C1.json', 'bench/cells/C2.json'].includes(f.file)), kinds(preset).join('; '));

    expect('the dead-reference finding is fatal (exit 1)', report.exitCode === 1, `exit ${report.exitCode}`);
    expect('the pointer counts are reported per document', report.restatements.some((r) => r.file === 'docs/GOOD.md'), JSON.stringify(report.restatements));
    say(`self-test: ${problems.length === 0 ? 'PASS' : `FAIL (${problems.length})`} — ${report.summary.findings} finding(s), ${report.info.length} informational, ${report.checks.length} reference(s) checked, ${report.summary.sections} section anchor(s) resolved`);
    return { ok: problems.length === 0, problems, lines, report, fixtureTree };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runner and CLI
// ---------------------------------------------------------------------------------------------------------------

export function run({ repoRoot, documents, quiet = false, ablationRoot = null }) {
  const docs = documents ?? collectDocuments(repoRoot, { ablationRoot });
  const policy = readPolicySource(repoRoot);
  const tree = fileSet(repoRoot);
  const dead = checkDeadReferences({ repoRoot, documents: docs, tree, policy });
  const values = checkValueClaims({ repoRoot, documents: docs, policy });
  const presets = checkPresetOverrides({ repoRoot, policy });
  const restatements = countRestatements({ documents: docs, valueInfo: values.info, refChecks: dead.checks });

  const findings = [...dead.findings, ...values.findings, ...presets.findings]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
  // Informational, in one list: a passage left alone because it is a record — a value stated in the past tense, a
  // policy field that existed then, an anchor that has moved since. None of them changes the exit code.
  const history = [...values.info.filter((i) => i.history), ...dead.findings.filter((f) => f.history), ...dead.records];
  const info = values.info.filter((i) => !i.history);
  const sections = dead.checks.filter((c) => c.kind === 'dead-section');
  const deadSections = sections.filter((c) => c.status === 'missing');

  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  return {
    tool: TOOL,
    version: VERSION,
    root: repoRoot,
    policySource: policy.relFile,
    documents: docs.map((d) => d.rel),
    summary: {
      documents: docs.length,
      references: dead.checks.length,
      sections: sections.length,
      deadSections: deadSections.length,
      claims: values.findings.length + values.info.length,
      findings: findings.length,
      informational: info.length,
      byKind,
    },
    findings,
    info,
    history,
    restatements,
    checks: dead.checks,
    exitCode: findings.length > 0 ? 1 : 0,
  };
}

export function formatReport(report, { verbose = false } = {}) {
  const out = [];
  const { summary } = report;
  out.push(`${TOOL}: ${summary.documents} document(s), ${summary.references} reference(s) (${summary.sections} section anchor(s)), ${summary.claims} value claim(s)`);
  if (summary.findings === 0) {
    out.push(`PASS — no document names a file, a policy field or a section the tree does not have, and no live value claim contradicts ${report.policySource}`);
  } else {
    out.push(`FAIL — ${summary.findings} finding(s): ${Object.entries(summary.byKind).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    for (const f of report.findings) {
      out.push(`  ${f.file}:${f.line}: [${f.kind}] ${f.message}`);
      if (verbose && f.text) out.push(`      quote: ${f.text}`);
      if (verbose && f.owner) out.push(`      owner: ${f.owner}`);
    }
  }
  out.push('');
  out.push('informational — restated values per document (watch this fall; a copy is a future cascade, not a finding):');
  for (const r of report.restatements) out.push(`  ${String(r.total).padStart(4)}  ${r.file}  (values ${r.values}, references ${r.references}, dead ${r.dead})`);
  if (report.history.length > 0) {
    out.push('');
    out.push(`informational — ${report.history.length} passage(s) left alone because they are records, not statements about today:`);
    for (const h of report.history) out.push(`  ${h.file}:${h.line}: ${h.why}${h.text ? `\n      quote: ${h.text}` : ''}`);
  }
  if (verbose) {
    out.push('');
    out.push(`informational — ${report.info.length} attributed claim(s) that agree with the code:`);
    for (const i of report.info) out.push(`  ${i.file}:${i.line}: ${i.key} = ${i.stated} — ${i.why}`);
  }
  return out.join('\n');
}

function usage(message) {
  return [
    message ? `${TOOL}: ${message}` : `${TOOL}: the documentation pointer check`,
    '',
    `usage: node scripts/check-doc-pointers.mjs [--check] [--json] [--root <dir>] [--quiet] [--verbose] [--self-test]`,
    '',
    '  --check      run the check (the default; this tool never writes to the tree)',
    '  --json       machine-readable report on stdout (same exit codes)',
    '  --root <dir> check another checkout of this project (default: the script\'s parent directory)',
    '  --quiet      print the one-line verdict only',
    '  --verbose    print every claim and every reference the run resolved',
    '  --self-test  run the synthetic fixtures and exit 0 only if every one behaves as declared',
    '',
    'exit codes: 0 clean, 1 findings, 2 usage error',
  ].join('\n');
}

function main(argv) {
  const flags = { check: false, json: false, quiet: false, verbose: false, selfTest: false, debug: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--self-test') flags.selfTest = true;
    else if (arg === '--debug') flags.debug = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) return { code: 2, text: usage('--root needs a directory') };
      flags.root = resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') return { code: 0, text: usage('') };
    else return { code: 2, text: usage(`unknown argument: ${arg}`) };
  }

  try {
    if (flags.selfTest) {
      const result = selfTest({ quiet: flags.json || flags.debug });
      if (flags.json) return { code: result.ok ? 0 : 1, text: JSON.stringify({ tool: TOOL, selfTest: { ok: result.ok, problems: result.problems, findings: result.report.summary } }, null, 2) };
      if (flags.debug) return { code: result.ok ? 0 : 1, text: `${result.lines.join('\n')}\n\nfixture tree:\n${result.fixtureTree.join('\n')}\n\nfixture report:\n${JSON.stringify({ findings: result.report.findings, info: result.report.info, history: result.report.history, checks: result.report.checks }, null, 1)}` };
      return { code: result.ok ? 0 : 1, text: result.lines.join('\n') };
    }
    if (!existsSync(join(flags.root, 'packages'))) return { code: 2, text: usage(`--root ${flags.root} has no packages/ directory`) };
    const report = run({ repoRoot: flags.root });
    if (flags.json) return { code: report.exitCode, text: JSON.stringify(report, null, 2) };
    if (flags.quiet) {
      const { summary } = report;
      return { code: report.exitCode, text: `${TOOL}: ${summary.findings === 0 ? 'PASS' : `FAIL (${summary.findings})`} — ${summary.documents} docs, ${summary.references} refs, ${summary.claims} claims` };
    }
    return { code: report.exitCode, text: formatReport(report, { verbose: flags.verbose }) };
  } catch (error) {
    return { code: 2, text: `${TOOL}: ${error.message}` };
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;
if (invoked) {
  const { code, text } = main(process.argv.slice(2));
  if (code === 1) console.error(text);
  else if (code === 2) console.error(text);
  else console.log(text);
  process.exit(code);
}
