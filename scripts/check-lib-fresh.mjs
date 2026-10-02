/**
 * lib/ versus src/ — the check `build-packages.mjs` cannot make for itself.
 *
 * `scripts/build-packages.mjs` erases types and writes `lib/`, and nothing verifies that what it wrote is what
 * `src/` says. That gap is recorded in `DEFECT-GATE.md` ("the previous round ran with a `lib/` older than its
 * `src/`") and is half of F14 in `s1cap-audit-lane.md`. A round links its profiles at this working tree, so a
 * stale `lib/` means the cells run code nobody can read from the sources.
 *
 * This re-derives every `lib/` file from `src/` with **the build's own transformation** - `stripTypeScriptTypes`
 * from `node:module` plus the same relative-specifier rewrite - and reports every file that differs. Reads only;
 * nothing is written. Exit code 1 when anything is stale.
 *
 * Why it exists rather than `build-packages.mjs --check`: the build cannot run at all in a session whose file
 * sandbox denies a child process write access under this repository, so the question "is `lib/` current?" has to be
 * answerable without writing anything.
 *
 * Usage: node scripts/check-lib-fresh.mjs [--quiet] [--content]
 *
 * `--content` asks the weaker question a byte comparison cannot answer for a tree whose `lib/` was written on
 * another line-ending convention: it compares the two with `\r` removed, so a report of "identical" means the
 * code matches and only the convention differs. The default is the strict comparison, because that is what
 * `build-packages.mjs` produces and what the profiles load.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(root, 'packages');
const quiet = process.argv.includes('--quiet');
const contentOnly = process.argv.includes('--content');

/** Every source file the build would compile, in the order it walks them. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(full);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/** Relative imports must keep resolving after the .ts -> .js rename. Identical to the build's own rule. */
function rewriteSpecifiers(code) {
  return code
    .replace(/(\bfrom\s+['"])(\.[^'"]+?)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])(\.[^'"]+?)\.ts(['"]\s*\))/g, '$1$2.js$3');
}

const stale = [];
const missing = [];
let same = 0;
for (const name of readdirSync(packagesDir).sort()) {
  const pkgDir = join(packagesDir, name);
  if (!statSync(pkgDir).isDirectory()) continue;
  const srcDir = join(pkgDir, 'src');
  try {
    statSync(srcDir);
  } catch {
    continue;
  }
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file).replace(/\.ts$/, '.js');
    const target = join(pkgDir, 'lib', rel);
    const source = readFileSync(file, 'utf8');
    const expected = file.endsWith('.js') ? source : rewriteSpecifiers(stripTypeScriptTypes(source, { mode: 'strip' }));
    let actual = null;
    try {
      actual = readFileSync(target, 'utf8');
    } catch {
      missing.push(`packages/${name}/lib/${rel}`);
      continue;
    }
    if (actual === expected) same += 1;
    else if (contentOnly && actual.replace(/\r/g, '') === expected.replace(/\r/g, '')) same += 1;
    else stale.push(`packages/${name}/lib/${rel}`);
  }
}

if (!quiet) {
  console.log(`lib/ is current for ${same} file(s)`);
  if (missing.length > 0) console.log(`MISSING (${missing.length}):\n  ${missing.join('\n  ')}`);
  if (stale.length > 0) console.log(`STALE (${stale.length}):\n  ${stale.join('\n  ')}`);
}
console.log(
  missing.length === 0 && stale.length === 0
    ? 'check-lib-fresh: PASS — every lib/ file is byte-identical to what src/ builds to'
    : `check-lib-fresh: FAIL — ${missing.length} missing, ${stale.length} stale; run: node scripts/build-packages.mjs`,
);
if (missing.length > 0 || stale.length > 0) process.exitCode = 1;
