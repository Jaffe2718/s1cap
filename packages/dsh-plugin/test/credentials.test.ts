/**
 * Credential intake: the entry-point probing has to be honest about what it does and does not know.
 *
 * These tests pin three properties: a working entry point is found and reported, a missing/odd service never
 * throws (a plugin must not break a session over an optional secret), and the report never carries the key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TUNING_REF, parseTuning, parseTuningArgs, readCredential } from '../src/credentials.ts';
import { defaultPolicy } from '@s1cap/core';
import { S1_PROVIDERS } from '@s1cap/s1-client';

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
test('the scoring window floor is 4, and it is dropped rather than clamped below it', () => {
  // The floor moved 64 -> 4 on 2026-10-05 with the default (1024 -> 16). What did **not** move is the rule that a
  // value outside the bounds is dropped so the policy default stands: clamping would run a window the researcher
  // never chose, and the panel and `/s1-tune` share this parser so the two cannot drift (docs/FORMULAS.md, the
  // 2026-10-05 correction's "The bounds, and why they moved with the values").
  assert.deepEqual(parseTuning('3 0.7 512'), { depth: 3, relevanceThreshold: 0.7, window: 512 });
  assert.deepEqual(parseTuning('3 0.7 16'), { depth: 3, relevanceThreshold: 0.7, window: 16 });
  assert.deepEqual(parseTuning('3 0.7 4'), { depth: 3, relevanceThreshold: 0.7, window: 4 }, 'the floor is inclusive');
  assert.deepEqual(parseTuning('3 0.7 3'), { depth: 3, relevanceThreshold: 0.7 }, 'below the floor: dropped');
  assert.deepEqual(parseTuning('3 0.7 -1'), { depth: 3, relevanceThreshold: 0.7 });
  assert.deepEqual(parseTuningArgs('3 0.7 512'), { depth: 3, relevanceThreshold: 0.7, window: 512 });
  assert.deepEqual(parseTuningArgs('w=4'), { window: 4 });
  assert.deepEqual(parseTuningArgs('w=3'), {}, 'below the floor: dropped');
});

test('the depth ceiling is 16, and a value above it is dropped rather than clamped', () => {
  // The ceiling moved 6 -> 16 on 2026-10-05, with the default (2 -> 16). It is *new* on this surface: the panel
  // accepted any integer > 0 until then, so a stored file could carry a depth the core validator refuses
  // (`packages/core/src/config.ts`, `NUMBER_RULES`) - two surfaces disagreeing about the same knob.
  assert.deepEqual(parseTuning('16 0.55'), { depth: 16, relevanceThreshold: 0.55 }, 'the ceiling is inclusive');
  assert.deepEqual(parseTuning('17 0.55'), { relevanceThreshold: 0.55 }, 'above the ceiling: dropped');
  assert.deepEqual(parseTuning('8 0.55'), { depth: 8, relevanceThreshold: 0.55 });
  assert.deepEqual(parseTuningArgs('d=16'), { depth: 16 });
  assert.deepEqual(parseTuningArgs('depth=17'), {}, 'above the ceiling: dropped');
  assert.deepEqual(parseTuningArgs('d=0'), {}, 'and the floor is still 1');
});

test('the panel admits exactly the recall values the core policy carries', () => {
  // The point of this case: the bounds are written twice - once in `packages/core/src/config.ts` and once in
  // `packages/dsh-plugin/src/credentials.ts`, because this parser deliberately reads no build artifact (see the note
  // on the question slot). A copy that drifts is a value one surface accepts and the other refuses, so the two
  // defaults are read from the policy itself rather than written down again here.
  const policy = defaultPolicy().recall;
  assert.equal(policy.window, 16, 'recall.window default');
  assert.equal(policy.depth, 16, 'recall.depth default');
  assert.equal(policy.threshold, 0.55, 'recall.threshold is not part of this change');
  assert.deepEqual(parseTuningArgs(`w=${policy.window}`), { window: policy.window }, 'the default round-trips');
  assert.deepEqual(parseTuningArgs(`d=${policy.depth}`), { depth: policy.depth }, 'and so does the depth');
});

test('the panel can set the bounded anchor wait, and an out-of-range value is dropped', () => {
  // The requirement is that this value be settable from the settings panel, so the keyed form is the one that
  // matters: `wait=` has no positional slot, because the first four tokens are the `d r w q` order that older writes
  // and the credential string use, and a fifth would put a duration where the question's position is read from.
  assert.deepEqual(parseTuningArgs('wait=3000'), { anchorWaitMs: 3000 });
  assert.deepEqual(parseTuningArgs('anchorWaitMs=3000'), { anchorWaitMs: 3000 });
  assert.deepEqual(parseTuningArgs('wait=0'), { anchorWaitMs: 0 }, '0 is a real value: it disables the wait');
  assert.deepEqual(parseTuningArgs('wait=60000'), { anchorWaitMs: 60000 }, 'the top of the bound is accepted');
  assert.deepEqual(parseTuningArgs('d=3 wait=3000'), { depth: 3, anchorWaitMs: 3000 });

  // Dropped, never clamped: a value the researcher never chose must not decide whether a step waits.
  assert.deepEqual(parseTuningArgs('wait=99999'), {}, 'above the bound: dropped');
  assert.deepEqual(parseTuningArgs('wait=60001'), {}, 'and the bound is inclusive at 60000, not 60001');
  assert.deepEqual(parseTuningArgs('wait=-1'), {}, 'a negative wait is not a wait');
  assert.deepEqual(parseTuningArgs('wait=1.5'), {}, 'it is an integer number of milliseconds');
  assert.deepEqual(parseTuningArgs('wait=soon'), {}, 'and not a word');
  // `Number('')` is 0, which is legal here, so an empty value has to be rejected before the coercion - otherwise
  // `wait=` would silently disable the wait it was written to set.
  assert.deepEqual(parseTuningArgs('wait='), {}, 'an empty value is not 0');
  assert.deepEqual(parseTuningArgs('d=3 wait='), { depth: 3 });
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

test('the panel can switch the System-1 backend, and an unknown provider is dropped', () => {
  // The radio writes this token. It changes *which* backend answers, never how many: the host already refuses a
  // session that names two (`singleBackendIssues`), so there is one value here and not two switches.
  assert.deepEqual(parseTuningArgs('provider=jev'), { provider: 'jev' });
  assert.deepEqual(parseTuningArgs('provider=laya-serve'), { provider: 'laya-serve' });
  assert.deepEqual(parseTuningArgs('provider=laya'), { provider: 'laya-serve' }, 'the short spelling of the local one');
  assert.deepEqual(parseTuningArgs('provider=LAYA-SERVE'), { provider: 'laya-serve' }, 'a name is not case-sensitive');
  assert.deepEqual(parseTuningArgs('provider="laya-serve"'), { provider: 'laya-serve' }, 'and the quoted form survives');
  assert.deepEqual(parseTuningArgs('provider=none'), { provider: 'none' }, 'switching System-1 off is a name the policy allows');
  assert.deepEqual(parseTuningArgs('d=3 provider=laya r=0.4'), {
    depth: 3,
    provider: 'laya-serve',
    relevanceThreshold: 0.4,
  }, 'and the knobs around it are unaffected');

  // Dropped, never clamped to the nearest known backend: which model answers is the one value an ablation must
  // never have chosen for it, so a typo leaves the running backend alone.
  assert.deepEqual(parseTuningArgs('provider=openai'), {});
  assert.deepEqual(parseTuningArgs('provider='), {});
  assert.deepEqual(parseTuningArgs('provider=j'), {}, 'a prefix is not a name');
  assert.deepEqual(parseTuningArgs('d=3 provider=gpt-4'), { depth: 3 });
  assert.deepEqual(parseTuningArgs('provider=layax'), {});

  // The accepted set is the policy's own list, not a second copy kept here: a provider added to S1_PROVIDERS is
  // settable from the command line the same day. "laya" is the one alias, and it resolves to the canonical name
  // before the membership test rather than widening the set.
  for (const provider of S1_PROVIDERS) {
    assert.deepEqual(parseTuningArgs('provider=' + provider), { provider }, `${provider} is a provider the policy allows`);
  }
  assert.ok(S1_PROVIDERS.includes('jev') && S1_PROVIDERS.includes('laya-serve'));
});