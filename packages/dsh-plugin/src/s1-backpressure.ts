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
 *     **Corrected 2026-10-05: the refusal half is right and the conclusion drawn from it is not.** A refusal
 *     really is excluded from `scoredPairs` - but `scoredPairs` also counted **re-offers**, so the ratio was
 *     never an honest coverage. Measured in round `20261004-0233`'s C2: `scoredPairs` 10 157 against **2 211**
 *     distinct pairs in the graph's `scores` map (exactly `67*66/2`), i.e. **4.59x** inflation of the
 *     denominator from duplicate work, before any refusal is considered. `deferredPairs` is a further trap for a
 *     reader of that ratio: it is a **tail counted once from the first refusal**, not a rate - `16 767 =
 *     Sum_{i=23}^{184} i` with `185 - 23 = 162 = deferredSegments`, and it does not shrink as the graph catches
 *     up. The two are also **not additive**: `scoredPairs + deferredPairs` = 26 924 against 17 020 offered, with
 *     1 958 pairs counted in both. A coverage figure has to be built from **distinct pairs settled against
 *     `Sum min(i, w)`**, not from this pair of counters.
 *
 * Time is injected, so the whole state machine is testable without sleeping.
 */

/**
 * The thresholds a gate uses when the caller names none.
 *
 * Exported because they are *governance*: a round that did not state `openAfterRefusals` still ran with
 * a number, and "which knobs actually governed this run" has to be answerable from the round's own
 * artifacts rather than from reading this file at the time (F4 in `s1cap-audit-lane.md`).
 */
export const BACKPRESSURE_DEFAULTS = {
  openAfterRefusals: 5,
  windowMs: 15_000,
  cooldownMs: 15_000,
} as const;

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
  /**
   * Every state change of the breaker, as it happens.
   *
   * The end state alone is not enough. `stats().state` is a gauge: a session that opened the breaker
   * three times and recovered before the run ended is indistinguishable in it from one that never
   * paused, and "the run stopped asking because the backend refused" is exactly the diagnosis this
   * module exists to make separable from "because our own cap was full" (F4). The plugin writes these
   * onto the tape so the transitions survive the process.
   */
  onTransition?(transition: BreakerTransition): void;
}

/** One state change of the breaker, with the counters that were standing when it happened. */
export interface BreakerTransition {
  /** epoch ms, from the injected clock */
  at: number;
  state: BreakerState;
  /** why the breaker moved - the same sentence `onWarn` receives */
  reason: string;
  /** what the transition was from, so a reader does not have to reconstruct the sequence */
  from: BreakerState;
  inFlight: number;
  deferredByLimit: number;
  deferredByBreaker: number;
  refusalStreak: number;
  /** when the breaker was opened, carried on every transition while it is not closed */
  openedAt: number;
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
  /** requests the client **answered** - a real answer, and the only thing that closes the breaker */
  ok: number;
  /** requests the client refused (a retryable status) or could not deliver */
  refused: number;
  /**
   * Requests that failed without an answer: a transport timeout, an unreachable backend (`TypeError: fetch
   * failed`), a cancellation, or a request that was sent and settled with no usable reply.
   *
   * Its own counter because all three of the alternatives lie about it. Counting them as `ok` - which is what the
   * scorer did until this field existed - reports a dead backend as healthy, clears the refusal streak and closes
   * the breaker, so the gate that exists to stop a cell hammering a saturated backend never opens for the failure
   * kind that dominated the measured round (67 `TypeError: fetch failed` beside 3 792 `503`s). Counting them as
   * `refused` would open the breaker on a *slow* backend and on the caller's own cancellation, which is the
   * opposite error. Counting them as `slotsLeaked` would be wrong too: the slot was handed back by a request that
   * really did leave the cell. So: a third number, and the slot is released without a claim about the backend.
   *
   * It is per *request*, not per window: a window that needed three attempts and failed on all three adds three.
   * What it therefore cannot say on its own is whether the backend was unreachable or merely unusable - the
   * scorer's own `timedOut` / `cancelled` / `failures` counters are the per-window reading beside it.
   */
  transportFailures: number;
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
  /**
   * Slots that were handed back without a request ever being sent for them.
   *
   * A slot is the right to have one request in flight. `tryAcquire()` takes it and *something* must give
   * it back - a success, a refusal, or this. Without a counter, a path that acquires and never releases is
   * invisible until the effective cap is zero and every window is deferred with no stated cause (F16.3 in
   * `s1cap-audit-lane.md`). It is a number in the artifacts rather than a comment promising it cannot
   * happen.
   */
  slotsLeaked: number;
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
  /**
   * The request left the cell and came back with no answer: a timeout, an unreachable backend, a cancellation, an
   * unreadable reply.
   *
   * It releases the slot and counts itself, and **it deliberately does not touch the breaker or the streak**.
   * `recordSuccess()` is the wrong call for it - it is not an answer, and reporting it as one is how a backend
   * that never answered anything read as healthy on `/s1`. `recordRefusal()` would be wrong in the other
   * direction: a 30 s timeout is a backend that was *working* on the request, and a caller's cancellation says
   * nothing about the backend at all, so pausing on either would add a pause to a server that is merely slow.
   * Whether a slow backend should also be paused is a policy decision this method does not make;
   * `s1-relevance.ts` is where it would be made, and `transportFailures` is the number it would be made from.
   */
  recordTransportFailure(): void;
  /**
   * Give a slot back when no request was ever sent for it, and count it.
   *
   * The path this exists for: a caller acquires, then throws or answers "there is no backend" before the
   * request leaves. `recordSuccess()` would report that as an answered request, which it was not; doing
   * nothing leaks the slot for the life of the process. This is the third exit, and `slotsLeaked` is the
   * number that says how often it was needed.
   */
  recordLeak(): void;
  stats(): BackpressureStats;
  /** The thresholds this gate actually resolved, defaults included. */
  policy(): { maxInFlight: number; openAfterRefusals: number; windowMs: number; cooldownMs: number };
  /** `open` and `probing` both mean "not sending at this instant" */
  isBlocked(): boolean;
}

export function createBackpressure(opts: BackpressureOptions = {}): Backpressure {
  const maxInFlight = Math.max(1, Math.trunc(opts.maxInFlight ?? 8));
  const openAfterRefusals = Math.max(1, Math.trunc(opts.openAfterRefusals ?? BACKPRESSURE_DEFAULTS.openAfterRefusals));
  const windowMs = Math.max(0, opts.windowMs ?? BACKPRESSURE_DEFAULTS.windowMs);
  const cooldownMs = Math.max(0, opts.cooldownMs ?? BACKPRESSURE_DEFAULTS.cooldownMs);
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
    transportFailures: 0,
    deferredByLimit: 0,
    deferredByBreaker: 0,
    opened: 0,
    recovered: 0,
    state: 'closed',
    refusalStreak: 0,
    inFlight: 0,
    maxInFlight,
    openedAt: 0,
    slotsLeaked: 0,
  };

  /** Refusals inside the window, oldest first. Pruned on every read, so the streak is a real measure. */
  const recentRefusals = (at: number): number => {
    while (refusals.length > 0 && at - (refusals[0] as number) > windowMs) refusals.shift();
    return refusals.length;
  };

  /**
   * Move the breaker and report it.
   *
   * Every assignment to `state` goes through here, so a new branch cannot change the state without the
   * transition being reported: the single exit is what makes "no `s1-gate` line for a run that opened the
   * breaker" impossible rather than merely unlikely.
   */
  const move = (to: BreakerState, from: BreakerState, at: number, reason: string): void => {
    state = to;
    stats.state = to;
    if (to === 'open') {
      openedAt = at;
      stats.openedAt = at;
    } else {
      // The gauge follows the state machine: `openedAt` is "when the breaker was last opened" and it is
      // zero again once the breaker is not open. `stats()` copies the object, so the reset reaches `/s1`.
      stats.openedAt = 0;
    }
    opts.onTransition?.({
      at,
      state: to,
      from,
      reason,
      inFlight,
      deferredByLimit: stats.deferredByLimit,
      deferredByBreaker: stats.deferredByBreaker,
      refusalStreak: stats.refusalStreak,
      openedAt,
    });
  };

  const open = (at: number, why: string): void => {
    const from = state;
    stats.opened += 1;
    move('open', from, at, why);
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
          stats.refusalStreak = recentRefusals(at);
          move('probing', 'open', at, `the ${cooldownMs}ms cooldown elapsed; admitting one probe`);
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
        move('closed', state, clock(), 'the backend answered; resuming at the configured rate');
        opts.onWarn?.('[s1cap] the System-1 backend is answering again: resuming at the configured rate');
      } else {
        state = 'closed';
        stats.state = 'closed';
      }
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

    recordTransportFailure(): void {
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.transportFailures += 1;
    },

    recordLeak(): void {
      // Named for what it is: a slot came back without a request having been sent for it. It is not a
      // refusal (the backend said nothing) and not a success (nothing answered), so it gets its own
      // counter rather than being folded into either.
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.slotsLeaked += 1;
    },

    stats(): BackpressureStats {
      return { ...stats };
    },

    policy() {
      return { maxInFlight, openAfterRefusals, windowMs, cooldownMs };
    },

    isBlocked(): boolean {
      if (state === 'probing') return true;
      if (state !== 'open') return false;
      if (clock() - openedAt >= cooldownMs) return false; // the next tryAcquire() becomes the probe
      return true;
    },
  };
}
