/**
 * Point at the exact byte where a JSONL line stops being valid.
 *
 * Written because "the line will not parse" is not a diagnosis: three different defects produce it — an unescaped
 * quote in the text, a raw control character, a torn write — and each needs a different fix. Guessing from the
 * first parse error is how the wrong one gets patched.
 *
 *   node scripts/find-bad-jsonl-line.mjs <file.jsonl> [maxContext]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node scripts/find-bad-jsonl-line.mjs <file.jsonl>');
  process.exit(2);
}
const context = Number(process.argv[3] ?? 90);

const text = readFileSync(file, 'utf8');
const lines = text.split('\n');
let bad = 0;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (line === '') continue;
  try {
    JSON.parse(line);
    continue;
  } catch (err) {
    bad += 1;
    // Node reports the position; older/other engines put it in the message, so both are read.
    const message = err instanceof Error ? err.message : String(err);
    const at = /position (\d+)/.exec(message);
    const pos = at ? Number(at[1]) : 0;
    const from = Math.max(0, pos - context);
    const to = Math.min(line.length, pos + context);
    console.log(`line ${i + 1}: ${message}`);
    console.log(`  length ${line.length}, failing at ${pos}`);
    console.log(`  before: ${JSON.stringify(line.slice(from, pos))}`);
    console.log(`  at:     ${JSON.stringify(line.slice(pos, pos + 1))} (code ${line.charCodeAt(pos)})`);
    console.log(`  after:  ${JSON.stringify(line.slice(pos + 1, to))}`);
  }
}

console.log(bad === 0 ? 'every line parses' : `${bad} unparsable line(s)`);
process.exit(bad === 0 ? 0 : 1);
