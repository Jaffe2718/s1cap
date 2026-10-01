#!/usr/bin/env node
/**
 * S1CAP system check — assertions over the evidence a real run produced.
 *
 * Why this exists, and why it is a script rather than a habit:
 *
 * Everything the package tests cover runs inside one process with hand-fed payloads. That is the right level for
 * "is this function correct", and it is the wrong level for "is the system correct", because the failures this
 * project keeps hitting are not in the functions. They are in the seams: a control-plane record that reached the
 * session file, S1CAP-authored text that reached the model's prompt, an injected block that came back through the
 * log and became a segment, a cell preset the runtime never actually started from, a selector whose output was
 * discarded before delivery saw it. Each of those was found by reading logs by hand, late, and each would have
 * been caught by one assertion over the same log.
 *
 * So the check reads what a run leaves behind — the two streams and the instance log — and asserts the
 * invariants that must hold in any run, whatever the cell. It does not start or stop anything: the conversation
 * is driven however the operator likes, and the evidence is judged afterwards. That keeps the check runnable on
 * a run that already happened, which is when it is most useful.
 *
 * Usage:
 *   node scripts/system-check.mjs --base-url http://127.0.0.1:19487 [--token T]
 *                                 [--log <instance.log>] [--data <dir>] [--cell C2] [--expect-s1 N]
 *                                 [--allow-fallback]
 *
 * Defaults: --data ~/.dsh/.s1cap, --base-url none (then the log is used). Exit code 1 if any invariant fails.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

const LOG = arg('log', join(process.env.TEMP ?? '.', 'dsh-web.log'));
const DATA = arg('data', join(homedir(), '.dsh', '.s1cap'));
const EXPECT_CELL = arg('cell', '');
const EXPECT_S1 = arg('expect-s1', '');
const BASE_URL = arg('base-url', '');
const TOKEN = arg('token', '');
const ALLOW_FALLBACK = has('allow-fallback');
/** The plugin's own route: the panel reads it, and so does this check. */
const STATUS_ROUTE = '/s1cap-7340';

/** Conversation kinds the adapter may produce. Anything else in the session file is a leak. */
const CONVERSATION_KINDS = new Set(['user', 'assistant', 'trace', 'toolCall', 'toolResult', 'systemPinned']);
/** Control-plane event types that must never appear in the session stream. */
const CONTROL_TYPES = new Set(['llm_call', 's1_call', 'tool_call', 'assembly', 'plan_gate', 'context_delivery']);

function readJsonl(path) {
  if (!existsSync(path)) return { lines: [], missing: true };
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        return { __unparsed: l.slice(0, 120), __error: String(err) };
      }
    });
  return { lines, missing: false };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

// ------------------------------------------------------------------ load

const session = readJsonl(join(DATA, 'session.jsonl'));
const control = readJsonl(join(DATA, 'control.jsonl'));
const logText = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';

/**
 * The live status, from the plugin's own route.
 *
 * The first version of this check read it from the instance log, and the first run of it proved that wrong: a
 * complete session — 33 conversation lines, 16 control records — and **zero** `[s1cap]` lines in the log, because
 * this plugin's logger does not reach that file at all. Reading a channel that does not exist is how a check ends
 * up asserting on nothing, so the route is the channel: it is already registered for the panel, and it answers
 * with the same counters `/s1` prints.
 */
async function fetchStatus() {
  if (BASE_URL === '') return null;
  const url = `${BASE_URL.replace(/\/$/, '')}${STATUS_ROUTE}${TOKEN === '' ? '' : `?token=${encodeURIComponent(TOKEN)}`}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`system-check: ${STATUS_ROUTE} answered ${res.status} — the instance may have moved, or want auth.`);
      return null;
    }
    const body = await res.json();
    return body?.status ?? null;
  } catch (err) {
    console.error(`system-check: ${url} unreachable (${String(err)})`);
    return null;
  }
}

const status = await fetchStatus();

if (session.missing || control.missing) {
  console.error(`system-check: no evidence in ${DATA} (session ${session.missing ? 'missing' : 'ok'}, control ${control.missing ? 'missing' : 'ok'})`);
  console.error('system-check: run a conversation first, against a cleared data directory.');
  process.exit(2);
}
if (status === null) {
  // Note the apostrophe: an unescaped one inside a single-quoted string closes it early, and the resulting
  // SyntaxError names neither the quote nor the line that follows the real mistake.
  const hint =
    BASE_URL === '' ? ` — pass --base-url http://127.0.0.1:<port> (and --token) to read the ${STATUS_ROUTE} route` : '';
  console.error(`system-check: no live status${hint}.`);
  process.exit(2);
}

// ------------------------------------------------- 1. provenance of the two streams

const leaked = session.lines.filter((l) => CONTROL_TYPES.has(l.type));
const oddKinds = [...new Set(session.lines.map((l) => l.kind).filter((k) => !CONVERSATION_KINDS.has(k)))];
check(
  'I1 provenance: no control-plane record in the session stream',
  leaked.length === 0 && oddKinds.length === 0,
  `${session.lines.length} session lines, ${leaked.length} control-typed, kinds outside the adapter's vocabulary: ${
    oddKinds.length === 0 ? 'none' : oddKinds.join(', ')
  }`,
);

// ------------------------------------- 2. nothing S1CAP authored reached the model

const injected = session.lines.filter((l) => typeof l.id === 'string' && l.id.startsWith('s1cap-'));
const BAD_HEADER = /^(?!## earlier (user|assistant|trace|toolCall|toolResult) turn, quoted verbatim · \S+$).+$/;
const offenders = [];
for (const msg of injected) {
  const text = String(msg.text ?? '');
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (line.startsWith('## ')) {
      if (BAD_HEADER.test(line)) offenders.push(`${msg.id}: header ${JSON.stringify(line.slice(0, 80))}`);
      continue;
    }
    // A body line: fine. Anything that is a heading of any other kind is S1CAP prose about the context.
    if (line.startsWith('#')) offenders.push(`${msg.id}: authored heading ${JSON.stringify(line.slice(0, 80))}`);
  }
}
check(
  'I2 no S1CAP-authored text in the model-visible block',
  offenders.length === 0,
  `${injected.length} delivered blocks, every line either a verbatim-provenance header or quoted text; ${
    offenders.length
  } offenders${offenders.length > 0 ? ` — ${offenders.slice(0, 3).join('; ')}` : ''}`,
);

// ------------------------------------------- 3. the ingestion gate actually held

const selfDropped = status?.observation?.upkeepSelfDropped ?? null;
check(
  'I3 ingestion gate: delivered blocks are in the log but not in the graph',
  selfDropped !== null && selfDropped === injected.length,
  `log holds ${injected.length} s1cap- messages; upkeep dropped ${String(selfDropped)} at ingestion${
    selfDropped === null ? ' (no counter in the status — an older build?)' : selfDropped === injected.length ? ' (equal)' : ' (MISMATCH)'
  }`,
);

// ------------------------------ 4. the run under test is the run whose evidence we read

const reported = status?.streams?.sessionLines ?? null;
const controlReported = status?.streams?.controlRecords ?? null;
check(
  'I4 evidence belongs to this run',
  reported === session.lines.length && controlReported === control.lines.length,
  `the plugin reported ${String(reported)} session and ${String(controlReported)} control records; files hold ${
    session.lines.length
  } and ${control.lines.length}. A mismatch means evidence from an earlier run is still in the directory.`,
);

// ---------------------------------------- 5. System-1 spend is in the control plane only

const s1Calls = control.lines.filter((l) => l.type === 's1_call');
const s1InSession = session.lines.filter((l) => l.type === 's1_call').length;
const expectedS1 = EXPECT_S1 === '' ? null : Number(EXPECT_S1);
check(
  'I5 System-1 spend recorded in the control plane, never in the session',
  s1Calls.length > 0 && s1InSession === 0 && (expectedS1 === null || expectedS1 === s1Calls.length),
  `${s1Calls.length} s1_call records (${s1Calls.map((c) => c.kind).join(',') || 'none'}${
    expectedS1 === null ? '' : `; expected ${expectedS1}`
  }), ${s1InSession} in the session`,
);

// ---------------------------------------------- 6. the runtime started from the cell

const cell = status?.cell ?? '(none)';
const cellOk = EXPECT_CELL === '' || cell === EXPECT_CELL;
// The route reports these flat, which is the shape the panel reads them in.
const knobs = [
  ['tas', status?.tas],
  ['tier1', status?.tier1],
  ['planGate', status?.planGate],
  ['xFirst', status?.xFirst],
  ['deliver', status?.deliver],
].filter(([, v]) => v !== undefined);
check(
  'I6 cell authority: the preset the profile names is the policy that ran',
  cellOk && knobs.length >= 3,
  `cell ${cell}${EXPECT_CELL === '' ? '' : ` (expected ${EXPECT_CELL})`}, knobs: ${knobs
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')}`,
);

// -------------------------------- 7. the System-1 selection was not thrown away before delivery

const assemblies = control.lines.filter((l) => l.type === 'assembly');
const fellBack = assemblies.filter((a) => a.fallback === 'recency-window');
const empty = assemblies.filter((a) => a.fallback === 'recency-window' && (a.selected ?? 0) === 0);
check(
  'I7 a selection reached delivery, and each fallback is accounted for',
  ALLOW_FALLBACK || fellBack.length === 0 || empty.length === fellBack.length,
  `${assemblies.length} assemblies, ${fellBack.length} fell back to the recency window${
    ALLOW_FALLBACK ? ' (allowed by flag)' : ''
  } of which ${empty.length} had nothing selected; selected: ${assemblies.map((a) => a.selected).join(',')}`,
);

// ------------------------------------------------------ 8. the harness still worked

const assistantLines = session.lines.filter((l) => l.kind === 'assistant' || l.kind === 'trace').length;
const toolLines = session.lines.filter((l) => l.kind === 'toolCall' || l.kind === 'toolResult').length;
const s1capErrors = (logText.match(/\[s1cap\][^\n]*\b(error|failed|EPERM|ECONNREFUSED)\b/gi) ?? []).length;
check(
  'I8 the harness kept working',
  assistantLines > 0 && s1capErrors === 0,
  `${assistantLines} assistant messages, ${toolLines} tool lines, ${s1capErrors} s1cap error lines in ${LOG}`,
);

// ------------------------------------------------------------------ report

const width = Math.max(...results.map((r) => r.name.length));
let failed = 0;
console.log(`S1CAP system check — ${DATA}\n`);
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\n${results.length - failed}/${results.length} invariants hold${
    status?.s1?.provider ? ` · backend ${status.s1.provider} (${status.s1.mode})` : ''
  }${expectedS1 === null ? '' : ` · expected ${expectedS1} s1 calls`}`,
);
process.exit(failed === 0 ? 0 : 1);
