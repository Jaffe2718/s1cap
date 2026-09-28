/**
 * Real (non-injected) dependencies for the Laya runtime: node:child_process for
 * process control, node:fs for script detection, global fetch for health checks.
 * Tests inject fakes instead, so this module stays out of the unit-test path.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { DiscoveryDeps, RunResult } from './discovery.ts';
import type { LaunchDeps, SpawnedProcess } from './launcher.ts';

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options?: { windowsHide?: boolean; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export function createNodeDiscoveryDeps(): DiscoveryDeps {
  return {
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    async run(command: string, args: string[]): Promise<RunResult> {
      try {
        const { stdout } = await execFileAsync(command, args, {
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { code: 0, stdout: String(stdout), stderr: '' };
      } catch (err) {
        const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        return {
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: String(e.stdout ?? ''),
          stderr: String(e.stderr ?? e.message ?? ''),
        };
      }
    },
  };
}

export function createNodeLaunchDeps(): LaunchDeps {
  return {
    platform: process.platform,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    fileExists: async (path: string) => existsSync(path),
    fetchImpl: fetch,
    spawn: (command, args, options) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...options.env },
        ...(options.cwd ? { cwd: options.cwd } : {}),
        windowsHide: true,
      });
      return child as unknown as SpawnedProcess;
    },
  };
}
