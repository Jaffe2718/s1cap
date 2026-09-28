import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEPSEEK_FLASH_PEAK,
  alignToCacheBlocks,
  breakEvenRatio,
  decideReselect,
  invalidationCost,
  perTokenCost,
  removalSaving,
} from '../src/cache-policy.ts';

const close = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol;

test('per-token cost and break-even ratio against deepseek-flash peak prices', () => {
  assert.ok(close(perTokenCost(0.75), 0.0795), 'h=0.75 -> 0.75*0.006 + 0.25*0.30');
  assert.ok(close(perTokenCost(1), 0.006));
  assert.ok(close(perTokenCost(0), 0.3));

  assert.ok(close(breakEvenRatio(0.5), 1.9215686274509804, 1e-9));
  assert.ok(close(breakEvenRatio(0.75), 3.69811320754717, 1e-9));
  assert.ok(close(breakEvenRatio(0.9), 8.305084745762712, 1e-9));
  assert.ok(close(breakEvenRatio(1), 49, 1e-9));

  // the ratio falls as the baseline hit rate falls: breaking a cold cache is cheap
  assert.ok(breakEvenRatio(0.4) < breakEvenRatio(0.75));
});

test('a late cut is cheap, an early cut is expensive', () => {
  // removing 20k tokens with 6k after them: invalidation is bounded by the small suffix
  const late = decideReselect({ removedTokens: 20_000, tokensAfterCut: 6_000, hitRate: 0.75, remainingCalls: 1 });
  assert.ok(late.adopt, `expected adopt, got net=${late.netUsd}`);
  assert.ok(close(late.requiredRatio, 3.69811320754717, 1e-9));

  // the same 20k removed early (80k after) cannot pay for itself in one call
  const early = decideReselect({ removedTokens: 20_000, tokensAfterCut: 80_000, hitRate: 0.75, remainingCalls: 1 });
  assert.equal(early.adopt, false);
  assert.ok(early.netUsd < 0);
});

test('amortization over the remaining calls flips a mid-task re-selection', () => {
  // 8k removed with 20k after: the suffix re-prefill is paid once, the saving repeats
  const one = decideReselect({ removedTokens: 8_000, tokensAfterCut: 20_000, hitRate: 0.75, remainingCalls: 1 });
  const ten = decideReselect({ removedTokens: 8_000, tokensAfterCut: 20_000, hitRate: 0.75, remainingCalls: 10 });
  assert.equal(one.adopt, false, `one call left: saving ${one.savingUsd} < invalidation ${one.invalidationUsd}`);
  assert.equal(ten.adopt, true, 'the suffix is re-prefilled once, the saving repeats every call');
  assert.ok(close(ten.requiredRatio, breakEvenRatio(0.75) / 10, 1e-12));
  assert.ok(close(ten.savingUsd, 10 * removalSaving(8_000, 0.75), 1e-12));
  assert.ok(close(ten.invalidationUsd, invalidationCost(20_000, 0.75), 1e-12));

  // 4k against a 20k suffix stays a loss even with ten calls left (ratio 0.2 < 0.37)
  const thin = decideReselect({ removedTokens: 4_000, tokensAfterCut: 20_000, hitRate: 0.75, remainingCalls: 10 });
  assert.equal(thin.adopt, false);
});

test('a higher baseline hit rate makes aggressive selection harder to justify', () => {
  const h50 = decideReselect({ removedTokens: 5_000, tokensAfterCut: 5_000, hitRate: 0.5, remainingCalls: 1 });
  const h90 = decideReselect({ removedTokens: 5_000, tokensAfterCut: 5_000, hitRate: 0.9, remainingCalls: 1 });
  assert.equal(h50.adopt, true);
  assert.equal(h90.adopt, false);
});

test('the money test and the rho* ratio test agree exactly', () => {
  const cases = [
    { removedTokens: 20_000, tokensAfterCut: 6_000, hitRate: 0.75, remainingCalls: 1 },
    { removedTokens: 8_000, tokensAfterCut: 20_000, hitRate: 0.75, remainingCalls: 10 },
    { removedTokens: 4_000, tokensAfterCut: 20_000, hitRate: 0.75, remainingCalls: 10 },
    { removedTokens: 5_000, tokensAfterCut: 5_000, hitRate: 0.9, remainingCalls: 1 },
    { removedTokens: 50_000, tokensAfterCut: 1_000, hitRate: 0.5, remainingCalls: 1 },
  ];
  for (const c of cases) {
    const d = decideReselect(c);
    assert.equal(
      d.adopt,
      d.ratio > d.requiredRatio,
      `ratio ${d.ratio.toFixed(3)} vs required ${d.requiredRatio.toFixed(3)} must match money net ${d.netUsd}`,
    );
    assert.equal(d.adopt, d.savingUsd > d.invalidationUsd);
  }
});

test('budgets align down to whole cache blocks', () => {
  assert.equal(alignToCacheBlocks(1_000, 64), 960);
  assert.equal(alignToCacheBlocks(63, 64), 0);
  assert.equal(alignToCacheBlocks(1_024, 1_024), 1_024);
  assert.equal(alignToCacheBlocks(-5, 64), 0);
  assert.equal(alignToCacheBlocks(100, 0), 100, 'degenerate block size must not divide by zero');
});

test('off-peak prices halve both sides, leaving every ratio unchanged', () => {
  const offPeak = { hitPerMTok: DEEPSEEK_FLASH_PEAK.hitPerMTok / 2, missPerMTok: DEEPSEEK_FLASH_PEAK.missPerMTok / 2 };
  assert.ok(close(breakEvenRatio(0.75, offPeak), breakEvenRatio(0.75), 1e-12));
  assert.ok(close(perTokenCost(0.75, offPeak), perTokenCost(0.75) / 2, 1e-12));
});
