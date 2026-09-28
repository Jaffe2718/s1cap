import test from 'node:test';
import assert from 'node:assert/strict';

import {
  S1Client,
  S1HttpError,
  S1TimeoutError,
  choice,
  normalize,
  noul,
  score,
  s1CostUsd,
} from '../src/index.ts';

interface Captured {
  url: string;
  body: unknown;
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  captured?: Captured[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reqInit = init ?? {};
    if (captured) {
      captured.push({
        url,
        body: typeof reqInit.body === 'string' ? JSON.parse(reqInit.body) : undefined,
      });
    }
    return handler(url, reqInit);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('decide: parses the /v1/systemone envelope and reports usage', async () => {
  const captured: Captured[] = [];
  const client = new S1Client({
    baseUrl: 'https://api.typesafe.ai/',
    apiKey: 'test-key',
    model: 'jev-latest',
    fetchImpl: mockFetch(
      () =>
        jsonResponse({
          model: 'jev-1.13.0',
          answers: {
            rel_1: { type: 'noul', noul: 0.91 },
            plan: { type: 'choice', choice: 'patch', probabilities: { patch: 0.5, revert: 0.5 }, confidence: 0.77 },
            urgency: { type: 'score', score: 2.4, legend: 'low/med/high', confidence: 0.6 },
          },
          usage: { input_tokens: 1234, output_tokens: 0 },
        }),
      captured,
    ),
  });

  const res = await client.decide('segment text', {
    rel_1: noul('Does this segment discuss the same task as the state?'),
    plan: choice('Which plan is most likely to succeed?', { patch: null, revert: null }),
    urgency: score('How urgent?', ['low', 'med', 'high']),
  });

  assert.equal(captured[0]?.url, 'https://api.typesafe.ai/v1/systemone');
  const body = captured[0]?.body as { state: string; model: string; questions: Record<string, unknown> };
  assert.equal(body.state, 'segment text');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions), ['rel_1', 'plan', 'urgency']);

  assert.equal(res.usage.input_tokens, 1234);
  const answer = res.answers.rel_1;
  assert.equal(answer?.type, 'noul');
  assert.equal(answer?.type === 'noul' ? answer.noul : -1, 0.91);
  assert.ok(res.ms >= 0);
});

test('decide: surfaces HTTP failures with status', async () => {
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    fetchImpl: mockFetch(() => new Response('unprocessable', { status: 422 })),
  });
  await assert.rejects(
    () => client.decide('x', { q: noul('is it relevant?') }),
    (err: unknown) => err instanceof S1HttpError && err.status === 422,
  );
});

test('decide: aborts on timeout with S1TimeoutError', async () => {
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    timeoutMs: 25,
    fetchImpl: mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ),
  });
  await assert.rejects(
    () => client.decide('x', { q: noul('is it relevant?') }),
    (err: unknown) => err instanceof S1TimeoutError,
  );
});

test('models: reads the deployment probe', async () => {
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    fetchImpl: mockFetch(() => jsonResponse({ data: [{ id: 'laya-typed-decisions' }, { id: 'laya-multilingual' }] })),
  });
  assert.deepEqual(await client.models(), ['laya-typed-decisions', 'laya-multilingual']);
});

test('health: Laya readiness probe (laya-serve exposes /health, not /v1/models)', async () => {
  const captured: Captured[] = [];
  const up = new S1Client({
    baseUrl: 'http://127.0.0.1:8008/',
    fetchImpl: mockFetch(() => new Response('{"status":"ok"}', { status: 200 }), captured),
  });
  assert.equal(await up.health(), true);
  assert.equal(captured[0]?.url, 'http://127.0.0.1:8008/health');

  const down = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    fetchImpl: mockFetch(() => {
      throw new Error('ECONNREFUSED');
    }),
  });
  assert.equal(await down.health(), false);
});

test('normalize: repairs non-normalized probabilities (Jev invariant gap)', () => {
  const n = normalize({ refund: 0.7, no_refund: 0.49 });
  assert.ok(Math.abs((n.refund ?? 0) + (n.no_refund ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((n.refund ?? 0) - 0.5882352941176471) < 1e-9);
});

test('s1CostUsd: Jev input-only pricing', () => {
  assert.ok(Math.abs(s1CostUsd(1_000_000) - 0.042) < 1e-12);
  assert.ok(Math.abs(s1CostUsd(15_000) - 0.00063) < 1e-12);
});
