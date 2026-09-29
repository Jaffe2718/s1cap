/**
 * UPKEEP QUEUE — the asynchronous side of the loop (docs/ARCHITECTURE.md §4).
 *
 * Association-graph upkeep never runs inside the per-call hook: new session events are enqueued as they
 * arrive and folded into the graph on a later tick. The per-call assembly therefore has a hard, small
 * latency budget, and the graph is allowed to lag the session by at most `maxLagTurns` turns.
 *
 * Two properties this type has to guarantee:
 *   - `flush()` is bounded: at most `maxPerFlush` events per tick, so a burst cannot stall the loop;
 *   - nothing throws at the caller: a failing handler is counted and the event is dropped, because a
 *     half-built governor must never be able to break the harness.
 */

export interface UpkeepQueueOptions<T> {
  /** how many events one tick may absorb */
  maxPerFlush?: number;
  /** how many events may wait; beyond this the oldest are dropped and counted */
  capacity?: number;
  /** how far the graph may lag the session, in turns */
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
  /** true while the queue holds more than the allowed lag */
  overLag: boolean;
  maxLagTurns: number;
}

export interface UpkeepQueue<T> {
  enqueue(event: T): void;
  /** drain up to `maxPerFlush` events; safe to call from a timer */
  flush(): number;
  /** drain everything (tests, shutdown) */
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
    // A handler may be async now that the System-1 scorer is a network call. The promise is awaited before the
    // next event starts, so the graph is folded in the order the events arrived and a burst cannot interleave
    // two scorers over one window. A rejection is caught exactly like a synchronous throw: counted, reported,
    // and the event is dropped - the harness is never allowed to see it.
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
          opts.onWarn?.(`upkeep queue is full (capacity ${capacity}); dropping the oldest events`);
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
        overLag: queue.length > maxLagTurns,
        maxLagTurns,
      };
    },
  };
}
