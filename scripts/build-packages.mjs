#!/usr/bin/env node
/**
 * Build the workspace packages to plain JavaScript under `lib/`.
 *
 * Why this exists: DSH installs a bundle into the profile's `node_modules`, and Node refuses to
 * strip TypeScript types for files under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — a `.ts` entry point therefore cannot be loaded
 * from a profile. The ecosystem convention is a compiled entry (`main: lib/index.js`), and because
 * every source file here uses erasable syntax only, Node's own stripper is enough: no compiler
 * dependency, no bundler.
 *
 * `lib/` is generated but committed, so a profile install works without running this script.
 * Run it after touching `src/`:  node scripts/build-packages.mjs [@s1cap/core ...]
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(root, 'packages');
const only = process.argv.slice(2);

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

/** Relative imports must keep resolving after the .ts -> .js rename. */
function rewriteSpecifiers(code) {
  return code
    .replace(/(\bfrom\s+['"])(\.[^'"]+?)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])(\.[^'"]+?)\.ts(['"]\s*\))/g, '$1$2.js$3');
}

const report = [];
for (const name of readdirSync(packagesDir)) {
  const pkgDir = join(packagesDir, name);
  if (!statSync(pkgDir).isDirectory()) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (only.length > 0 && !only.includes(pkg.name)) continue;
  const srcDir = join(pkgDir, 'src');
  try {
    statSync(srcDir);
  } catch {
    continue;
  }

  const outDir = join(pkgDir, 'lib');
  rmSync(outDir, { recursive: true, force: true });
  let files = 0;
  for (const file of walk(srcDir)) {
    const target = join(outDir, relative(srcDir, file).replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    const code = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
    writeFileSync(target, rewriteSpecifiers(code), 'utf8');
    files += 1;
  }
  report.push(`${pkg.name}: ${files} file(s) -> lib/`);
}

if (report.length === 0) {
  console.error('build-packages: nothing matched');
  process.exit(1);
}
console.log(report.join('\n'));
