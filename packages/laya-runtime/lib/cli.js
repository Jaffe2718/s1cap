/**
 * CLI: search the system for a Python environment that can run the Laya backend.
 *
 *   node --experimental-strip-types packages/laya-runtime/src/cli.ts \
 *     [--conda-env <name>] [--conda-path <conda>] [--python <interpreter>] [--json]
 *
 * The same discovery is used by the DSH plugin (`/s1 laya discover`) and by any
 * future settings panel, so all three surfaces report identical results.
 */
import { defaultLayaConfig } from './types.js';
                                             
import { discoverLayaPython, installHint } from './discovery.js';
import { createNodeDiscoveryDeps } from './node-deps.js';

export function parseArgs(argv          )                                     {
  const cfg = defaultLayaConfig();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--conda-env' && next) {
      cfg.condaEnv = next;
      i += 1;
    } else if (arg === '--conda-path' && next) {
      cfg.condaPath = next;
      i += 1;
    } else if (arg === '--python' && next) {
      cfg.pythonPath = next;
      i += 1;
    }
  }
  return { cfg, json };
}

async function main(argv          )                  {
  const { cfg, json } = parseArgs(argv);
  const report = await discoverLayaPython(cfg, createNodeDiscoveryDeps());

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.withLaya.length > 0 ? 0 : 1;
  }

  console.log('S1CAP Laya runtime - Python environment discovery');
  console.log('');
  for (const probe of report.candidates) {
    const mark = probe.laya ? '*' : ' ';
    if (probe.ok) {
      console.log(`${mark} ${probe.path}`);
      console.log(`    python ${probe.version ?? '?'}   laya=${probe.laya ? 'yes' : 'no'} torch=${probe.torch ? 'yes' : 'no'} serve=${probe.serve ? 'yes' : 'no'}`);
    } else {
      console.log(`${mark} ${probe.path}`);
      console.log(`    unusable: ${probe.error ?? 'probe failed'}`);
    }
  }
  console.log('');
  if (report.chosen) {
    console.log(`chosen: ${report.chosen.path}`);
    if (!report.chosen.laya) console.log(`install: ${installHint(report.chosen.path)}`);
    else if (!report.chosen.serve) console.log(`hint: the serving extra is missing - ${installHint(report.chosen.path)}`);
  } else {
    console.log('no usable interpreter found - pass --python <path> or --conda-env <name>');
  }
  return report.withLaya.length > 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
