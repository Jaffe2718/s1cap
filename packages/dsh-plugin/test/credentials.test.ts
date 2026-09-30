/**
 * Credential intake: the entry-point probing has to be honest about what it does and does not know.
 *
 * These tests pin three properties: a working entry point is found and reported, a missing/odd service never
 * throws (a plugin must not break a session over an optional secret), and the report never carries the key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TUNING_REF, parseTuning, parseTuningArgs, readCredential } from '../src/credentials.ts';

test('the first entry point that answers wins, and it is reported by name', async () => {
  const reports: Record<string, unknown>[] = [];
  const service = {
    resolve: () => ({ value: 'sk-live-PROBEKEY' }),
    readRecord: () => 'later',
  };
  const result = await readCredential({ ref: 's1cap/jev', service, report: (l) => reports.push(l) });

  assert.equal(result.key, 'sk-live-PROBEKEY');
  assert.equal(result.method, 'resolve');
  assert.deepEqual(result.tried, ['resolve']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.['result'], 'read');
  assert.equal(JSON.stringify(reports[0]).includes('PROBEKEY'), false, 'a report never carries the secret');
});

test('an entry point that throws is skipped, and the next one is used', async () => {
  const reports: Record<string, unknown>[] = [];
  const service = {
    resolve: () => {
      throw new Error('not my job');
    },
    readRecord: async () => 'sk-live-SECOND',
  };
  const result = await readCredential({ ref: 's1cap/jev', service, report: (l) => reports.push(l) });

  assert.equal(result.key, 'sk-live-SECOND');
  assert.equal(result.method, 'readRecord');
  assert.deepEqual(result.tried, ['resolve', 'readRecord']);
  assert.ok(reports.some((r) => r['result'] === 'entry point threw'));
  assert.equal(JSON.stringify(reports).includes('SECOND'), false);
});

test('no service, an empty answer, or a service without entry points stay silent and safe', async () => {
  const reports: Record<string, unknown>[] = [];

  const none = await readCredential({ ref: 's1cap/jev', service: undefined, report: (l) => reports.push(l) });
  assert.equal(none.key, undefined);

  const empty = await readCredential({
    ref: 's1cap/jev',
    service: { resolve: () => undefined, get: () => '' },
    report: (l) => reports.push(l),
  });
  assert.equal(empty.key, undefined);
  assert.deepEqual(empty.tried, ['resolve', 'get']);

  const barred = await readCredential({ ref: 's1cap/jev', service: { nope: 1 }, report: (l) => reports.push(l) });
  assert.equal(barred.key, undefined);
  assert.deepEqual(barred.tried, []);

  // every path reported something, and nothing was thrown
  assert.ok(reports.length >= 3);
  assert.ok(reports.some((r) => r['result'] === 'not found' && Array.isArray(r['available'])));
});
test('parseTuning accepts d>0 int and 0<=r<=1 float, and drops anything else', () => {
  assert.deepEqual(parseTuning('2 0.55'), { depth: 2, relevanceThreshold: 0.55 });
  assert.deepEqual(parseTuning('1 0'), { depth: 1, relevanceThreshold: 0 });
  assert.deepEqual(parseTuning('3 1'), { depth: 3, relevanceThreshold: 1 });
  assert.deepEqual(parseTuning('   4   0.25  '), { depth: 4, relevanceThreshold: 0.25 });

  // out-of-range fields are dropped, never clamped: the policy default must stand
  assert.deepEqual(parseTuning('0 0.5'), { relevanceThreshold: 0.5 }, 'd must be greater than 0');
  assert.deepEqual(parseTuning('-2 0.5'), { relevanceThreshold: 0.5 });
  assert.deepEqual(parseTuning('2.5 0.5'), { relevanceThreshold: 0.5 }, 'd must be an integer');
  assert.deepEqual(parseTuning('2 1.5'), { depth: 2 }, 'r must be at most 1');
  assert.deepEqual(parseTuning('2 -0.1'), { depth: 2 }, 'r must be at least 0');

  assert.deepEqual(parseTuning(undefined), {});
  assert.deepEqual(parseTuning('nonsense'), {});
  assert.deepEqual(parseTuning('2'), { depth: 2 }, 'a missing r leaves the policy default in place');
  assert.equal(TUNING_REF, 's1cap/tuning');
});
test('parseTuningArgs accepts d/r by position and by name, and drops out-of-range values', () => {
  assert.deepEqual(parseTuningArgs('3 0.7'), { depth: 3, relevanceThreshold: 0.7 });
  assert.deepEqual(parseTuningArgs('d=3 r=0.7'), { depth: 3, relevanceThreshold: 0.7 });
  assert.deepEqual(parseTuningArgs('depth=4 relevanceThreshold=1'), { depth: 4, relevanceThreshold: 1 });
  assert.deepEqual(parseTuningArgs('r=0.2'), { relevanceThreshold: 0.2 });
  assert.deepEqual(parseTuningArgs('5'), { depth: 5 });

  assert.deepEqual(parseTuningArgs('0 0.5'), { relevanceThreshold: 0.5 }, 'd must be greater than 0');
  assert.deepEqual(parseTuningArgs('2.5'), {}, 'd must be an integer');
  assert.deepEqual(parseTuningArgs('2 2'), { depth: 2 }, 'r must be at most 1');
  assert.deepEqual(parseTuningArgs(''), {});
  assert.deepEqual(parseTuningArgs(undefined), {});
});
test('the scoring window floor is 64, and it is dropped rather than clamped below it', () => {
  assert.deepEqual(parseTuning('3 0.7 512'), { depth: 3, relevanceThreshold: 0.7, window: 512 });
  assert.deepEqual(parseTuning('3 0.7 64'), { depth: 3, relevanceThreshold: 0.7, window: 64 });
  assert.deepEqual(parseTuning('3 0.7 63'), { depth: 3, relevanceThreshold: 0.7 }, 'below the floor: dropped');
  assert.deepEqual(parseTuning('3 0.7 -1'), { depth: 3, relevanceThreshold: 0.7 });
  assert.deepEqual(parseTuningArgs('3 0.7 512'), { depth: 3, relevanceThreshold: 0.7, window: 512 });
  assert.deepEqual(parseTuningArgs('w=64'), { window: 64 });
  assert.deepEqual(parseTuningArgs('w=63'), {}, 'below the floor: dropped');
});

test('the panel can write the Laya fields, and a mistyped one falls back instead of failing at launch', () => {
  // The reason these exist on this surface at all: the interpreter path is a *required* field, and a required field
  // with no write path is one nobody can fill — which would make every Laya run impossible rather than unusual.
  assert.deepEqual(parseTuningArgs('laya=D:/tools/laya_py/env/python.exe'), {
    layaPythonPath: 'D:/tools/laya_py/env/python.exe',
  });
  assert.deepEqual(parseTuningArgs('layaPythonPath=C:\\tools\\laya_py\\env\\python.exe'), {
    layaPythonPath: 'C:\\tools\\laya_py\\env\\python.exe',
  });
  assert.deepEqual(parseTuningArgs('py=/opt/laya/env/bin/python'), { layaPythonPath: '/opt/laya/env/bin/python' });
  assert.deepEqual(parseTuningArgs('weights=D:/hf-cache layaWeightsEnvVar=HF_HOME'), {
    layaWeightsCacheDir: 'D:/hf-cache',
    layaWeightsEnvVar: 'HF_HOME',
  });

  // Fail-safe, exactly like the knobs: an unusable value is dropped so the default stands. A path is not checked
  // for existence — the panel writes it on a machine where the venv may still be being created, and refusing it
  // would break the case the field exists for. What is rejected is what cannot be a path at all.
  assert.deepEqual(parseTuningArgs('laya=python'), {}, 'a bare token with no separator is not a path');
  assert.deepEqual(parseTuningArgs('laya='), {}, 'and neither is an empty one');
  assert.deepEqual(parseTuningArgs('layaWeightsEnvVar="not a name"'), {}, 'an env var name must be a name');
  assert.deepEqual(parseTuningArgs('layaWeightsEnvVar=2BAD'), {}, 'and cannot start with a digit');

  // The path this plugin is most likely to be pointed at on this machine, which is the one DSH ships — and it
  // contains a space. Without quoting the string is cut in three and the required field silently stays empty.
  assert.deepEqual(parseTuningArgs('laya="D:/Program Files/DeepSeek Harness/resources/python/python.exe"'), {
    layaPythonPath: 'D:/Program Files/DeepSeek Harness/resources/python/python.exe',
  });
  assert.deepEqual(parseTuningArgs('d=3 laya="D:/Program Files/x/python.exe" r=0.4'), {
    depth: 3,
    layaPythonPath: 'D:/Program Files/x/python.exe',
    relevanceThreshold: 0.4,
  }, 'and the knobs around it are unaffected');

  // The numeric knobs still behave: a path-looking value in a numeric field is dropped, not coerced to NaN.
  assert.deepEqual(parseTuningArgs('d=3 laya=D:/x/python.exe'), { depth: 3, layaPythonPath: 'D:/x/python.exe' });
});