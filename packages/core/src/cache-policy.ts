/**
 * Cache economics for selective context (docs/FORMULAS.md §6).
 *
 * Prefix caching matches the longest common prefix of the prompts *we actually send*, so a
 * selected (subset) context still hits — as long as the assembled prefix is stable across
 * calls. The cost question is therefore not "subset or not" but "what does one re-selection
 * invalidate, and does the saving pay for it".
 *
 * Prices are per 1M tokens; defaults are deepseek-flash peak (hit 0.006, miss 0.30), i.e. a
 * 50x ratio, off-peak is half of both and leaves every ratio below unchanged.
 */

export interface CachePrices {
  hitPerMTok: number;
  missPerMTok: number;
}

export const DEEPSEEK_FLASH_PEAK: CachePrices = { hitPerMTok: 0.006, missPerMTok: 0.3 };

/** Average price of one token when a fraction `h` of the prompt is served from cache. */
export function perTokenCost(hitRate: number, prices: CachePrices = DEEPSEEK_FLASH_PEAK): number {
  const h = clamp01(hitRate);
  return h * prices.hitPerMTok + (1 - h) * prices.missPerMTok;
}

/**
 * ρ*: tokens that must be removed to pay for invalidating one *hit* token that follows the cut
 * (docs/FORMULAS.md §6).
 */
export function breakEvenRatio(hitRate: number, prices: CachePrices = DEEPSEEK_FLASH_PEAK): number {
  const h = clamp01(hitRate);
  const delta = prices.missPerMTok - prices.hitPerMTok;
  return delta / perTokenCost(h, prices);
}

/** Everything after a cut point loses its cache discount for the hit fraction. */
export function invalidationCost(
  tokensAfterCut: number,
  hitRate: number,
  prices: CachePrices = DEEPSEEK_FLASH_PEAK,
): number {
  const h = clamp01(hitRate);
  return (tokensAfterCut * h * (prices.missPerMTok - prices.hitPerMTok)) / 1_000_000;
}

/** What removing tokens from the prompt saves on every call that no longer carries them. */
export function removalSaving(
  removedTokens: number,
  hitRate: number,
  prices: CachePrices = DEEPSEEK_FLASH_PEAK,
): number {
  return (removedTokens * perTokenCost(hitRate, prices)) / 1_000_000;
}

export interface ReselectInput {
  /** tokens the new selection drops relative to the current one */
  removedTokens: number;
  /** tokens that stay and sit *after* the earliest cut — they are re-prefilled once */
  tokensAfterCut: number;
  /** measured cache hit rate before the change */
  hitRate: number;
  /**
   * calls left in the task. The invalidation is paid once (the new prefix is cached again),
   * the saving accrues on every remaining call — this is what makes mid-task re-selection
   * viable at all.
   */
  remainingCalls: number;
  prices?: CachePrices;
}

export interface ReselectDecision {
  adopt: boolean;
  savingUsd: number;
  invalidationUsd: number;
  netUsd: number;
  /** removed tokens per invalidated *hit* token — the same unit as rho* */
  ratio: number;
  /** rho* divided by the calls that benefit; adopt when ratio > requiredRatio */
  requiredRatio: number;
}

/**
 * Positional + amortized break-even: adopt a mid-task re-selection only when the tokens it
 * removes, multiplied by the calls that benefit, outweigh re-prefilling the suffix once.
 *
 * Both readings of the test are computed and they agree exactly:
 * money (`savingUsd > invalidationUsd`) and the rho* ratio (`ratio > requiredRatio`).
 */
export function decideReselect(input: ReselectInput): ReselectDecision {
  const prices = input.prices ?? DEEPSEEK_FLASH_PEAK;
  const calls = Math.max(1, input.remainingCalls);
  const savingUsd = calls * removalSaving(input.removedTokens, input.hitRate, prices);
  const invalidationUsd = invalidationCost(input.tokensAfterCut, input.hitRate, prices);
  const invalidatedHitTokens = input.tokensAfterCut * clamp01(input.hitRate);
  const ratio = invalidatedHitTokens > 0 ? input.removedTokens / invalidatedHitTokens : Number.POSITIVE_INFINITY;
  const requiredRatio = breakEvenRatio(input.hitRate, prices) / calls;
  return {
    adopt: savingUsd > invalidationUsd,
    savingUsd,
    invalidationUsd,
    netUsd: savingUsd - invalidationUsd,
    ratio,
    requiredRatio,
  };
}

/**
 * Prefix caches match whole blocks (DeepSeek 64 tokens, OpenAI 128, Anthropic counts in
 * 1024-token cache checkpoints). Rounding a token budget down to whole blocks avoids paying
 * a miss on a partially changed block.
 */
export function alignToCacheBlocks(tokens: number, blockTokens = 64): number {
  const block = Math.max(1, Math.floor(blockTokens));
  return Math.max(0, Math.floor(tokens / block) * block);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
