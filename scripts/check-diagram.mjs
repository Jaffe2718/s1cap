#!/usr/bin/env node
/**
 * Guard for the hand-authored route diagram (docs/figures/s1cap-technical-route.html).
 *
 * The diagram is drawn by hand, so nothing stops a node from drifting out of its lane band.
 * This script parses the SVG and asserts:
 *   1. every node box lies fully inside the lane band that contains its vertical centre;
 *   2. every node box lies inside the lane band's horizontal extent;
 *   3. no two node boxes overlap.
 *
 * Usage: node scripts/check-diagram.mjs   (exit 0 = OK, exit 1 = violations)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(root, 'docs', 'figures', 's1cap-technical-route.html');
const svg = readFileSync(file, 'utf8');
const rel = relative(root, file).replace(/\\/g, '/');

const LANE_RE =
  /<rect class="lane"[^>]*x="(?<x>[\d.]+)"\s+y="(?<y>[\d.]+)"\s+width="(?<w>[\d.]+)"\s+height="(?<h>[\d.]+)"/g;
const NODE_RE =
  /<g class="node (?<kind>[a-z0-9]+)">\s*<rect x="(?<x>[\d.]+)" y="(?<y>[\d.]+)" width="(?<w>[\d.]+)" height="(?<h>[\d.]+)"[^>]*\/>[\s\S]*?<text[^>]*>(?<label>[^<]+)<\/text>/g;

const toBox = (g) => ({
  label: g.label,
  kind: g.kind,
  x: Number(g.x),
  y: Number(g.y),
  w: Number(g.w),
  h: Number(g.h),
  right: Number(g.x) + Number(g.w),
  bottom: Number(g.y) + Number(g.h),
});

const lanes = [...svg.matchAll(LANE_RE)].map((m, i) => {
  const box = toBox({ ...m.groups, label: `lane ${i + 1}`, kind: 'lane' });
  const after = svg.slice(m.index + m[0].length, m.index + m[0].length + 300);
  const label = (after.match(/<text[^>]*>([^<]+)<\/text>/) || [, box.label])[1].trim();
  return { ...box, label };
});
const nodes = [...svg.matchAll(NODE_RE)].map((m) => toBox(m.groups));

const problems = [];
if (lanes.length === 0) problems.push('no lane bands found — did the lane markup change?');
if (nodes.length === 0) problems.push('no node groups found — did the node markup change?');

for (const node of nodes) {
  const centre = node.y + node.h / 2;
  const lane = lanes.find((l) => centre >= l.y && centre <= l.bottom);
  if (!lane) {
    problems.push(`"${node.label}" is not inside any lane band (centre y=${centre})`);
    continue;
  }
  if (node.y < lane.y || node.bottom > lane.bottom) {
    problems.push(
      `"${node.label}" leaves lane "${lane.label}": node ${node.y}..${node.bottom} vs lane ${lane.y}..${lane.bottom}`,
    );
  }
  if (node.x < lane.x || node.right > lane.right) {
    problems.push(
      `"${node.label}" leaves lane "${lane.label}" horizontally: node ${node.x}..${node.right} vs lane ${lane.x}..${lane.right}`,
    );
  }
}

for (let i = 0; i < nodes.length; i += 1) {
  for (let j = i + 1; j < nodes.length; j += 1) {
    const a = nodes[i];
    const b = nodes[j];
    const overlapX = a.x < b.right && b.x < a.right;
    const overlapY = a.y < b.bottom && b.y < a.bottom;
    if (overlapX && overlapY) problems.push(`"${a.label}" overlaps "${b.label}"`);
  }
}

// The committed SVGs are generated from the HTML above; a stale pair would silently lie in the README.
const sourceHash = createHash('sha256').update(svg).digest('hex').slice(0, 16);
for (const name of ['s1cap-technical-route.light.svg', 's1cap-technical-route.dark.svg']) {
  let text = '';
  try {
    text = readFileSync(join(root, 'docs', 'figures', name), 'utf8');
  } catch {
    problems.push(`${name} is missing - run: node scripts/build-route-svg.mjs`);
    continue;
  }
  const stamp = text.match(/source sha256:([0-9a-f]{16})/);
  if (!stamp) problems.push(`${name} carries no generator banner`);
  else if (stamp[1] !== sourceHash) {
    problems.push(`${name} was generated from a different revision of ${rel} - run: node scripts/build-route-svg.mjs`);
  }
}
if (problems.length > 0) {
  console.error(`route diagram check FAILED (${rel})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `route diagram OK (${rel}): ${nodes.length} nodes inside ${lanes.length} lanes, no overlaps`,
);
