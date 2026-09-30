/**
 * Per-session persistence for the association graph.
 *
 * Two properties the caller must not be able to get wrong, which is why they are the design rather than the
 * documentation. (1) **Isolation by construction**: one file per session, so a forgotten filter cannot read
 * another session's edges - with a shared table, it can. (2) **A restart must not re-pay for scoring**: the
 * snapshot carries the graph's scoring cursor, so a session that resumes where it left off does not ask the
 * System-1 backend about pairs it already bought.
 *
 * The surface is deliberately small - load, persist, list - so a SQLite implementation can replace this one
 * behind the same interface. A file is the right store today because a session's graph is a few hundred
 * segments, and because the plugin has to run inside a host that installs it into `node_modules`, where an
 * extra native dependency is a liability rather than a convenience.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RgSnapshot } from './assoc-graph.ts';

/** A session id is arbitrary text from the host; it must never become a path. */
function fileNameFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  // Two different ids that sanitise to the same 80 characters must not share a file: that would be a silent
  // merge of two sessions' graphs, which is the exact failure this store exists to prevent.
  let hash = 5381;
  for (let i = 0; i < sessionId.length; i += 1) hash = ((hash << 5) + hash + sessionId.charCodeAt(i)) | 0;
  return `rg-${safe}-${(hash >>> 0).toString(16)}.json`;
}

export interface RgStore {
  /** The snapshot for a session, or `undefined` when there is nothing to resume. */
  load(sessionId: string): RgSnapshot | undefined;
  /** Write the snapshot. A failed write costs durability, never the running session. */
  persist(sessionId: string, snapshot: RgSnapshot): boolean;
  /** Session ids currently on disk, for status reporting. */
  sessions(): string[];
}

export interface RgFileStoreOptions {
  dir: string;
  onWarn?: (message: string) => void;
}

export function createRgFileStore(opts: RgFileStoreOptions): RgStore {
  const pathFor = (sessionId: string): string => join(opts.dir, fileNameFor(sessionId));
  // A file name is not the id, and the id is what the caller keys on, so the listing keeps the pair.
  const ids = new Map<string, string>();

  return {
    load(sessionId: string): RgSnapshot | undefined {
      const file = pathFor(sessionId);
      ids.set(file, sessionId);
      if (!existsSync(file)) return undefined;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as RgSnapshot;
        // A graph from another session is not a graph for this one, even if the file was readable. This check
        // is cheap and it is the last thing standing between a misnamed file and a contaminated session.
        if (typeof parsed.sessionId === 'string' && parsed.sessionId !== sessionId) {
          opts.onWarn?.(`[s1cap] rg file for ${sessionId} carries another session; starting empty`);
          return undefined;
        }
        return parsed;
      } catch (err) {
        // Corrupt or from an older schema: start empty rather than half-restore. The cost is the scoring this
        // session has to redo, never the correctness of what it then assembles.
        opts.onWarn?.(`[s1cap] rg snapshot unreadable for ${sessionId} (starting empty): ${String(err)}`);
        return undefined;
      }
    },

    persist(sessionId: string, snapshot: RgSnapshot): boolean {
      try {
        mkdirSync(opts.dir, { recursive: true });
        const file = pathFor(sessionId);
        ids.set(file, sessionId);
        // Temp-then-rename: a reader (or a crash) sees either the previous snapshot or the new one, never a
        // half-written file that JSON.parse would reject and the loader would then treat as "no history".
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...snapshot, sessionId }), 'utf8');
        renameSync(tmp, file);
        return true;
      } catch (err) {
        opts.onWarn?.(`[s1cap] rg snapshot not persisted for ${sessionId}: ${String(err)}`);
        return false;
      }
    },

    sessions(): string[] {
      try {
        if (!existsSync(opts.dir)) return [];
        // Names are derived from ids, not the other way round: the reverse map holds the exact id a file was
        // written for. A file this process never touched reports under its own name, which is honest about the
        // one thing status cannot recover without reading every file - that it came from another run.
        return readdirSync(opts.dir)
          .filter((name) => name.startsWith('rg-') && name.endsWith('.json'))
          .map((name) => ids.get(join(opts.dir, name)) ?? name);
      } catch {
        return [];
      }
    },
  };
}
