import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('a fresh checkout contains every shipped runtime module and its relative imports', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
  for (const name of ['core', 'dsh-plugin', 'laya-runtime', 's1-client']) {
    const src = join(packages, name, 'src');
    const lib = join(packages, name, 'lib');
    for (const source of walk(src).filter(path => /\.(ts|js)$/.test(path) && !path.endsWith('.d.ts'))) {
      const output = join(lib, source.slice(src.length + 1).replace(/\.ts$/, '.js'));
      assert.ok(existsSync(output), `Missing shipped module: ${output}; run scripts/build-packages.mjs and commit it`);
      const code = readFileSync(output, 'utf8');
      const imports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"\r\n]+)['"]/g;
      for (const [, specifier] of code.matchAll(imports)) {
        assert.ok(existsSync(resolve(dirname(output), specifier)), `Unresolved runtime import ${specifier} in ${output}`);
      }
    }
  }
});
