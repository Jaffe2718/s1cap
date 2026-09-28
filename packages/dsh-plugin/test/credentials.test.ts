/**
 * Credential intake: the entry-point probing has to be honest about what it does and does not know.
 *
 * These tests pin three properties: a working entry point is found and reported, a missing/odd service never
 * throws (a plugin must not break a session over an optional secret), and the report never carries the key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readCredential } from '../src/credentials.ts';

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
