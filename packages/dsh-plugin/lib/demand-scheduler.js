import { S1_DEFERRED } from '@s1cap/core';
                                                                  

                         
                                                   
                                                                                                      

/** Bounded workers preserve result order and check the deadline before each row.
 * Unstarted rows remain undefined so the graph releases them for a later walk.
 * Already admitted requests finish normally; no orphaned Promise.race requests.
 */
export async function scoreDemandRows(
  rows                      ,
  score           ,
  options                                                                                              ,
)                                             {
  const out                                    = new Array(rows.length).fill(undefined);
  let cursor = 0;
  const workers = Number.isFinite(options.concurrency) ? Math.max(1, Math.trunc(options.concurrency)) : 1;
  await Promise.all(Array.from({ length: Math.min(workers, rows.length) }, async () => {
    while (cursor < rows.length && options.canStart()) {
      const index = cursor++;
      const row = rows[index] ;
      try {
        const result = await score(row.current, row.candidates);
        out[index] = result === S1_DEFERRED ? undefined : result;
      } catch (error) {
        options.onError?.(row, error);
      }
    }
  }));
  return out;
}
