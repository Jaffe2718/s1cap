#!/usr/bin/env node
/**
 * Replay a tape through the pipeline and print a digest.
 *
 *   node scripts/replay-tape.mjs <tape.jsonl> [--cell C4] [--dump]
 *
 * A tape is written by the plugin in `observation: tape` mode (one line per LLM call). Replaying the same
 * tape twice must give the same digest; `--dump` prints the records so a difference can be located.
 */
import { readFileSync } from 'node:fs';
import { cellPolicy, digestRecords, parseTape, replayTape } from '../packages/core/lib/index.js';

const [file, ...rest] = process.argv.slice(2);
if (file === undefined) {
  console.error('usage: node scripts/replay-tape.mjs <tape.jsonl> [--cell C4] [--dump]');
  process.exit(2);
}
const cellIndex = rest.indexOf('--cell');
const cell = (cellIndex >= 0 ? rest[cellIndex + 1] : 'C4') ?? 'C4';
const policy = cellPolicy(cell);
const tape = parseTape(readFileSync(file, 'utf8'));
const options = {
  policy,
  now: 1_790_000_000_000,
  contextWindow: 128_000,
  reserveOutputTokens: 8_000,
  fixedOverheadTokens: 1_200,
  lambdaMs: 36 * 60 * 60 * 1000,
};

const first = replayTape(tape, options);
const second = replayTape(tape, options);
console.log(`tape: ${file} (${tape.steps.length} steps, session ${tape.sessionId})`);
console.log(`cell: ${cell}   digest: ${first.digest}   replay-identical: ${first.digest === second.digest}`);
for (const [index, record] of first.records.entries()) {
  const blocks = Object.entries(record.blocks).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(
    `  step ${index + 1}: candidates=${record.candidates} selected=${record.selected} ` +
      `budget=${record.budgetUsed}/${record.budgetTotal} ${blocks}${record.fallback ? ` fallback=${record.fallback}` : ''}`,
  );
}
if (rest.includes('--dump')) console.log(JSON.stringify(first.records, null, 2));
if (first.digest !== second.digest) {
  console.error('REPLAY MISMATCH: the pipeline is not deterministic for this tape');
  process.exit(1);
}