import { S1_DEFERRED } from '@s1cap/core';
import type { DemandRow, Segment, S1Deferral } from '@s1cap/core';

export type RowScorer = (
  current: Segment, candidates: readonly Segment[],
) => readonly number[] | undefined | S1Deferral | Promise<readonly number[] | undefined | S1Deferral>;

/** One admission pool across concurrent walks. Pending anchors precede deeper BFS work. */
export function createDemandScheduler(concurrency: number) {
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.trunc(concurrency)) : 1;
  const pending: { key: string; priority: number; run(): Promise<void> }[] = [];
  let active = 0;
  const pump = (): void => {
    pending.sort((a, b) => a.priority - b.priority);
    while (active < limit && pending.length > 0) {
      const job = pending.shift()!;
      active += 1;
      void job.run().finally(() => { active -= 1; pump(); });
    }
  };
  return {
    prioritize(key: string): void {
      for (const job of pending) if (job.key === key) job.priority = -1;
    },
    run<T>(key: string, priority: number, canStart: () => boolean, task: () => Promise<T>): Promise<T | undefined> {
      return new Promise((resolve, reject) => {
        pending.push({ key, priority, run: async () => {
          try { resolve(canStart() ? await task() : undefined); }
          catch (error) { reject(error); }
        } });
        pump();
      });
    },
  };
}

/** Bounded workers preserve result order and check the deadline before each row.
 * Unstarted rows remain undefined so the graph releases them for a later walk.
 * Already admitted requests finish normally; no orphaned Promise.race requests.
 */
export async function scoreDemandRows(
  rows: readonly DemandRow[],
  score: RowScorer,
  options: {
    concurrency: number;
    canStart(): boolean;
    onError?(row: DemandRow, error: unknown): void;
    onRow?(index: number, weights: readonly number[] | undefined): void;
  },
): Promise<(readonly number[] | undefined)[]> {
  const out: (readonly number[] | undefined)[] = new Array(rows.length).fill(undefined);
  let cursor = 0;
  const workers = Number.isFinite(options.concurrency) ? Math.max(1, Math.trunc(options.concurrency)) : 1;
  await Promise.all(Array.from({ length: Math.min(workers, rows.length) }, async () => {
    while (cursor < rows.length && options.canStart()) {
      const index = cursor++;
      const row = rows[index]!;
      try {
        const result = await score(row.current, row.candidates);
        out[index] = result === S1_DEFERRED ? undefined : result;
      } catch (error) {
        options.onError?.(row, error);
      }
      options.onRow?.(index, out[index]);
    }
  }));
  return out;
}
