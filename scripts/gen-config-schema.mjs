import { writeFileSync } from 'node:fs';
const mod = await import('file:///E:/Coding/TypeScript/system_one/s1cap/packages/dsh-plugin/lib/index.js');
const resolved = mod.resolvePluginConfig({ enabled: true });
const cfg = resolved.config ?? resolved;
const VOLATILE = new Set(['recall.depth', 'recall.threshold', 'recall.window']);
const list = [];
const walk = (value, prefix, depth) => {
  for (const [k, v] of Object.entries(value)) {
    const path = prefix === '' ? k : prefix + '.' + k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && depth < 3) { walk(v, path, depth + 1); continue; }
    list.push([path, Array.isArray(v) ? 'array' : typeof v]);
  }
};
walk(cfg, '', 0);
// keys the test profile patch adds that the defaults do not carry, plus env-style records
const extra = [['laya.condaEnv', 'string'], ['laya.condaPath', 'string'], ['laya.env', 'record']];
for (const [p, t] of extra) if (!list.some(([q]) => q === p)) list.push([p, t]);

const leaf = (path, type) => {
  const name = path.split('.').pop();
  const vol = VOLATILE.has(path) ? '.volatile()' : '';
  if (type === 'number') return 'z.number()' + vol;
  if (type === 'boolean') return 'z.boolean()' + vol;
  if (type === 'record') return 'z.dict(z.string())' + vol;
  return 'z.string()' + vol;
};
const tree = {};
for (const [path, type] of list) {
  const parts = path.split('.');
  let node = tree;
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {});
  node[parts[parts.length - 1]] = leaf(path, type);
}
const render = (node, indent) => {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  return (
    '{\n' +
    Object.entries(node)
      .map(([k, v]) => inner + k + ': ' + (typeof v === 'string' ? v : render(v, indent + 2)) + ',')
      .join('\n') +
    '\n' + pad + '}'
  );
};
const source = `/**
 * The plugin's exported configuration schema - generated from the real resolved shape, not hand-written.
 *
 * Why it exists: the settings namespace a panel can write into is the one the exported \`Config\` declares. Without
 * this export the loader has no namespace to validate against, so \`settings/mutate\` answers \`settings/rejected\`
 * with the namespace name and there is nothing for a Save button to write into (docs/STATUS-ARCHIVE.md rounds 32-40).
 *
 * Coverage is the union of the dumped defaults and the keys the test profile patch sets (laya.condaEnv,
 * laya.condaPath, laya.env). An omitted field makes the loader reject the profile's configuration and the plugin then
 * fails to activate, so this file is regenerated rather than edited: \`node scripts/gen-config-schema.mjs\`.
 *
 * Leaf types are deliberately permissive (plain string/number rather than enums): the fail-safe validation in
 * packages/core/src/config.ts already reports values it does not accept and keeps the default, so a stricter schema
 * here would only add a second, blunter place for a profile to be rejected.
 *
 * ${String(list.length)} leaf fields.
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object(${render(tree, 0)});
`;
writeFileSync('E:/Coding/TypeScript/system_one/s1cap/packages/dsh-plugin/src/config-schema.ts', source, 'utf8');
console.log('generated fields: ' + String(list.length));
console.log('volatile: ' + list.filter(([p]) => VOLATILE.has(p)).map(([p]) => p).join(', '));