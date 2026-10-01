/**
 * Control-plane JSONL sink (docs/CONTROL_PLANE_LOGGING.md).
 *
 * Two decisions worth stating, because both are deliberate:
 *
 * 1. **Synchronous append (`appendFileSync`).** The volume is one line per LLM call, and a round is far
 *    more expensive than a small write. Asynchronous buffering would risk losing the records of the very
 *    round that crashed — exactly the ones worth having — so ordering and durability win over throughput.
 * 2. **Failures never propagate.** A broken sink must not break a session: errors are counted and reported
 *    through `onError` only. This is the same rule the plugin applies to every other optional surface.
 *
 * Rotation keeps the file bounded: when it passes `maxBytes` it is renamed to `<path>.1` (replacing any
 * previous rotation) and counting starts again.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

                                   
                  
                 
                
                    
 

                              
                        
                            
                            
 

                                     
               
                    
                                  
 

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Relative telemetry paths resolve against `DSH_HOME` (set by the `dsh` launcher and by the desktop app),
 * not against whatever working directory the harness happens to have. Without this, `./.s1cap/control.jsonl`
 * would land next to the shell that started DSH — surprising, and easy to lose.
 */
export function resolveTelemetryPath(path        , home                     = process.env['DSH_HOME'])         {
  if (isAbsolute(path)) return path;
  return home === undefined || home === '' ? path : join(home, path);
}

export function createControlSink(opts                    )              {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const stats                   = { written: 0, errors: 0, bytes: 0, rotations: 0 };

  try {
    mkdirSync(dirname(opts.path), { recursive: true });
    stats.bytes = statSync(opts.path).size;
  } catch {
    // a missing file (or directory) is the normal first-run case
    try {
      mkdirSync(dirname(opts.path), { recursive: true });
    } catch (err) {
      opts.onError?.(`cannot create ${dirname(opts.path)}: ${String(err)}`);
    }
  }

  function rotate()       {
    try {
      const target = `${opts.path}.1`;
      rmSync(target, { force: true });
      renameSync(opts.path, target);
      stats.bytes = 0;
      stats.rotations += 1;
    } catch (err) {
      opts.onError?.(`rotation failed: ${String(err)}`);
    }
  }

  return {
    path: opts.path,
    write(line        )       {
      try {
        if (stats.bytes + line.length > maxBytes) rotate();
        appendFileSync(opts.path, line, 'utf8');
        stats.written += 1;
        stats.bytes += Buffer.byteLength(line, 'utf8');
      } catch (err) {
        stats.errors += 1;
        opts.onError?.(`append failed (${stats.errors}): ${String(err)}`);
      }
    },
    stats()                   {
      return { ...stats };
    },
  };
}
