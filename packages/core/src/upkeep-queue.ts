/**
 * UPKEEP QUEUE — the asynchronous side of the loop (docs/ARCHITECTURE.md §4).
 *
 * Association-graph upkeep never runs inside the per-call hook: new session events are enqueued as they
 * arrive and folded into the graph on a later tick. The per-call assembly therefore has a hard, small
 * latency budget.
 *
 * **What this type actually guarantees, corrected - the header used to claim more.**
 *
 *   - `flush()` is bounded: at most `maxPerFlush` events per tick, so a burst cannot stall the loop. That bound
 *     holds for `flush()` and **not** for `drain()`, which empties the queue by design and runs on the live path
 *     (the anchor wait in `step-observer.ts` and every `turn/end`). `drain()` is not a bug to be bounded; it is
 *     the caller saying "the turn is over, nothing is waiting on this work".
 *   - nothing throws at the caller: a failing handler is counted and the event is dropped, because a
 *     half-built governor must never be able to break the harness.
 *   - events are folded in arrival order, and **the handler is NOT awaited between them**. An earlier version of
 *     this header claimed the opposite - "the promise is awaited before the next event starts, so ... a burst
 *     cannot interleave two scorers over one window" - and the opposite is what the code does: `runOne` calls
 *     `onEvent`, attaches a `.catch` and returns, while `run()` shifts the next event immediately. With an async
 *     handler (the System-1 scorer is a network call) N handlers are therefore in flight at once, and the
 *     ordering guarantee that survives is the graph's own scoring cursor, not this queue's drain loop. That
 *     distinction is load-bearing and was measured: round `20261002-2037` sent 5 992 requests at 2.70/s, 64.4 %
 *     of them refused, because several `scoreNew` loops ran concurrently over one backend. The bound that exists
 *     for it is `s1.admissionLimit` in `s1-backpressure.ts`, which is where the concurrency is actually governed.
 *
 * `maxLagTurns` is accepted, bounded and reported, and **it does not bound anything** - see `overLag` below and
 * `UNENFORCED_KNOBS` in `config.ts`, which is the registry of knobs in this state.
 */

export interface UpkeepQueueOptions<T> {
  /** how many events one tick may absorb. Bounds `flush()`; `drain()` deliberately ignores it */
  maxPerFlush?: number;
  /**
   * How many events may wait; beyond this the oldest are dropped and counted.
   *
   * A drop is **content loss**, not backpressure: the segment that event carried never reaches the graph, so
   * every recall measurement after it is over a session with a hole in it. The counter is surfaced on the
   * assembly record (`AssemblyEvent.upkeepDropped`) for exactly that reason - a number on `/s1` that a round does
   * not persist is not a record of the loss.
   */
  capacity?: number;
  /**
   * How far the graph may lag the session, in turns. **Accepted, reported, and read by nothing that acts.**
   *
   * `overLag` compares it against a count of pending events, so the unit does not match the name (one step emits
   * several events, so "more events pending than turns of allowed lag" is true whenever anything is pending), and
   * no caller branches on either the flag or the bound. It is kept because it is in the shipped policy and on the
   * panel, and it is marked here and in `UNENFORCED_KNOBS` (`config.ts`) rather than left to read as a guarantee.
   */
  maxLagTurns?: number;
  /** called for each drained event; must not throw (throws are caught and counted). May return a promise. */
  onEvent(event: T): void | Promise<void>;
  onWarn?(message: string): void;
}

export interface UpkeepQueueStats {
  /** accepted into the queue */
  enqueued: number;
  /** folded into the graph */
  applied: number;
  /** dropped because the queue was full */
  dropped: number;
  /** handler failures (counted, never rethrown) */
  errors: number;
  /** events still waiting */
  pending: number;
  /** flushes performed */
  flushes: number;
  /**
   * True while more events are pending than `maxLagTurns` allows.
   *
   * Read the name as the gauge it is and not as the bound it was named for: the comparison is
   * `pending > maxLagTurns`, i.e. **pending events against a number in turns**, and with several events per step
   * it is true whenever anything is waiting at all. It is reported on `/s1` and acted on by nothing - the real
   * bound on scoring concurrency is `s1.admissionLimit`. Renaming it `pendingOverLimit` would be more honest and
   * would also change a field a panel and a round's notes already read, so the correction is here instead.
   */
  overLag: boolean;
  maxLagTurns: number;
}

export interface UpkeepQueue<T> {
  enqueue(event: T): void;
  /** drain up to `maxPerFlush` events; safe to call from a timer */
  flush(): number;
  /**
   * Drain everything (tests, shutdown, and the two live callers that mean it: the anchor wait's loop and every
   * `turn/end`). **Deliberately not bounded by `maxPerFlush`** - the bound exists so a *tick* cannot stall the
   * loop, and this call is made from a point where nothing is waiting on the turn.
   */
  drain(): number;
  clear(): void;
  stats(): UpkeepQueueStats;
}

export function createUpkeepQueue<T>(opts: UpkeepQueueOptions<T>): UpkeepQueue<T> {
  const maxPerFlush = Math.max(1, opts.maxPerFlush ?? 8);
  const capacity = Math.max(1, opts.capacity ?? 256);
  const maxLagTurns = Math.max(0, opts.maxLagTurns ?? 2);
  const queue: T[] = [];
  let enqueued = 0;
  let applied = 0;
  let dropped = 0;
  let errors = 0;
  let flushes = 0;

  function runOne(event: T): void {
    // A handler may be async now that the System-1 scorer is a network call. The promise is **not** awaited before
    // the next event starts (see the header): the `.catch` is what keeps a rejection from reaching the harness, and
    // `applied` counts the event as folded the moment its handler is entered. The ordering guarantee the graph
    // relies on is its own scoring cursor, and the bound on how many handlers may be in flight is the admission
    // gate in the caller, not this function. A rejection is caught exactly like a synchronous throw: counted,
    // reported, and the event is dropped - the harness is never allowed to see it.
    try {
      const result = opts.onEvent(event) as void | Promise<void>;
      if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
        applied += 1;
        void (result as Promise<void>).catch((err: unknown) => {
          errors += 1;
          opts.onWarn?.(`upkeep handler failed (ignored): ${String(err)}`);
        });
        return;
      }
      applied += 1;
    } catch (err) {
      errors += 1;
      opts.onWarn?.(`upkeep handler failed (ignored): ${String(err)}`);
    }
  }

  function run(limit: number): number {
    let done = 0;
    while (done < limit && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      runOne(next);
      done += 1;
    }
    if (done > 0) flushes += 1;
    return done;
  }

  return {
    enqueue(event: T): void {
      if (queue.length >= capacity) {
        queue.shift();
        dropped += 1;
        if (dropped === 1) {
          // Once per session, on the transition, because this is the moment the graph acquires a hole: the event
          // dropped here - and every one dropped after it, silently - never becomes a segment, so every recall
          // measurement over this session is over a session missing content. The warning is the live half; the
          // persisted half is `AssemblyEvent.upkeepDropped`, which the caller copies from `stats().dropped` onto
          // the next assembly record.
          opts.onWarn?.(
            `upkeep queue is full (capacity ${capacity}); the oldest session events are being dropped, so the ` +
              'graph is losing segments (the total is reported as `upkeepDropped` on the assembly records)',
          );
        }
      }
      queue.push(event);
      enqueued += 1;
    },
    flush(): number {
      return run(maxPerFlush);
    },
    drain(): number {
      return run(queue.length);
    },
    clear(): void {
      queue.length = 0;
    },
    stats(): UpkeepQueueStats {
      return {
        enqueued,
        applied,
        dropped,
        errors,
        pending: queue.length,
        flushes,
        // The comparison, stated as what it is: pending *events* against a bound named in *turns*. Both are
        // reported so the unit mismatch is visible in the record rather than only in this comment.
        overLag: queue.length > maxLagTurns,
        maxLagTurns,
      };
    },
  };
}
