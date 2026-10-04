import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import {
  S1CancelledError,
  S1Client,
  S1HttpError,
  S1TimeoutError,
  S1_PROBE_TIMEOUT_MS,
  S1_TRANSPORT_BASE_MS,
  S1_TRANSPORT_PER_QUESTION_MS,
  choice,
  normalize,
  noul,
  s1TransportGuardMs,
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

/** A well-formed envelope, shared by the tests that care about something other than the reply's contents. */
const okEnvelope = {
  model: 'laya-typed-decisions',
  answers: { q1: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 0 },
};

/**
 * A fetch whose socket is accepted and then goes silent: the case a *refusal* (`ECONNREFUSED`) does not cover.
 *
 * A refused connection answers immediately, which is why the missing deadline on the probes was invisible in every
 * test that used one: the hang needs an accepted socket that never replies, and only then does the difference
 * between "no guard" and "a guard" exist at all.
 */
function blackHoleFetch(): typeof fetch {
  return mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
}

/** Let every microtask behind an abort settle, without advancing a mocked clock. */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

// ---- the transport guard ----
//
// The guard is a function of the batch because the service time is linear in it: a single constant cannot be both
// fast enough for a dead socket on a one-question call and sufficient for a sixty-four-question one. The test below
// pins the *arithmetic* of that function against the measurements it was derived from; the test after it pins that
// the function is what actually aborts a request, because a guard nothing calls is the defect this replaces.

test('the transport guard is a base plus a per-question cost, and covers the measured worst case at 64 questions', () => {
  // The two measured anchors, as numbers rather than prose. Cool GPU, in-flight 1, 1-question call: 539 ms. Soaked
  // GPU, in-flight 1, 40-question call: 40 800 ms. The rule is that the guard has to sit above the second one with
  // margin - that is the measurement that falsified the fixed 30 000 ms guard it replaces, which is below the
  // 40-question figure outright and below the 64-question extrapolation by more.
  assert.equal(S1_TRANSPORT_BASE_MS + S1_TRANSPORT_PER_QUESTION_MS * 40, 60_000);
  // The server's own cap, `serve.py:67 MAX_QUESTIONS = 64` (65 returns 413), so 64 is the largest call that exists:
  // 64 questions is the whole domain of this function and the guard ends at exactly 90 000 ms there.
  assert.equal(s1TransportGuardMs(64), 90_000);
  // The 64-question soaked figure was never measured. Extrapolating the anchored slope (40 800 / 40 = 1 020 ms per
  // question) gives 65 280 ms, and the guard must be above it - the margin is thin, and that is stated rather than
  // hidden: the guard is sized to the one measured throttled point, not to an invented one.
  assert.ok(s1TransportGuardMs(64) > (40_800 / 40) * 64, 'the guard must exceed the extrapolated 64-question cost');

  // Monotone in the batch, and floored at one question: the floor is the dead-socket detector, so an empty or
  // nonsense batch may not collapse it to a number that would cut off a real call. A zero-question call is refused
  // by the server anyway (there is nothing to answer), so the floor is the only honest value for it.
  assert.equal(s1TransportGuardMs(0), s1TransportGuardMs(1));
  assert.equal(s1TransportGuardMs(-5), s1TransportGuardMs(1));
  assert.equal(s1TransportGuardMs(Number.NaN), s1TransportGuardMs(1));
  assert.equal(s1TransportGuardMs(1.9), s1TransportGuardMs(1));
  for (let n = 1; n < 64; n += 1) {
    assert.ok(s1TransportGuardMs(n + 1) > s1TransportGuardMs(n), `the guard must grow with the batch (n=${String(n)})`);
  }

  // A dead socket on a one-question call is now detected in 11.25 s instead of 30 s - 2.7x sooner - while still
  // being 21x the measured 539 ms one-question call. That is the property the old comment claimed and this one has
  // to keep: the guard has to be affordable on the small batch even though it is generous on the large one.
  assert.equal(s1TransportGuardMs(1), 11_250);
  assert.ok(s1TransportGuardMs(1) > 539 * 10, 'a one-question call must not be cut off by the floor');
});

test('decide: the transport guard aborts with S1TimeoutError, and the deadline is not a knob', async (t) => {
  // The guard is not something a test should wait for, so the timer is mocked and advanced to the value the function
  // computes for this batch. That the guard is exported for this - and is not settable through options - is the point
  // the previous revision of this test made and this one keeps: a configurable deadline is what turned a transport
  // property into a silent quality switch, because a timeout here does not cost latency, it replaces the backend's
  // score with the lexical fallback's. What changed is the *value*, not the fact that nobody can set it: the batch
  // sets it. The old assertion here ticked a fixed 30 000 ms and would have passed for any constant at all.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
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
  const guardMs = s1TransportGuardMs(1);
  const pending = client.decide('x', { q: noul('is it relevant?') });
  t.mock.timers.tick(guardMs);
  await assert.rejects(
    () => pending,
    (err: unknown) =>
      err instanceof S1TimeoutError &&
      // The error carries the guard that actually fired, not a constant: a 64-question call that dies at 90 s has to
      // be readable in the log as 90 s, or the next reader adjusts the wrong number again.
      err.message.includes(String(guardMs)),
  );
});

test('decide: the guard a request is opened with is the one its batch size asks for', async () => {
  // The wiring, checked where the defect was: the old code read a module constant at the call site, so a change to
  // the constant moved every batch size at once. This asserts the delay handed to the timer is a function of this
  // request's question count - the property that makes the guard correct at both ends of the range.
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? -1);
    const handle = realSetTimeout(fn, ms);
    // `unref` matters here: the recorded delays are 11.25 s and 60 s, and a referenced timer that long would keep the
    // test process alive after the assertion has already passed.
    handle.unref?.();
    return handle;
  }) as typeof setTimeout;
  try {
    const client = new S1Client({
      baseUrl: 'http://127.0.0.1:8008',
      fetchImpl: mockFetch(() => jsonResponse(okEnvelope)),
    });
    await client.decide('x', { q1: noul('x') });
    const one = delays[0] as number;
    const forty = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`h${String(i)}`, noul('x')]));
    await client.decide('x', forty);
    const fortyDelay = delays[1] as number;

    assert.equal(one, s1TransportGuardMs(1));
    assert.equal(fortyDelay, s1TransportGuardMs(40));
    assert.ok(fortyDelay > one, 'a larger batch must be given longer before its socket is called dead');
    assert.ok(one < 30_000, 'and the small batch must be given less than the constant this replaces');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('decide: a cancelled caller is a cancellation, not a slow backend', async (t) => {
  // The distinction matters twice over. A cancelled session is not a reliability problem, so it must not be
  // counted as a failed call; and it is not a reason to score the batch lexically, which is what a timeout means.
  // The harness hands a plugin its own signal, so this path becomes live as soon as it is forwarded.
  //
  // The cancellation is raised at a time the *guard* has not reached, which is what makes the classification the
  // thing under test rather than the clock: the `AbortError` below is the same one the guard produces, and only the
  // caller's signal separates them.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
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
  const caller = new AbortController();
  const pending = client.decide('x', { q: noul('is it relevant?') }, { signal: caller.signal });
  t.mock.timers.tick(s1TransportGuardMs(1) - 1);
  caller.abort();
  await assert.rejects(
    () => pending,
    (err: unknown) => err instanceof S1CancelledError,
  );
});

// ---- what the caller's signal collects ----
//
// `#decideOnce` builds its request signal with `AbortSignal.any([guard.signal, opts.signal])` and drops the
// composite, so the question this pins is whether a caller signal that outlives every call - the case the report
// describes, one signal reused across a whole session - accumulates anything per call.
//
// **Measured on the runtime this package requires (Node >= 22.19, measured on 22.23.1): it accumulates no
// listeners.** `AbortSignal.any` does not subscribe to its sources; it stores a *weak* reference in the source's
// internal `kDependantSignals` set, so 300 calls leave `getEventListeners(signal, 'abort').length === 0` and no
// `MaxListenersExceededWarning` is raised even with `setMaxListeners(1, signal)`. Nothing was changed in response to
// that measurement, so **this test passes with and without a fix to `#decideOnce`**: it is a pin on the property,
// not proof of a fix, and it fails the day someone adds a listener to a caller-owned signal without removing it.
// (The scenario is not live yet either: the plugin's `decide` wrapper forwards no signal at all,
// `packages/dsh-plugin/src/index.ts:1339-1347`.)
test('decide: a caller-owned signal collects no listeners across calls, and still cancels', async () => {
  const caller = new AbortController();
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    fetchImpl: mockFetch(() => jsonResponse(okEnvelope)),
  });
  for (let i = 0; i < 25; i += 1) {
    await client.decide('x', { q: noul('is it relevant?') }, { signal: caller.signal });
  }

  // The counter is checked against a listener that is really there, so a zero below means "none added" rather
  // than "none visible" - the distinction the whole measurement turns on.
  const control = new AbortController();
  control.signal.addEventListener('abort', () => {});
  assert.equal(getEventListeners(control.signal, 'abort').length, 1, 'the listener counter must see real listeners');
  assert.equal(caller.signal.aborted, false, 'the caller was never cancelled');
  assert.equal(
    getEventListeners(caller.signal, 'abort').length,
    0,
    '25 calls must leave no listener on the caller-owned signal',
  );

  // And the pin is not satisfied by ignoring the caller: a signal that collects nothing must still end a call.
  const live = new AbortController();
  const pending = new S1Client({ baseUrl: 'http://127.0.0.1:8008', fetchImpl: blackHoleFetch() }).decide(
    'x',
    { q: noul('is it relevant?') },
    { signal: live.signal },
  );
  live.abort();
  await assert.rejects(
    () => pending,
    (err: unknown) => err instanceof S1CancelledError,
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

// ---- the probe bound ----
//
// `health()` and `models()` carried no deadline at all, so a socket that accepted the connection and then went
// silent - a black hole, as opposed to a refusal - held them open forever. `health()` is what `/s1-ping` awaits
// (`packages/dsh-plugin/src/index.ts:2094`), so that hang was reachable from a live session, and the command's own
// output ("did not answer /health in Nms") is a *duration*: it can report a slow backend, but not an infinite one.
//
// The bound is its own constant rather than `s1TransportGuardMs`, because that guard prices the inference a
// *decision* buys and a probe buys none: its 11 250 ms floor would report the guard instead of the backend. Nor is
// the probe the readiness gate for a loading backend - that is `LayaServer.waitForReady`, which polls with
// `startupTimeoutMs` and swallows refusals, and a `LAYA_PRELOAD=1` first run cannot even hang a probe because the
// checkpoints are built before uvicorn binds the port (docs/LAYA_RUNTIME.md §6).

test('the probe bound is short enough to be an answer, and priced against the measured cost of a call', () => {
  // Not the batch guard's floor: 11 250 ms of silence for a one-boolean question is a report about the guard, and
  // the caller prints the elapsed time as its answer.
  assert.ok(S1_PROBE_TIMEOUT_MS < s1TransportGuardMs(1), 'a probe must not inherit the batch guard\'s floor');
  assert.ok(S1_PROBE_TIMEOUT_MS < 10_000, 'a probe answers "is the backend there", so it must stay short');
  // The other direction, from the two measured anchors: 18 ms of fixed cost per call against the local server, and
  // 539 ms for the coolest one-question decision. A probe runs no inference, so it has to keep answering even when
  // it is delayed to the price of a whole decision - with room for a throttled device on top.
  assert.ok(S1_PROBE_TIMEOUT_MS > 539 * 5, 'a probe delayed to the cost of a real call must still answer');
});

test('health: a black-holed socket becomes "unreachable" at the probe bound instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new S1Client({ baseUrl: 'http://127.0.0.1:8008', fetchImpl: blackHoleFetch() });
  let settled: unknown = 'unsettled';
  void client.health().then((value) => {
    settled = value;
  });

  // One millisecond short of the bound: still waiting, exactly as it is for a healthy backend that is merely slow.
  t.mock.timers.tick(S1_PROBE_TIMEOUT_MS - 1);
  await drain();
  assert.equal(settled, 'unsettled', 'the probe gave up before its bound');

  // This is the assertion the unguarded version cannot satisfy at any tick: a socket that never answers must be
  // reported, not waited on.
  t.mock.timers.tick(1);
  await drain();
  assert.equal(settled, false, 'a black-holed socket must become "unreachable" at the bound, not hang');
});

test('models: a black-holed socket is a timeout at the probe bound, not a hang', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new S1Client({ baseUrl: 'http://127.0.0.1:8008', fetchImpl: blackHoleFetch() });
  let failure: unknown = null;
  void client.models().catch((err: unknown) => {
    failure = err;
  });

  t.mock.timers.tick(S1_PROBE_TIMEOUT_MS - 1);
  await drain();
  assert.equal(failure, null, 'the probe gave up before its bound');

  t.mock.timers.tick(1);
  await drain();
  // A deadline keeps the type `decide` gives it: a caller that already branches on `S1TimeoutError` reads the same
  // class here, and the message carries the bound that fired rather than one nobody can look up from the log.
  if (!(failure instanceof S1TimeoutError)) {
    throw new Error(`expected S1TimeoutError, got ${String(failure)}`);
  }
  assert.ok(failure.message.includes(String(S1_PROBE_TIMEOUT_MS)));
});

test('the probes arm a timer for the probe bound, and the happy path is untouched', async () => {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? -1);
    const handle = realSetTimeout(fn, ms);
    // `unref` matters here: the recorded delay is the probe bound, and a referenced timer that long would keep the
    // test process alive after the assertion has already passed.
    handle.unref?.();
    return handle;
  }) as typeof setTimeout;
  try {
    const client = new S1Client({
      baseUrl: 'http://127.0.0.1:8008',
      fetchImpl: mockFetch((url) =>
        url.endsWith('/v1/models')
          ? jsonResponse({ data: [{ id: 'laya-typed-decisions' }] })
          : new Response('{"status":"ok"}', { status: 200 }),
      ),
    });
    assert.equal(await client.health(), true, 'the guard must not disturb a backend that answers');
    assert.deepEqual(await client.models(), ['laya-typed-decisions']);
    assert.deepEqual(
      delays,
      [S1_PROBE_TIMEOUT_MS, S1_PROBE_TIMEOUT_MS],
      'each probe arms exactly one timer, for the probe bound',
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
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

// ---- retry on refusal ----
//
// Laya answers `503 server busy` with `Retry-After` the moment its admission semaphore is full and never queues
// (docs/LAYA_RUNTIME.md §6b), which cost the four cells of round `20261001-1300` 39% of their calls. The policy is
// off unless the caller asks for it, and what it did is reported on both paths: `attempts`/`waitedMs` on the
// result, and the same two fields on the error when the attempts run out.
//
// A timeout is still the one failure that is never retried, and the guard's new shape does not change that. This
// client has no timeout path into the retry loop at all - only `S1_RETRYABLE_STATUS` reaches it - so the policy is
// structural rather than a budget test. The guard's new value makes the original argument stronger rather than
// weaker: at 40 questions one timeout is 60 s, which is the whole retry budget the *caller* would be spending
// (`S1RetryPolicy.maxWaitMs`), and 90 s at the server's 64-question cap.

/** The way Laya refuses: a status plus its own hint, no queueing. */
function busyResponse(retryAfter?: string): Response {
  return new Response(JSON.stringify({ detail: 'server busy, try again later' }), {
    status: 503,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });
}

/** Resolve with the thrown error instead of rejecting, so its fields can be asserted. */
async function failure(p: Promise<unknown>): Promise<S1HttpError | S1CancelledError> {
  return p.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (err: unknown) => err as S1HttpError | S1CancelledError,
  );
}

test('retry: with no policy a refusal is one attempt, exactly as before', async () => {
  const captured: Captured[] = [];
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    fetchImpl: mockFetch(() => busyResponse('0'), captured),
  });
  const err = await failure(client.decide({ s: 1 }, { q1: noul('x') }));
  assert.ok(err instanceof S1HttpError);
  assert.equal(captured.length, 1, 'nothing may be retried without being asked to');
  assert.equal(err.attempts, 1);
  assert.equal(err.waitedMs, 0);
  assert.equal(err.retryAfterMs, 0, 'the server hint is read even when it is not acted on');
  assert.equal(err.status, 503);
});

test('retry: a refusal is retried, and the answer says it took two attempts', async () => {
  const captured: Captured[] = [];
  let n = 0;
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    retry: { maxAttempts: 2, respectRetryAfter: true },
    fetchImpl: mockFetch(() => (++n === 1 ? busyResponse('0') : jsonResponse(okEnvelope)), captured),
  });
  const result = await client.decide({ s: 1 }, { q1: noul('x') });
  assert.equal(captured.length, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.waitedMs, 0);
  assert.equal(result.answers.q1?.type, 'noul');
});

test('retry: the wait budget refuses a retry that cannot fit, and reports the hint it read', async () => {
  const captured: Captured[] = [];
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    // the server asks for a second, the caller allows half of one: start no retry at all
    retry: { maxAttempts: 2, respectRetryAfter: true, maxWaitMs: 500 },
    fetchImpl: mockFetch(() => busyResponse('1'), captured),
  });
  const err = await failure(client.decide({ s: 1 }, { q1: noul('x') }));
  assert.ok(err instanceof S1HttpError);
  assert.equal(captured.length, 1, 'a retry that cannot fit the budget must not be started');
  assert.equal(err.retryAfterMs, 1000);
  assert.equal(err.attempts, 1);
});

test('retry: attempts stop at maxAttempts and the failure carries the count', async () => {
  const captured: Captured[] = [];
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    retry: { maxAttempts: 3, respectRetryAfter: true },
    fetchImpl: mockFetch(() => busyResponse('0'), captured),
  });
  const err = await failure(client.decide({ s: 1 }, { q1: noul('x') }));
  assert.ok(err instanceof S1HttpError);
  assert.equal(captured.length, 3);
  assert.equal(err.attempts, 3);
});

test('retry: a 400 is a request the server would refuse again, so it is not retried', async () => {
  const captured: Captured[] = [];
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    retry: { maxAttempts: 3, respectRetryAfter: true },
    fetchImpl: mockFetch(() => new Response('{"detail":"bad request"}', { status: 400 }), captured),
  });
  const err = await failure(client.decide({ s: 1 }, { q1: noul('x') }));
  assert.ok(err instanceof S1HttpError);
  assert.equal(captured.length, 1);
});

test('retry: respectRetryAfter=false uses the fallback delay instead of the hint', async () => {
  const captured: Captured[] = [];
  let n = 0;
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    retry: { maxAttempts: 2, respectRetryAfter: false, fallbackDelayMs: 0 },
    fetchImpl: mockFetch(() => (++n === 1 ? busyResponse('5') : jsonResponse(okEnvelope)), captured),
  });
  const result = await client.decide({ s: 1 }, { q1: noul('x') });
  assert.equal(captured.length, 2, 'a five-second hint must not be obeyed when the policy says not to');
  assert.equal(result.attempts, 2);
});

test('retry: a cancellation during the wait is a cancellation, not a backend failure', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new S1Client({
    baseUrl: 'http://127.0.0.1:8008',
    retry: { maxAttempts: 3, respectRetryAfter: true },
    fetchImpl: mockFetch(() => {
      calls += 1;
      return busyResponse('5');
    }),
  });
  const pending = client.decide({ s: 1 }, { q1: noul('x') }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const err = await failure(pending);
  assert.ok(err instanceof S1CancelledError, `expected a cancellation, got ${String(err)}`);
  assert.equal(calls, 1, 'the wait must end with the caller, not outlive it');
  assert.equal(err.attempts, 1);
});
