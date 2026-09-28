/**
 * dsh-s1cap — plugin skeleton (M0).
 *
 * Hook map verified against the local DSH install and the community plugin
 * `dsh-command-context-trim` (docs/AGENT_BRIEF.md §1.5):
 *
 *   - `agent/pre-step`        run ASSEMBLER before each LLM call; emit model-only
 *                             surface ops (`surfaceOp: {op:'replace'}`) — the
 *                             user-facing transcript stays strictly chronological
 *   - message-append events   SEGMENTER + tier-1 RECALL, incrementally
 *   - `ctx.tokenMeter`        budget + fixed overhead accounting
 *   - `agent/request-error`   prepend listener: degrade to tier-0 + recency window
 *                             instead of failing the session
 *   - commands                /s1 status | config | graph | why <seq>
 *
 * M1 wires these; M0 freezes the config surface (§ cordis.patch.yml) and the hook map.
 */
import type { AssemblyPolicy } from '@s1cap/core';
import { defaultPolicy } from '@s1cap/core';

export interface S1CapPluginConfig extends AssemblyPolicy {
  telemetry?: { jsonl?: string };
}

/** Minimal structural shape of the Cordis plugin context we rely on (M1 fills the types). */
export interface PluginContext {
  on(event: string, handler: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): void;
  command?(spec: { name: string; description: string; run: (...args: unknown[]) => unknown }): void;
  tokenMeter?: { total(): number; fixedOverhead(): number };
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export const name = 'dsh-s1cap';

/** Cordis resolves config through schemastery in production; skeleton keeps the raw shape. */
export function resolveConfig(raw: Partial<S1CapPluginConfig> | undefined): S1CapPluginConfig {
  const base = defaultPolicy();
  return { ...base, ...(raw ?? {}) } as S1CapPluginConfig;
}

export function apply(ctx: PluginContext, raw?: Partial<S1CapPluginConfig>): void {
  const config = resolveConfig(raw);
  ctx.logger?.info(`[s1cap] cell=${config.cell} tas=${String(config.tas.on)} tier1=${config.recall.tier1} planGate=${String(config.planGate.on)} s1=${config.s1.provider}`);

  ctx.on('agent/pre-step', () => {
    // M1: assemble(input) from @s1cap/core and emit surface replace ops.
    return undefined;
  });

  ctx.on('agent/request-error', () => {
    // M1: degradation path — tier-0 metadata + recency window, then request a retry.
    return undefined;
  });

  ctx.command?.({
    name: 's1',
    description: 'S1CAP: status | config | graph | why <seq>',
    run: () => {
      ctx.logger?.info(`[s1cap] ${JSON.stringify({ cell: config.cell, policy: config }, null, 2)}`);
      return undefined;
    },
  });
}
