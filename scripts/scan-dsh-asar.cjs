// Read-only scan of DSH's packaged sources (run through Electron-as-Node, which can read app.asar).
// Goal: find the real contract of the agent/pre-step event and what reads `.kind`.
const fs = require('fs');
const path = require('path');

const ROOT = 'D:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai';
const NEEDLES = ['agent/pre-step', 'agent/request-error'];
const hits = [];

function scanFile(p) {
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  for (const needle of NEEDLES) {
    let from = 0;
    for (let n = 0; n < 3; n += 1) {
      const i = text.indexOf(needle, from);
      if (i < 0) break;
      hits.push({ needle, file: p.replace(ROOT, ''), snippet: text.slice(Math.max(0, i - 600), i + 600) });
      from = i + needle.length;
    }
  }
}

function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name === 'tests') continue;
      walk(p, depth + 1);
    } else if (/\.(js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.min.js')) {
      scanFile(p);
    }
  }
}

walk(ROOT, 0);
console.log(`packages scanned under ${ROOT}`);
console.log(`total hits: ${hits.length}`);
for (const h of hits.slice(0, 4)) {
  console.log(`\n##### ${h.needle} in ${h.file} #####`);
  console.log(h.snippet);
}
