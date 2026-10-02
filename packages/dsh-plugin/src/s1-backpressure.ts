/**
 * S1 BACKPRESSURE — stop asking a backend that is refusing, and start again when it is not.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS EXISTS, IN MEASURED NUMBERS
 *
 * Round `20261002-2037`, cell C2, from the cell's own control plane (`evidence/C2/control.jsonl`):
 * 5 992 `s1_call` records, 3 859 of them refused (64.4 %) - 3 792 `503 {"detail":"server busy"}`
 * and 67 `TypeError: fetch failed` - over a 2 219.7 s span, which is **2.70 requests/second**.
 * The refusals are not a burst: every one of the run's 74 thirty-second buckets carries them, and
 * the refusal rate never falls below roughly a third. The backend's admission limit is 16 concurrent
 * requests and it *refuses* rather than queues (docs/LAYA_RUNTIME.md §6b). One cell saturated it by
 * itself and then kept asking at the same rate for 37 minutes while being told no.
 *
 * The mechanism that allowed that is not the pair count. `createUpkeepQueue` drains up to
 * `maxPerFlush` events per tick and *does not await the async handler* between them
 * (`packages/core/src/upkeep-queue.ts`, `runOne`), so N queued segments mean N `scoreNew` loops in
 * flight, each issuing its own requests. Serialising within one segment - which
 * `packages/dsh-plugin/src/s1-relevance.ts` already does, one batch at a time - therefore bounds
 * nothing across segments. That is the shape the admission limit punishes.
 *
 * Retrying was already correct and is unchanged: `s1.retryAttempts` is handed to the client, which
 * waits the server's own `Retry-After` (measured: 1 s) before its second attempt, and every attempt
 * is recorded in `attempts`/`waitedMs` on the `s1_call` record. A retry is the right answer to *one*
 * refusal. It is the wrong answer to a backend that is refusing *everything*, because the retry is
 * another request in the same admission window; that is what this module is for.
 *
 * ---------------------------------------------------------------------------------------------
 * THE POLICY, AND WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - **Nothing is queued.** The backend refuses rather than queues; a local queue would only move
 *     the refusal to a place where it costs memory and latency instead of a line. A caller that
 *     cannot be admitted is told so immediately and defers its work.
 *   - **Concurrency is capped** by `s1.admissionLimit`, which is the backend's own property (16 for
 *     the Laya server this project runs) and is in the config for that reason.
 *   - **A refusal streak opens the breaker.** After `openAfterRefusals` consecutive refusals - or
 *     `openAfterRefusals` refusals inside a `windowMs` window, which catches the interleaved case
 *     the round actually produced - no request is sent for `cooldownMs`. Then exactly **one** probe
 *     is admitted. If it answers, the breaker closes and the streak is cleared; if it is refused,
 *     the cooldown restarts. When the backend comes back, the next probe finds it.
 *   - **It never decides what a pair is worth.** Deferral does not score anything lexically, does not
 *     drop a pair and does not mark it irrelevant: it leaves the work for the next tick, and the
 *     graph's cursor does not advance over it (`AssociationGraph.scoreNew`). A refused pair is
 *     therefore *not* counted in `scoredPairs`, which is what keeps `judgedPairs / scoredPairs` an
 *     honest coverage ratio rather than one inflated by work the run declined to offer. What was
 *     left out is counted in `deferredPairs`, which is written on the assembly record beside it.
 *
 * Time is injected, so the whole state machine is testable without sleeping.
 */

/** Configured facts about the backend, and the thresholds at which it is treated as saturated. */
export interface BackpressureOptions {
  /**
   * Requests this cell may have in flight at once. The backend's admission limit is the number that
   * matters; the default is deliberately below the 16 a local `laya-serve` admits, because a cell
   * that is *at* the limit is a cell whose next request is the one that gets refused.
   */
  maxInFlight?: number;
  /** consecutive refusals that open the breaker (default 5) */
  openAfterRefusals?: number;
  /** how long refusals are remembered for the streak test (default 15 000 ms) */
  windowMs?: number;
  /** how long no request is sent once the breaker is open (default 15 000 ms) */
  cooldownMs?: number;
  /** injected for tests */
  now?(): number;
  onWarn?(message: string): void;
}

export type BreakerState = 'closed' | 'open' | 'probing';

/** Why a request was not admitted. Both reasons are reported; neither is a failure of the backend. */
export type DeferralReason = 'in-flight-limit' | 'breaker-open';

export type Admission = { ok: true } | { ok: false; reason: DeferralReason };

export interface BackpressureStats {
  /** requests the plugin asked to send */
  attempts: number;
  /** requests actually handed to the client */
  sent: number;
  /** requests the client answered */
  ok: number;
  /** requests the client refused (a retryable status) or could not deliver */
  refused: number;
  /** requests not sent at all, and why */
  deferredByLimit: number;
  deferredByBreaker: number;
  /** times the breaker opened, and times a probe found the backend answering again */
  opened: number;
  recovered: number;
  state: BreakerState;
  /** consecutive refusals currently standing - not the in-flight count, which is a gauge */
  refusalStreak: number;
  inFlight: number;
  maxInFlight: number;
  /** when the breaker was last opened, epoch ms (0 when it has never opened) */
  openedAt: number;
}

export interface Backpressure {
  /**
   * Ask permission to send one request. `ok: false` means *do not send*; the caller defers its work
   * and tries again on a later tick.
   */
  tryAcquire(): Admission;
  /** The request was answered. Closes the breaker and clears the streak. */
  recordSuccess(): void;
  /** The request was refused (or could not be delivered). May open the breaker. */
  recordRefusal(): void;
  stats(): BackpressureStats;
  /** `open` and `probing` both mean "not sending at this instant" */
  isBlocked(): boolean;
}

export function createBackpressure(opts: BackpressureOptions = {}): Backpressure {
  const maxInFlight = Math.max(1, Math.trunc(opts.maxInFlight ?? 8));
  const openAfterRefusals = Math.max(1, Math.trunc(opts.openAfterRefusals ?? 5));
  const windowMs = Math.max(0, opts.windowMs ?? 15_000);
  const cooldownMs = Math.max(0, opts.cooldownMs ?? 15_000);
  const clock = opts.now ?? Date.now;

  const refusals: number[] = [];
  let state: BreakerState = 'closed';
  let openedAt = 0;
  let inFlight = 0;
  const stats: BackpressureStats = {
    attempts: 0,
    sent: 0,
    ok: 0,
    refused: 0,
    deferredByLimit: 0,
    deferredByBreaker: 0,
    opened: 0,
    recovered: 0,
    state: 'closed',
    refusalStreak: 0,
    inFlight: 0,
    maxInFlight,
    openedAt: 0,
  };

  /** Refusals inside the window, oldest first. Pruned on every read, so the streak is a real measure. */
  const recentRefusals = (at: number): number => {
    while (refusals.length > 0 && at - (refusals[0] as number) > windowMs) refusals.shift();
    return refusals.length;
  };

  const open = (at: number, why: string): void => {
    state = 'open';
    openedAt = at;
    stats.opened += 1;
    stats.state = 'open';
    stats.openedAt = at;
    opts.onWarn?.(
      `[s1cap] System-1 backend is refusing (${why}): pausing asks for ${cooldownMs}ms, then one probe. ` +
        'Pairs that are not asked about are deferred, not scored lexically, and are reported as `deferredPairs`.',
    );
  };

  return {
    tryAcquire(): Admission {
      stats.attempts += 1;
      const at = clock();
      if (state !== 'closed') {
        // `open` waits out the cooldown; `probing` is the single in-flight probe and admits nobody else.
        if (state === 'open' && at - openedAt >= cooldownMs) {
          state = 'probing';
          stats.state = 'probing';
        } else {
          stats.deferredByBreaker += 1;
          return { ok: false, reason: 'breaker-open' };
        }
      }
      if (inFlight >= maxInFlight) {
        stats.deferredByLimit += 1;
        return { ok: false, reason: 'in-flight-limit' };
      }
      inFlight += 1;
      stats.sent += 1;
      stats.inFlight = inFlight;
      return { ok: true };
    },

    recordSuccess(): void {
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.ok += 1;
      refusals.length = 0;
      stats.refusalStreak = 0;
      if (state !== 'closed') {
        stats.recovered += 1;
        opts.onWarn?.('[s1cap] the System-1 backend is answering again: resuming at the configured rate');
      }
      state = 'closed';
      stats.state = 'closed';
    },

    recordRefusal(): void {
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.refused += 1;
      const at = clock();
      refusals.push(at);
      const inWindow = recentRefusals(at);
      stats.refusalStreak = inWindow;
      if (state === 'probing') {
        // The probe was refused: the backend is still saturated, so the pause restarts in full rather
        // than degrading into a poll. A probe that cannot change the answer is a request per cooldown.
        open(at, 'the recovery probe was refused');
        return;
      }
      if (state === 'closed' && inWindow >= openAfterRefusals) {
        open(at, `${inWindow} refusal(s) within ${windowMs}ms`);
      }
    },

    stats(): BackpressureStats {
      return { ...stats };
    },

    isBlocked(): boolean {
      if (state === 'probing') return true;
      if (state !== 'open') return false;
      if (clock() - openedAt >= cooldownMs) return false; // the next tryAcquire() becomes the probe
      return true;
    },
  };
}
