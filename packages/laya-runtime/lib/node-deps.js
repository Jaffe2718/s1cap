/**
 * Real (non-injected) dependencies for the Laya runtime: node:child_process for
 * process control, node:fs for script detection, global fetch for health checks.
 * Tests inject fakes instead, so this module stays out of the unit-test path.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

                                                               
                                                                

const execFileAsync = promisify(execFile)     
               
                 
                                                          
                                                ;

export function createNodeDiscoveryDeps()                {
  return {
    platform: process.platform,
    env: process.env                                      ,
    async run(command        , args          )                     {
      try {
        const { stdout } = await execFileAsync(command, args, {
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { code: 0, stdout: String(stdout), stderr: '' };
      } catch (err) {
        const e = err                                                                                  ;
        return {
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: String(e.stdout ?? ''),
          stderr: String(e.stderr ?? e.message ?? ''),
        };
      }
    },
  };
}

export function createNodeLaunchDeps()             {
  return {
    platform: process.platform,
    now: () => Date.now(),
    sleep: (ms        ) => new Promise      ((resolve) => setTimeout(resolve, ms)),
    fileExists: async (path        ) => existsSync(path),
    fetchImpl: fetch,
    spawn: (command, args, options) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...options.env },
        ...(options.cwd ? { cwd: options.cwd } : {}),
        windowsHide: true,
      });
      return child                             ;
    },
  };
}
