#!/usr/bin/env node
/**
 * The registered analysis protocol of `docs/FORMULAS.md` §8, and nothing beyond it.
 *
 * `FORMULAS.md` §8 registers three procedures over per-task, per-arm results:
 *
 *   - the primary metric (completion rate, non-inferiority): **McNemar**, exact for small discordant
 *     counts, with the asymptotic form only when the discordant pairs justify it;
 *   - the secondary metrics (cost/time): **paired bootstrap**, B = 10^4 task resamples, seeded, the paired
 *     difference and a percentile confidence interval reported with the seed and B beside them;
 *   - the multiple-comparison correction: **Holm step-down** across the pre-registered family, applied to
 *     the p-values as a family whose membership is printed and not implied.
 *
 * Nothing in this repository computed any of the three before this file existed: a grep for
 * `McNemar|bootstrap|Holm` across `scripts/*.mjs`, `packages/*∕src/*.ts` and `docs/*.md` returned
 * documentation and no code (`.s1cap-ablation/s1cap-audit-lane.md` finding F7; `DEFECT-GATE.md` item F7).
 *
 * ## The pairing rule, which is the part that is easy to get wrong
 *
 * The paired unit is the **task**, and the pairing is enforced rather than assumed: two arms are compared
 * only over task keys both arms ran, the input is refused if any declared arm is missing a task another arm
 * has (or if a task declares one arm twice — a repeated task is a different observation, and it must be
 * given a distinct key), and the number of pairs used is printed. `--allow-drop` narrows the comparison to
 * the keys all arms share and prints exactly which keys were dropped. Nothing is ever dropped silently.
 *
 * ## The honest refusal
 *
 * The optimization loop of `AGENT_BRIEF.md` §9.7 draws **one** task at a time. One task gives the bootstrap
 * nothing to resample and the test no power, so both statistics are meaningless there — a bootstrap over one
 * observation returns a zero-width interval around that observation, which reads exactly like a tight
 * estimate. This tool therefore refuses to produce a claim below a minimum number of paired tasks, and it
 * distinguishes three outcomes: `ok` (a usable result), `refused: insufficient-pairing` and
 * `refused: insufficient-n`.
 *
 * The registered plan does **not** fix that minimum. `FORMULAS.md` §8 states the test, the margin, B and α
 * and no per-arm n; `AGENT_BRIEF.md` §9.1 states the *grid's* per-arm n (SWE-bench Verified 100,
 * Terminal-Bench 66, tau2 full base split) and §9.3 defers the power analysis to `bench/stats` with a
 * `[VERIFY]`; §9.6 prices ~446 episodes per arm. So the minimum is implemented as an **explicit parameter**
 * (`--min-n`, recorded in every output) with a documented default rather than as an invisible constant:
 *
 *   - **default 20** — the smallest round number at which this tool will emit inferential numbers rather
 *     than a refusal. It is a *floor on computability and elementary resolution*, not a power guarantee.
 *   - **6 is the smallest n at which the exact test can reach α = 0.05 at all** — the exact two-sided
 *     p-value is 2·2^-(b+c), so b+c ≥ 6 is required for p ≤ 0.05 even with every discordant pair on one
 *     side. Below that the primary test cannot reject at the registered α whatever the data says.
 *   - **what the grid's own effect size needs is not a single number, and the tool does not pretend it is.**
 *     `AGENT_BRIEF.md` §9.3's power note quotes 14-15 pp at n = 100 for SWE-V and 18 pp at n = 66 for TB,
 *     and defers the analysis itself to `bench/stats` as a `[VERIFY]`. The sign test runs on *discordant*
 *     pairs, so the resolvable difference is (z_{1-α/2} + z_{1-β})/√(b+c): 2.80/√100 = 28 pp if every one
 *     of 100 tasks were discordant, and 56 pp at a 25 % discordance, while matching the note's 14-15 pp at
 *     n = 100 needs 373 discordant pairs — more than that arm has tasks. Every `ok` output therefore prints
 *     the discordant count it observed and the sensitivity that count buys, so the gap between the note and
 *     the data is visible in the output instead of being averaged into a number nobody can check.
 *
 * ## Reproducibility
 *
 * Every number this tool prints is derivable from its own output: the task keys and their per-arm values
 * appear in the output, the seed and B appear in the output, and the bootstrap uses a seeded 32-bit
 * mulberry32 generator drawn in a fixed order. Re-running with the same `--seed` reproduces the interval
 * bit for bit; `--self-test` asserts that.
 *
 * Usage:
 *   node scripts/paired-stats.mjs --input <results.json> [--seed 20261002] [--b 10000] [--min-n 20]
 *   node scripts/paired-stats.mjs --self-test
 *
 * `--input` reads the result set described below; `--baseline`, `--primary`, `--family`, `--metric`,
 * `--b`, `--seed`, `--min-n`, `--alpha`, `--margin` and `--allow-drop` override it. `--json` prints the
 * machine-readable result instead of the report.
 *
 * Input JSON (the recipe that builds it is a later change; this file fixes the shape):
 *
 *   {
 *     "baseline": "C0",
 *     "arms": ["C0", "C1", "C2"],
 *     "primary": { "metric": "solved", "margin": 0.02 },
 *     "metrics": {
 *       "solved": { "kind": "binary",     "higherIsBetter": true },
 *       "cost":   { "kind": "continuous", "higherIsBetter": false, "minRelImprovement": 0.10 },
 *       "timeMs": { "kind": "continuous", "higherIsBetter": false, "minRelImprovement": 0.10 },
 *       "steps":  { "kind": "continuous", "higherIsBetter": false, "minRelImprovement": 0.10 }
 *     },
 *     "family": ["cost", "timeMs", "steps"],
 *     "tasks": {
 *       "swe-1001": {
 *         "taskId": "swe-1001",
 *         "C0": { "solved": 0, "cost": 1.42, "timeMs": 812000, "steps": 41 },
 *         "C1": { "solved": 0, "cost": 1.39, "timeMs": 795000, "steps": 40 },
 *         "C2": { "solved": 1, "cost": 1.17, "timeMs": 664000, "steps": 33 }
 *       }
 *     }
 *   }
 *
 * The `tasks` map key is the **pairing key** — the identity the tool pairs on. Its rows are nested by arm
 * (`tasks[key][arm]`) rather than given as a flat list of `{arm, …}` rows, because a flat list lets the two
 * arms of one task land under two different keys, and the result is two unpaired means that nothing in the
 * output reveals as unpaired. `taskId` carries the task's own identity (the benchmark instance) and is
 * required; when the grid adds repeats, the repeat belongs in the pairing key (`"swe-1001#r2"`), not beside
 * it, because a restart is a second draw and would otherwise collapse into an average. Every declared metric
 * must be present, finite and of the declared kind for every arm of every key: missing is a violation, never
 * a zero. The declared `arms` need not all appear — an arm that ran nothing is caught by the pairing check.
 *
 * What this tool does **not** implement, stated rather than approximated:
 *   - non-inferiority is tested by `margin = 0` (the registered rule as §8 writes it) or by the asymptotic
 *     shifted statistic when a margin is set. No exact finite-sample non-inferiority interval is computed,
 *     because the exact route for it is an inversion of the binomial test on b/(b+c) and §8 does not
 *     register that route. `--margin` therefore reports the test it used, and with `--exact` plus a nonzero
 *     margin it refuses instead of quietly substituting one.
 *   - the report layer (`cell-report.mjs` and its CSV) does not emit per-task rows, so this tool cannot read
 *     a finished round yet; it reads the result set above. Wiring the CSV to it is a change in a file
 *     another agent owns and is reported, not made.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// 1. Deterministic numerics: seeded PRNG, quantiles, normal tail, log-gamma
// ---------------------------------------------------------------------------------------------

/**
 * mulberry32 — a 32-bit seeded PRNG, chosen because it is three lines of integer arithmetic with no
 * dependency and no floating-point state, so the sequence is identical on every platform and the
 * "reproducible from the output's seed" claim is testable rather than plausible.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Type-7 quantile (the R default): h = (n-1)p, linear interpolation between the neighbours. Stated
 * explicitly because "the 95 % percentile interval" is three different intervals under three conventions
 * and a reader reproducing this number needs to know which one produced it.
 */
function quantile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(x) by the Lanczos approximation (g = 7, n = 9); used only through `binomPmf`. */
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i += 1) a += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** C(n, k) via log-gamma: exact to double precision for the n this test ever sees, and no factorial overflow. */
function binomPmf(n, k) {
  if (k < 0 || k > n) return 0;
  return Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1));
}

/**
 * Two-sided standard-normal tail: p = 2Φ(-|z|) = erfc(|z|/√2). `erfc` is the Numerical Recipes
 * rational (Chebyshev) fit — accurate to ~1e-7 over the range this file uses, no dependency, and
 * the residual far tail (p < 1e-7) is reported as 0 rather than as a false precision.
 */
function normalTwoSidedP(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const tau =
    t *
    Math.exp(
      -x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
        t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
        t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return Math.min(1, Math.max(0, tau));
}

// ---------------------------------------------------------------------------------------------
// 2. McNemar (FORMULAS.md §8, primary metric)
// ---------------------------------------------------------------------------------------------

/** Discordant pairs of a paired binary vector: `b` = first arm solved where the second did not, `c` = the converse. */
export function discordantPairs(a, b) {
  let n01 = 0;
  let n10 = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === 1 && b[i] === 0) n10 += 1;
    else if (a[i] === 0 && b[i] === 1) n01 += 1;
  }
  return { b: n10, c: n01 };
}

/**
 * The exact one-sided McNemar p-value, as `FORMULAS.md` §8 registers it:
 *
 *     p = min(1, Σ_{i=0}^{min(b,c)} C(b+c, i) 2^-(b+c))
 *
 * which is P(X ≤ min(b,c)) for X ~ Binomial(b+c, 0.5) — the conditional sign test of the discordant pairs
 * under H0: p_b = p_c. It is exact for every b+c, and it is the registered statistic.
 */
export function mcnemarExactOneSided(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  let sum = 0;
  const k = Math.min(b, c);
  for (let i = 0; i <= k; i += 1) sum += binomPmf(n, i);
  return Math.min(1, sum * Math.pow(2, -n));
}

/**
 * The asymptotic two-sided McNemar with Edwards' continuity correction:
 *
 *     χ² = (|b - c| - 1)² / (b + c),   p = P(χ²₁ ≥ χ²) = 2Φ(-√χ²)
 *
 * The correction matters here rather than being decoration: b+c in a paired ablation is small, and the
 * uncorrected statistic inflates p at exactly those sizes.
 */
export function mcnemarAsymptoticTwoSided(b, c, { correction = true } = {}) {
  const n = b + c;
  if (n === 0) return 1;
  const raw = Math.abs(b - c) - (correction ? 1 : 0);
  const chi2 = (raw <= 0 ? 0 : raw * raw) / n;
  return normalTwoSidedP(Math.sqrt(chi2));
}

/**
 * The asymptotic one-sided variant for a **non-inferiority** margin δ, which is the form `AGENT_BRIEF.md`
 * §9.3 and §8's `Δ̂_solve ≥ -δ` need. With the sign test's null standard error SE = √(b+c)/(b+c) = 1/√(b+c):
 *
 *     Δ̂ = (b - c) / (b + c),   z = (Δ̂ + δ)/SE = (Δ̂ + δ)·√(b+c),   p = 1 - Φ(z) = Φ(-z)
 *
 * This is a *shifted* test, not an interval inversion; the header says so and `--exact` refuses to combine
 * itself with a nonzero margin rather than pretending the exact route covers it.
 */
export function mcnemarAsymptoticOneSidedMargin(b, c, margin) {
  const n = b + c;
  if (n === 0) return 1;
  const delta = (b - c) / n;
  const z = (delta + margin) * Math.sqrt(n);
  return Math.min(1, Math.max(0, normalTwoSidedP(z) / 2));
}

/**
 * When the asymptotic form is adequate, stated once and printed.
 *
 * Selvin's rule of thumb for the continuity-corrected McNemar: b+c ≥ 25 **and** min(b,c) ≥ 5. Below either,
 * the exact form is used. `--method exact` is the registered default and the exact form is correct at every
 * n — this rule decides what `--method auto` does, and it is also what the output reports as the reason the
 * asymptotic form would or would not have been justified.
 */
export function asymptoticJustified(b, c) {
  return b + c >= 25 && Math.min(b, c) >= 5;
}

/**
 * Φ⁻¹(p), the standard-normal quantile — the Acklam rational approximation, whose absolute error is below
 * 1.15e-9 over (0,1). It is here so that `mde()` can be asked about any α rather than only the one whose
 * constant somebody hard-coded, which is the difference between a parameter and a decoration.
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new InputError(`normalQuantile needs p in (0,1), got ${JSON.stringify(p)}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  const hi = 1 - lo;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > hi) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * The minimum detectable difference in solve rate, by the standard normal approximation to the sign test
 * (α two-sided, power 1-β).
 *
 * The statistic is Z = (b - c)/√(b+c), which has SE 1 under H0, and E[b - c] = n_d·Δ where **n_d = b + c is
 * the number of *discordant* pairs**, not the number of tasks. So the honest form is
 *
 *     Δ_nde = (z_{1-α/2} + z_{1-β}) / √n_d        with n_d the discordant count actually observed
 *
 * and that is what `mdeDiscordant` returns. `mde(n)` is the same expression with n_d = n, i.e. the limiting
 * case in which every task is discordant — it is the most optimistic reading possible, and it is the one to
 * quote only when it is labelled as such.
 *
 * The distinction is not pedantic. At n = 100 tasks with 25 % of them discordant, Δ_nde = 2.80/√25 ≈ 56 pp;
 * with the 14-15 pp that `AGENT_BRIEF.md` §9.3's power note quotes for that arm, the implied discordant count
 * is n_d = (2.80/0.145)² ≈ 373 — more discordant pairs than the arm has tasks. So the brief's figure presumes
 * a discordance this tool can measure and the note does not state, which is exactly why the count is printed
 * beside the estimate instead of being assumed.
 */
export function mde(n, { alpha = 0.05, power = 0.8 } = {}) {
  if (!(n > 0)) return NaN;
  if (!(power > 0.5 && power < 1)) throw new InputError(`mde power must lie in (0.5,1), got ${JSON.stringify(power)}`);
  return (normalQuantile(1 - alpha / 2) + normalQuantile(power)) / Math.sqrt(n);
}

/**
 * The same approximation at the discordant count, with the boundary a reader would otherwise misread made
 * explicit: a "detectable difference" larger than the whole scale (1.0 = 100 pp of solve rate) is not a
 * sensitivity, it is the statement that nothing is resolvable at this many discordant pairs. At b+c = 1 the
 * expression returns 2.80; printing "280 %" invites a reader to take it for a quantity.
 */
function mdeAtDiscordant(discordant, { alpha = 0.05, totalPairs = null } = {}) {
  const d = discordant > 0 ? mde(discordant, { alpha }) : Infinity;
  const n = totalPairs === null ? discordant : totalPairs;
  return {
    discordant,
    difference: d,
    resolvable: Number.isFinite(d) && d <= 1,
    text: discordant === 0
      ? 'no discordant pair at all, so the completion comparison carries no information either way'
      : d <= 1
        ? `+/-${(d * 100).toFixed(1)} pp of solve rate at the ${discordant} discordant pair(s) observed (of ${n}; normal approximation, 80% power)`
        : `nothing resolvable: with ${discordant} discordant pair(s) of ${n} the approximation returns ${(d * 100).toFixed(0)} pp, past the whole 0-100 pp scale`,
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Paired bootstrap (FORMULAS.md §8, secondary metrics)
// ---------------------------------------------------------------------------------------------

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * The paired bootstrap of `FORMULAS.md` §8: resample **tasks** (indices 0..n-1), not arms and not
 * observations within a task, so the resampled units keep their within-task pairing:
 *
 *     for j = 1..B:  i*_j = n draws with replacement from {0..n-1}
 *                    Δ*_j = mean(x[i*_j]) - mean(y[i*_j])
 *     CI_95 = [Q_{0.025}(Δ*), Q_{0.975}(Δ*)]        (percentile interval, type-7 quantile)
 *
 * `pOneSided` and `pTwoSided` are the achieved levels read off the resample distribution,
 * p_two = 2·min(P(Δ* ≤ 0), P(Δ* ≥ 0)) capped at 1. They are the companion to the interval — the smallest α
 * at which the percentile interval would separate from 0 — and they are *not* a §8 quantity: the registered
 * criterion is the interval against the −10 % line, and the p-value exists only so Holm has a number to
 * order. That is stated here because it is the one place this tool goes past the letter of §8.
 */
export function pairedBootstrap(x, y, { B = 10000, seed = 20261002 } = {}) {
  const n = x.length;
  if (n !== y.length) throw new Error(`paired bootstrap got ${n} and ${y.length} values — the arms are not paired`);
  if (n === 0) throw new Error('paired bootstrap got no pairs');
  const d = new Array(n);
  for (let i = 0; i < n; i += 1) d[i] = x[i] - y[i];
  const rnd = mulberry32(seed);
  const draws = new Float64Array(B);
  for (let j = 0; j < B; j += 1) {
    let s = 0;
    for (let k = 0; k < n; k += 1) s += d[Math.floor(rnd() * n)];
    draws[j] = s / n;
  }
  const sorted = Float64Array.from(draws).sort();
  let le = 0;
  let ge = 0;
  for (let j = 0; j < B; j += 1) {
    if (draws[j] <= 0) le += 1;
    if (draws[j] >= 0) ge += 1;
  }
  const pTwoSided = Math.min(1, 2 * Math.min(le / B, ge / B));
  return {
    n,
    B,
    seed,
    meanDiff: mean(d),
    medianDiff: quantile(Array.from(d).sort((a, b) => a - b), 0.5),
    ciLow: quantile(sorted, 0.025),
    ciHigh: quantile(sorted, 0.975),
    pOneSided: Math.min(1, le / B),
    pTwoSided,
  };
}

// ---------------------------------------------------------------------------------------------
// 4. Holm step-down (FORMULAS.md §8, the family)
// ---------------------------------------------------------------------------------------------

/**
 * Holm step-down over a family of K p-values, exactly as `FORMULAS.md` §8 writes it:
 *
 *     p⁽ⁱ⁾_adj = max_{j ≤ i} { min(1, (K - j + 1)·p_(j)) }
 *
 * with `p_(1) ≤ … ≤ p_(K)` the sorted p-values. Two details are load-bearing and both are easy to get wrong:
 *
 *   - the running maximum (`max_{j ≤ i}`) is what makes the adjusted sequence monotone. Without it a later,
 *     larger p-value comes out smaller than an earlier one and the family reads as rejected where it was not.
 *   - the *decision* is the step-down walk — reject while the adjusted value stays at or below α, then stop
 *     and reject nothing further. It is deliberately not `adjusted ≤ α` read off the vector: at tied
 *     adjusted values the two differ, and the walk is the conservative reading (a family of K = 2 rejecting
 *     at 0.04/0.05 becomes [0.08, 0.08] and rejects neither, where the vector comparison would reject both).
 *
 * Returns the adjusted values in the caller's original order, each with its rank and its decision.
 */
export function holm(pvalues, alpha = 0.05) {
  const K = pvalues.length;
  const order = pvalues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array(K);
  let running = 0;
  let rejecting = true;
  for (let j = 0; j < K; j += 1) {
    const rank = j + 1;
    const adj = Math.min(1, (K - rank + 1) * order[j].p);
    running = Math.max(running, adj);
    const reject = rejecting && running <= alpha;
    if (!reject) rejecting = false;
    out[order[j].i] = { p: order[j].p, rank, adjusted: running, reject };
  }
  return { K, alpha, entries: out };
}

// ---------------------------------------------------------------------------------------------
// 5. Input validation and pairing
// ---------------------------------------------------------------------------------------------

class InputError extends Error {
  constructor(message) {
    super(message);
    this.isInputError = true;
  }
}

function requireObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError(`${what} must be an object`);
  }
  return value;
}

function finiteNumber(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(`${what} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validates the result set and resolves the pairing key set. Nothing here drops a row: a violation is an
 * InputError, which the CLI turns into exit code 1 — distinct from a *statistical* refusal (exit 2), because
 * "the file is wrong" and "the data cannot support a claim" are different messages to the caller.
 */
export function validateInput(raw) {
  const spec = requireObject(raw, 'the input');
  if (!Array.isArray(spec.arms)) throw new InputError('`arms` must be an array of arm names');
  for (const a of spec.arms) {
    if (typeof a !== 'string' || a === '') throw new InputError(`every entry of \`arms\` must be a non-empty string, got ${JSON.stringify(a)}`);
  }
  const arms = [...spec.arms];
  if (arms.length < 2) throw new InputError('`arms` must list at least two arms');
  if (new Set(arms).size !== arms.length) throw new InputError('`arms` contains a duplicate');
  const baseline = spec.baseline;
  if (typeof baseline !== 'string') throw new InputError('`baseline` must name an arm');
  if (!arms.includes(baseline)) throw new InputError(`baseline ${JSON.stringify(baseline)} is not in arms ${JSON.stringify(arms)}`);

  const metrics = requireObject(spec.metrics, '`metrics`');
  const names = Object.keys(metrics);
  if (names.length === 0) throw new InputError('`metrics` declares no metric');
  for (const name of names) {
    const m = requireObject(metrics[name], `metrics.${name}`);
    if (m.kind !== 'binary' && m.kind !== 'continuous') {
      throw new InputError(`metrics.${name}.kind must be "binary" or "continuous", got ${JSON.stringify(m.kind)}`);
    }
    if (m.minRelImprovement !== undefined) finiteNumber(m.minRelImprovement, `metrics.${name}.minRelImprovement`);
  }

  const primary = requireObject(spec.primary, '`primary`');
  if (typeof primary.metric !== 'string') throw new InputError('`primary.metric` must name a metric');
  if (!names.includes(primary.metric)) throw new InputError(`primary.metric ${JSON.stringify(primary.metric)} is not declared in metrics`);
  if (metrics[primary.metric].kind !== 'binary') {
    throw new InputError(`primary.metric ${JSON.stringify(primary.metric)} is kind "${metrics[primary.metric].kind}"; §8's primary metric is binary (solved / not solved)`);
  }
  const margin = primary.margin === undefined ? 0 : finiteNumber(primary.margin, 'primary.margin');
  if (margin < 0) throw new InputError('primary.margin must be >= 0 (it is the non-inferiority slack, `Δ ≥ -δ`)');

  const family = spec.family === undefined ? names.filter((n) => n !== primary.metric && metrics[n].kind === 'continuous') : spec.family;
  if (!Array.isArray(family)) throw new InputError('`family` must be an array of metric names');
  const seen = new Set();
  for (const name of family) {
    if (typeof name !== 'string') throw new InputError('every entry of `family` must be a metric name');
    if (seen.has(name)) throw new InputError(`family lists ${JSON.stringify(name)} twice — the family is a set of distinct comparisons`);
    seen.add(name);
    if (!names.includes(name)) throw new InputError(`family names ${JSON.stringify(name)}, which is not declared in metrics`);
    if (metrics[name].kind !== 'continuous') throw new InputError(`family names ${JSON.stringify(name)}, which is kind "${metrics[name].kind}"; §8's secondary family is continuous`);
  }

  // The pairing table. One row per (task key, arm), nested as `tasks[key][arm]` so the two arms of a pair
  // cannot end up under two different keys — the failure mode that turns a paired test into two unpaired
  // means without anything looking wrong. `row.taskKey` is optional and defaults to the map key.
  const tasksRaw = requireObject(spec.tasks, '`tasks`');
  const rows = [];
  for (const [key, entryRaw] of Object.entries(tasksRaw)) {
    const entry = requireObject(entryRaw, `tasks[${JSON.stringify(key)}]`);
    if (typeof entry.taskId !== 'string' || entry.taskId === '') {
      throw new InputError(`tasks[${JSON.stringify(key)}].taskId must be the task's identity, and the pairing key ${JSON.stringify(key)} is the key it is paired on`);
    }
    for (const arm of Object.keys(entry)) {
      if (arm === 'taskId' || arm === 'note') continue;
      if (!arms.includes(arm)) {
        throw new InputError(
          `tasks[${JSON.stringify(key)}] carries a row for ${JSON.stringify(arm)}, which is not in arms ${JSON.stringify(arms)}` +
          ' (taskId and note are the only non-arm keys)',
        );
      }
      rows.push({ key, taskId: entry.taskId, arm, row: requireObject(entry[arm], `tasks[${JSON.stringify(key)}].${arm}`) });
    }
  }
  if (rows.length === 0) throw new InputError('`tasks` declares no (task, arm) row');

  const byKey = new Map();
  for (const r of rows) {
    let entry = byKey.get(r.key);
    if (entry === undefined) {
      entry = new Map();
      byKey.set(r.key, entry);
    }
    if (entry.has(r.arm)) throw new InputError(`tasks[${JSON.stringify(r.key)}] carries ${JSON.stringify(r.arm)} twice`);
    entry.set(r.arm, r);
  }

  return { arms, baseline, metrics, primary: { metric: primary.metric, margin }, family, rows, byKey };
}

/**
 * The pairing check. Returns the shared key set plus, per arm, the keys it has that the shared set lacks.
 * The caller decides between refusing and (`--allow-drop`) narrowing — and either way the counts are printed.
 */
export function pairing({ arms, byKey }) {
  const keys = [...byKey.keys()];
  const shared = keys.filter((k) => arms.every((arm) => byKey.get(k).has(arm)));
  const perArm = {};
  const missing = {};
  for (const arm of arms) {
    const has = keys.filter((k) => byKey.get(k).has(arm));
    perArm[arm] = has.length;
    missing[arm] = keys.filter((k) => !byKey.get(k).has(arm));
  }
  return { keys, shared, missing, perArm, dropped: keys.filter((k) => !shared.includes(k)) };
}

// ---------------------------------------------------------------------------------------------
// 6. The analysis
// ---------------------------------------------------------------------------------------------

function descriptive(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    mean: mean(values),
    median: quantile(sorted, 0.5),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * The whole analysis, as a pure function of the parsed input and its options — so `--self-test` and any
 * future test file assert the same code path the CLI runs, instead of a re-implementation of it.
 *
 * `status` is one of `ok`, `refused: insufficient-pairing`, `refused: insufficient-n`. On a refusal the
 * inferential fields are absent rather than zero: no p-value, no interval, no decision. That absence is the
 * point — a degenerate interval around one observation is indistinguishable in a table from a precise one.
 */
export function analyze(spec, options = {}) {
  const {
    B = 10000,
    seed = 20261002,
    minN = 20,
    alpha = 0.05,
    allowDrop = false,
    method = 'exact',
  } = options;
  if (!Number.isInteger(B) || B < 1) throw new InputError(`--b must be a positive integer, got ${JSON.stringify(B)}`);
  if (!Number.isInteger(minN) || minN < 1) {
    throw new InputError(
      `--min-n must be a positive integer, got ${JSON.stringify(minN)}. 1 is accepted so a caller can see the degenerate ` +
      'result deliberately; the default is 20 and the header says why',
    );
  }
  if (!(alpha > 0 && alpha < 1)) throw new InputError(`--alpha must lie in (0,1), got ${JSON.stringify(alpha)}`);
  if (method !== 'exact' && method !== 'asymptotic' && method !== 'auto') {
    throw new InputError(`--method must be exact, asymptotic or auto, got ${JSON.stringify(method)}`);
  }

  const { arms, baseline, metrics, primary, family } = spec;
  const treatmentArms = arms.filter((a) => a !== baseline);
  const pair = pairing(spec);

  const out = {
    tool: 'paired-stats',
    protocol: 'docs/FORMULAS.md §8',
    status: 'ok',
    statusLine: '',
    refusal: null,
    refusals: [],
    inputs: { B, seed, minN, alpha, allowDrop, method },
    pairing: {
      arms,
      baseline,
      treatmentArms,
      primaryMetric: primary.metric,
      margin: primary.margin,
      family: { metrics: family, K: family.length },
      taskKeys: pair.keys.length,
      sharedTaskKeys: pair.shared.length,
      pairsUsed: null,
      rowsPerArm: pair.perArm,
      keysMissingPerArm: pair.missing,
      droppedKeys: allowDrop ? pair.dropped : [],
      droppedKeysJson: pair.dropped,
    },
    comparisons: [],
    holm: null,
    verdict: null,
  };

  // --- refusal 1: the pairing itself ---
  if (pair.shared.length !== pair.keys.length && !allowDrop) {
    const detail = pair.dropped
      .map((k) => {
        const has = arms.filter((arm) => spec.byKey.get(k).has(arm));
        const missingArms = arms.filter((a) => !has.includes(a));
        const id = spec.byKey.get(k).values().next().value?.taskId;
        return `${k}${id && id !== k ? ` [task ${id}]` : ''} (has ${has.join(', ')}; missing ${missingArms.join(', ')})`;
      })
      .slice(0, 12);
    out.status = 'refused: insufficient-pairing';
    out.refusal = 'insufficient-pairing';
    out.refusals.push({
      kind: 'insufficient-pairing',
      what: `${pair.dropped.length} of ${pair.keys.length} task keys are not run by every arm`,
      why: 'the paired unit is the task; comparing arms over different tasks is not a paired comparison',
      needs: `${arms.join(', ')} each run on the same task keys`,
      refusal_detail: detail,
      remedy: 'run the missing arm(s) on those tasks, or pass --allow-drop to narrow the comparison to the shared keys (the tool then prints which keys it dropped)',
    });
  }

  if (out.status === 'ok') {
    const cellOf = (key, arm) => spec.byKey.get(key).get(arm).row;
    const valuesFor = (metric, key, arm) => {
      const v = cellOf(key, arm)[metric];
      if (v === undefined) return { missing: true };
      const n = finiteNumber(v, `tasks["${key}"].${metric} for arm ${JSON.stringify(arm)}`);
      if (metrics[metric].kind === 'binary') {
        if (n !== 0 && n !== 1) throw new InputError(`tasks["${key}"].${metric} is binary and must be 0 or 1, got ${n}`);
        return { value: n };
      }
      return { value: n };
    };

    // Metric-level completeness. A metric missing on a shared key is a violation of that metric's pairing,
    // and it is found here rather than by `undefined` arithmetic producing a NaN three layers down.
    const usable = {};
    for (const metric of [primary.metric, ...family]) {
      const kept = [];
      const droppedForMetric = [];
      for (const key of pair.shared) {
        const bad = arms
          .map((arm) => ({ arm, r: valuesFor(metric, key, arm) }))
          .filter(({ r }) => r.missing);
        if (bad.length === 0) kept.push(key);
        else droppedForMetric.push({ key, missingFor: bad.map((x) => x.arm) });
      }
      usable[metric] = { kept, dropped: droppedForMetric };
      if (droppedForMetric.length > 0) {
        const first = droppedForMetric
          .slice(0, 8)
          .map((d) => `${d.key} (no ${metric} for ${d.missingFor.join(', ')})`);
        const entry = {
          kind: 'insufficient-pairing',
          what: `metric ${JSON.stringify(metric)} is missing on ${droppedForMetric.length} of ${pair.shared.length} shared task keys (${first.join('; ')})`,
          why: 'paired statistics need the same tasks in every arm; a missing value is not a zero',
          needs: `${metric} recorded for ${arms.join(', ')} on the same task keys`,
          refusal_detail: first,
          remedy: 'record the metric for every arm on every task, or pass --allow-drop to analyse this metric on the keys that do have it (the tool then prints which keys it dropped)',
        };
        if (!allowDrop) {
          out.status = 'refused: insufficient-pairing';
          out.refusal = 'insufficient-pairing';
          out.refusals.push(entry);
        } else {
          out.refusals.push({ ...entry, note: 'analysed on the keys that carry it (--allow-drop); the dropped keys are listed' });
        }
      }
    }

    if (out.status === 'ok') {
      // --- refusal 2: n ---
      const tooSmall = [primary.metric, ...family].filter((m) => usable[m].kept.length < minN);
      if (tooSmall.length > 0) {
        out.status = 'refused: insufficient-n';
        out.refusal = 'insufficient-n';
        out.refusals.push({
          kind: 'insufficient-n',
          what: tooSmall
            .map((m) => `${m} has ${usable[m].kept.length} paired task(s), minimum ${minN}`)
            .join('; '),
          why:
            'one task gives the bootstrap nothing to resample (every resample is that same task) and gives ' +
            'McNemar no discordant structure, so both statistics would come out degenerate rather than uncertain',
          needs: `at least ${minN} paired tasks per metric`,
          source:
            `default 20 (parameter --min-n, recorded in this output). The registered plan fixes no minimum: FORMULAS.md §8 states the test, the margin, B and alpha only; ` +
            'AGENT_BRIEF.md §9.1 states the grid\'s per-arm n (SWE-V 100, TB 66, tau2 base) and §9.3 defers the power analysis to bench/stats as [VERIFY]. ' +
            '6 pairs is the smallest n at which the exact test can reach alpha=0.05 at all (2*2^-(b+c) <= 0.05 requires b+c >= 6); ' +
            'approximately 100 pairs is what the grid\'s own effect size needs (see minimum detectable effect in this output)',
          remedy:
            'run the same task set under every arm until the metric is complete on at least this many tasks. The optimization loop ' +
            '(AGENT_BRIEF.md §9.7) draws one task per iteration and can supply this: a claim needs the accumulation across iterations, ' +
            'keyed by task, which is also why the loop records each draw\'s task and pool. Pass --min-n only to state a different ' +
            'floor — the tool records it in the output either way',
        });
      }
    }

    if (out.status === 'ok') {
      out.pairing.pairsUsed = usable[primary.metric].kept.length;

      for (const treatment of treatmentArms) {
        const perArm = {};
        for (const arm of [treatment, baseline]) {
          perArm[arm] = {};
          for (const metric of [primary.metric, ...family]) {
            const vals = usable[metric].kept.map((k) => valuesFor(metric, k, arm).value);
            perArm[arm][metric] = metrics[metric].kind === 'binary'
              ? { ...descriptive(vals), solved: vals.reduce((s, v) => s + v, 0), solveRate: mean(vals) }
              : descriptive(vals);
          }
        }

        const cmp = {
          treatment,
          baseline,
          n: usable[primary.metric].kept.length,
          metricN: Object.fromEntries([primary.metric, ...family].map((m) => [m, usable[m].kept.length])),
          perArm,
          primary: null,
          secondary: [],
        };

        // --- primary: McNemar over the shared, complete keys ---
        {
          const t = usable[primary.metric].kept.map((k) => valuesFor(primary.metric, k, treatment).value);
          const b0 = usable[primary.metric].kept.map((k) => valuesFor(primary.metric, k, baseline).value);
          const { b, c } = discordantPairs(t, b0);
          const n = t.length;
          const solveT = mean(t);
          const solveB = mean(b0);
          const delta = solveT - solveB;
          const useExact = method === 'exact' ? true : method === 'asymptotic' ? false : !asymptoticJustified(b, c);
          if (method === 'exact' && primary.margin !== 0) {
            throw new InputError(
              'a nonzero `primary.margin` cannot be tested by the exact test this tool implements: §8\'s exact form is a ' +
              'zero-margin sign test on the discordant pairs, and the non-inferiority route is an inversion of the binomial ' +
              'test that §8 does not register. Pass --method asymptotic (which prints the shifted statistic it used) or set the margin to 0.',
            );
          }
          const p = useExact ? mcnemarExactOneSided(b, c) : mcnemarAsymptoticTwoSided(b, c);
          const pMargin = primary.margin === 0 ? p : mcnemarAsymptoticOneSidedMargin(b, c, primary.margin);
          cmp.primary = {
            metric: primary.metric,
            test: useExact ? 'McNemar exact (binomial sign test on the discordant pairs)' : 'McNemar asymptotic (Edwards continuity correction)',
            why: useExact
              ? (method === 'exact'
                ? 'registered default (--method exact)'
                : `b+c = ${b + c} < 25 or min(b,c) = ${Math.min(b, c)} < 5, so the asymptotic form is not adequate`)
              : `b+c = ${b + c} >= 25 and min(b,c) = ${Math.min(b, c)} >= 5`,
            solvedTreatment: t.reduce((s, v) => s + v, 0),
            solvedBaseline: b0.reduce((s, v) => s + v, 0),
            solveRateTreatment: solveT,
            solveRateBaseline: solveB,
            delta,
            b,
            c,
            discordant: b + c,
            concordant: n - (b + c),
            pOneSided: p,
            pTwoSided: Math.min(1, 2 * p),
            margin: primary.margin,
            pForMargin: pMargin,
            rejects: p <= alpha,
            nonInferior: delta >= -primary.margin,
            // The sign test runs on the discordant pairs, so the discordant count — not the task count — is
            // what the sensitivity is a function of. Both are printed.
            mdeAtN: mdeAtDiscordant(b + c, { alpha, totalPairs: n }),
            mdeIfFullyDiscordant: mde(n, { alpha }),
          };
        }

        // --- secondary family: paired bootstrap, then Holm over the family ---
        for (const metric of family) {
          const keys = usable[metric].kept;
          const t = keys.map((k) => valuesFor(metric, k, treatment).value);
          const b0 = keys.map((k) => valuesFor(metric, k, baseline).value);
          const bs = pairedBootstrap(t, b0, { B, seed });
          const baseMean = mean(b0);
          const rel = metrics[metric].minRelImprovement === undefined ? 0.1 : metrics[metric].minRelImprovement;
          const higherIsBetter = metrics[metric].higherIsBetter !== false;
          // §8 writes the criterion for a cost: the interval's *upper* bound below -10 % of the baseline mean.
          // For a metric where up is better the same statement is the interval's lower bound above +10 %.
          const line = higherIsBetter ? rel * baseMean : -rel * baseMean;
          const improves = higherIsBetter ? bs.ciLow > line : bs.ciHigh < line;
          cmp.secondary.push({
            metric,
            n: keys.length,
            higherIsBetter,
            meanTreatment: mean(t),
            meanBaseline: baseMean,
            meanDiff: bs.meanDiff,
            medianDiff: bs.medianDiff,
            ciLow: bs.ciLow,
            ciHigh: bs.ciHigh,
            ciLevel: 0.95,
            B: bs.B,
            seed: bs.seed,
            relativeDiff: baseMean === 0 ? null : bs.meanDiff / baseMean,
            criterion: `CI ${higherIsBetter ? 'lower' : 'upper'} bound ${higherIsBetter ? '>' : '<'} ${(rel * 100).toFixed(1)}% of the baseline mean (${line})`,
            line,
            improves,
            pTwoSided: bs.pTwoSided,
            pOneSided: bs.pOneSided,
            metricDropped: usable[metric].dropped.length,
            note: 'two independent readings, both printed: `improves` is §8\'s criterion (the interval against the line) and `holmReject` is the family-corrected test. They are not the same statement, and a metric can pass one and fail the other.',
          });
        }

        out.comparisons.push(cmp);
      }

      // --- Holm over the pre-registered family, pooled across treatment arms ---
      const flat = [];
      for (const cmp of out.comparisons) {
        for (const s of cmp.secondary) flat.push({ treatment: cmp.treatment, metric: s.metric, p: s.pTwoSided, s });
      }
      if (flat.length > 0) {
        const adj = holm(flat.map((f) => f.p), alpha);
        flat.forEach((f, i) => {
          f.s.holmAdjusted = adj.entries[i].adjusted;
          f.s.holmRank = adj.entries[i].rank;
          f.s.holmReject = adj.entries[i].reject;
        });
        out.holm = {
          family: flat.map(({ treatment, metric }) => `${treatment} vs ${baseline}: ${metric}`),
          K: adj.K,
          alpha,
          basis: 'Holm step-down over the pooled secondary family (each treatment arm x each registered secondary metric)',
          entries: flat.map((f, i) => ({
            comparison: `${f.treatment} vs ${baseline}`,
            metric: f.metric,
            p: f.p,
            rank: adj.entries[i].rank,
            adjusted: adj.entries[i].adjusted,
            reject: adj.entries[i].reject,
            improves: f.s.improves,
            rejectedAndImproves: adj.entries[i].reject && f.s.improves,
          })),
        };
      }

      // --- the overall criterion of §8's last line ---
      const primaryOk = out.comparisons.every((c) => c.primary.nonInferior);
      const secondaryWins = (out.holm === null ? [] : out.holm.entries.filter((e) => e.rejectedAndImproves));
      out.verdict = {
        rule: 'completion rate non-inferior (Delta >= -margin) AND a secondary metric improved (Holm-adjusted, CI past the -10% line)',
        primaryNonInferior: primaryOk,
        secondaryWins: secondaryWins.map((e) => `${e.comparison} ${e.metric} (Holm-adjusted p = ${e.adjusted})`),
        success: primaryOk && secondaryWins.length > 0,
        note:
          'This is §8\'s criterion and nothing more. It is not a licence to read a per-metric win out of the family: ' +
          'the family is corrected as a family, and the criterion requires the primary (non-inferiority) leg as well.',
      };
    }
  }

  out.statusLine = statusLine(out);
  return out;
}

function statusLine(out) {
  const p = out.pairing;
  if (out.status === 'ok') {
    const c = out.comparisons[0];
    const pooled = out.holm === null ? `K=${p.family.K}` : `K=${p.family.K} metrics (${out.holm.K} pooled comparisons)`;
    return (
      `${out.tool}: ${out.status} · ${p.sharedTaskKeys} paired task(s) · family ${pooled} ` +
      `[${p.family.metrics.join(', ')}] · ${c.primary.test.split(' (')[0]} p=${fmt(c.primary.pOneSided)} ` +
      `(b=${c.primary.b}, c=${c.primary.c}) · bootstrap B=${out.inputs.B} seed=${out.inputs.seed} · ` +
      `success=${out.verdict.success}`
    );
  }
  return `${out.tool}: ${out.status} · ${out.refusals[0]?.what ?? 'no analysis produced'} · no p-value, no interval, no claim`;
}

// ---------------------------------------------------------------------------------------------
// 7. Rendering
// ---------------------------------------------------------------------------------------------

const fmt = (x, d = 6) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(2)}%`);
const num = (x, d = 6) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d }));

function render(out) {
  const L = [];
  const p = out.pairing;
  L.push(`analysis protocol: ${out.protocol} (registered rule)`);
  L.push(`status: ${out.status}`);
  L.push('');
  L.push('pairing');
  L.push(`  arms (as declared)      : ${p.arms.join(', ')}`);
  L.push(`  baseline                : ${p.baseline}`);
  L.push(`  treatment arm(s)        : ${p.treatmentArms.join(', ') || '(none)'}`);
  L.push(`  pairing unit            : the task key`);
  L.push(`  task keys in the file   : ${p.taskKeys}`);
  L.push(`  keys every arm ran      : ${p.sharedTaskKeys}`);
  for (const arm of p.arms) L.push(`  rows for ${arm.padEnd(15)}: ${p.rowsPerArm[arm]}`);
  L.push(`  pairs used by this run  : ${p.pairsUsed === null ? '— (refused)' : p.pairsUsed}`);
  if (p.droppedKeysJson.length > 0) {
    L.push(`  keys not shared by all  : ${p.droppedKeysJson.length}${out.inputs.allowDrop ? ' (dropped under --allow-drop)' : ' (refused; --allow-drop narrows instead)'}`);
    for (const k of p.droppedKeysJson.slice(0, 12)) {
      const has = p.arms.filter((a) => !p.keysMissingPerArm[a].includes(k));
      L.push(`      - ${k}: has ${has.join(', ') || '(none)'}; missing ${p.arms.filter((a) => !has.includes(a)).join(', ')}`);
    }
    if (p.droppedKeysJson.length > 12) L.push(`      … ${p.droppedKeysJson.length - 12} more`);
  }
  for (const arm of p.arms) {
    const missing = p.keysMissingPerArm[arm];
    if (missing.length > 0) L.push(`  ${arm} is missing ${missing.length} key(s) another arm ran`);
  }
  L.push('');
  L.push('family (stated, not implied)');
  L.push(`  primary                 : ${p.primaryMetric} (binary, McNemar; non-inferiority margin ${p.margin})`);
  L.push(`  secondary family        : ${p.family.metrics.join(', ') || '(empty)'}  →  K = ${p.family.K}`);
  L.push('  correction              : Holm step-down, applied to the secondary family as one family');
  L.push('');
  L.push('reproducibility');
  L.push(`  bootstrap B             : ${out.inputs.B}`);
  L.push(`  seed                    : ${out.inputs.seed}   (generator: mulberry32; resampled unit: the task)`);
  L.push(`  alpha                   : ${out.inputs.alpha}`);
  L.push(`  minimum paired n        : ${out.inputs.minN}   (parameter --min-n; the registered plan fixes none)`);
  L.push(`  primary test method     : ${out.inputs.method}`);
  L.push(`  allow-drop              : ${out.inputs.allowDrop}`);
  L.push('');

  if (out.refusals.length > 0) {
    L.push(out.status === 'ok' ? 'refusals on the record (narrowed, not blocking)' : 'refusal');
    for (const r of out.refusals) {
      L.push(`  kind   : ${r.kind}`);
      L.push(`  what   : ${r.what}`);
      L.push(`  why    : ${r.why}`);
      L.push(`  needs  : ${r.needs}`);
      if (r.source) L.push(`  source : ${r.source}`);
      if (r.note) L.push(`  note   : ${r.note}`);
      if (r.refusal_detail) for (const d of r.refusal_detail) L.push(`      - ${d}`);
      L.push(`  remedy : ${r.remedy}`);
      L.push('');
    }
  }

  if (out.status !== 'ok') {
    L.push('no p-value, no confidence interval and no success flag are printed, because none of them would mean anything here.');
    L.push('');
    L.push(statusLine(out));
    return L.join('\n');
  }

  for (const c of out.comparisons) {
    L.push(`comparison: ${c.treatment} vs ${c.baseline}   (n = ${c.n} paired task(s))`);
    L.push(`  per-arm (paired set only)`);
    for (const arm of [c.treatment, c.baseline]) {
      const row = c.perArm[arm];
      const bits = Object.keys(row).map((m) =>
        row[m].solveRate === undefined ? `${m} mean ${num(row[m].mean)}` : `${m} ${row[m].solved}/${row[m].n} = ${pct(row[m].solveRate)}`,
      );
      L.push(`    ${arm.padEnd(8)}: ${bits.join(' · ')}`);
    }
    const pr = c.primary;
    L.push(`  primary — ${pr.metric}`);
    L.push(`    solved            : ${c.treatment} ${pr.solvedTreatment}/${c.n} (${pct(pr.solveRateTreatment)}) vs ${c.baseline} ${pr.solvedBaseline}/${c.n} (${pct(pr.solveRateBaseline)})`);
    L.push(`    delta (solve rate): ${pr.delta >= 0 ? '+' : ''}${pct(pr.delta)}   margin -${pct(pr.margin)} → non-inferior: ${pr.nonInferior}`);
    L.push(`    discordant pairs  : b = ${pr.b}, c = ${pr.c}  (b+c = ${pr.discordant}; concordant ${pr.concordant})`);
    L.push(`    test              : ${pr.test}`);
    L.push(`    method chosen     : ${pr.why}`);
    L.push(`    p (one-sided)     : ${fmt(pr.pOneSided)}   alpha = ${out.inputs.alpha} → rejects: ${pr.rejects}`);
    L.push(`    p (two-sided)     : ${fmt(pr.pTwoSided)}`);
    if (pr.margin !== 0) L.push(`    p for margin -${pr.margin} : ${fmt(pr.pForMargin)} (asymptotic shifted statistic; see the header's stated gap)`);
    L.push(`    sensitivity       : ${pr.mdeAtN.text}`);
    if (pr.discordant < c.n) {
      L.push(`                        The sign test runs on discordant pairs, so the discordant count is what sets this.`);
      L.push(`                        If every one of the ${c.n} tasks were discordant the same approximation would give`);
      L.push(`                        +/-${(pr.mdeIfFullyDiscordant * 100).toFixed(1)} pp — the most optimistic reading, quoted only as such.`);
    } else {
      L.push(`                        Every one of the ${c.n} pairs is discordant, so the approximation's optimistic reading and`);
      L.push('                        this one coincide; neither is a statement about the effect.');
    }
    L.push(`  secondary — paired bootstrap, B = ${out.inputs.B}, seed = ${out.inputs.seed}, 95% percentile CI (type-7 quantiles)`);
    for (const s of c.secondary) {
      L.push(`    ${s.metric} (n = ${s.n}${s.metricDropped > 0 ? `, ${s.metricDropped} key(s) lacked it` : ''})`);
      L.push(`      mean      : ${c.treatment} ${num(s.meanTreatment)} vs ${c.baseline} ${num(s.meanBaseline)}`);
      L.push(`      paired diff: ${s.meanDiff >= 0 ? '+' : ''}${num(s.meanDiff)}   (relative ${s.relativeDiff === null ? '—' : pct(s.relativeDiff)})`);
      L.push(`      95% CI    : [${num(s.ciLow)}, ${num(s.ciHigh)}]   → §8's line: ${s.criterion}`);
      L.push(`      readings  : interval past the line (improves): ${s.improves}   ·   family-corrected test (Holm reject): ${s.holmReject === undefined ? '(no correction ran)' : s.holmReject}`);
      L.push(`      bootstrap p (two-sided, achieved level): ${fmt(s.pTwoSided)}${s.holmAdjusted === undefined ? '' : `   Holm-adjusted: ${fmt(s.holmAdjusted)} (rank ${s.holmRank})`}`);
    }
    L.push('');
  }

  if (out.holm) {
    L.push(`Holm step-down — family of K = ${out.holm.K} (explicit:`);
    out.holm.family.forEach((f, i) => L.push(`  ${i + 1}. ${f}`));
    L.push(')');
    L.push('  comparison                          metric        p          rank  adjusted   reject');
    for (const e of out.holm.entries) {
      L.push(`  ${e.comparison.padEnd(35)} ${e.metric.padEnd(13)} ${fmt(e.p).padEnd(10)} ${String(e.rank).padEnd(5)} ${fmt(e.adjusted).padEnd(10)} ${e.reject}`);
    }
    L.push('');
  }

  const v = out.verdict;
  L.push('verdict (§8, last line)');
  L.push(`  rule                          : ${v.rule}`);
  L.push(`  primary non-inferior          : ${v.primaryNonInferior}`);
  L.push(`  secondary wins (Holm-adjusted): ${v.secondaryWins.length === 0 ? 'none' : v.secondaryWins.join('; ')}`);
  L.push(`  success                       : ${v.success}`);
  L.push(`  note                          : ${v.note}`);
  L.push('');
  L.push('what this output does NOT say (so it is not read into it)');
  L.push('  · the p-values above are the tool\'s own construction, not the registered statistic.');
  L.push('    §8 registers McNemar\'s p-value and the bootstrap interval. The bootstrap p-value is the achieved');
  L.push('    level read off the resample distribution, and it exists only so Holm has a number to order: §8\'s');
  L.push('    secondary criterion is the interval against the -10% line, and that is the reading to use.');
  L.push(`  · with B = ${out.inputs.B}, an achieved p of 0.000000 means "no resample crossed 0", which is a lower`);
  L.push('    bound of 1/B (or 0.5/B one-sided), not a p-value of zero.');
  L.push('  · the sensitivity line is a normal approximation on the discordant pairs actually observed. It is a');
  L.push('    statement about what this n can resolve, not a guarantee, and it is not the effect size of anything.');
  L.push('');
  L.push(statusLine(out));
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// 8. --self-test
//
// The five cases the tool owes its caller, each with an answer that can be checked by hand rather than by
// running the tool twice: a McNemar case whose binomial sum is written out in the assertion, a bootstrap
// that has to reproduce under a fixed seed, a Holm family worked by hand, an unpaired input that must be
// refused, and a one-task input that must be refused for n. A self-test that only ever passes is
// indistinguishable from no self-test, so each defect case also asserts that the *wrong* answer is absent.
// ---------------------------------------------------------------------------------------------

function selfTest() {
  let checks = 0;
  const fail = (what, detail) => {
    const err = new Error(`self-test FAILED: ${what}${detail === undefined ? '' : ` — ${detail}`}`);
    err.isSelfTestFailure = true;
    throw err;
  };
  const eq = (what, got, want) => {
    checks += 1;
    const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) < 1e-12 : got === want;
    if (!ok) fail(what, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  const near = (what, got, want, tol) => {
    checks += 1;
    if (!(Math.abs(got - want) <= tol)) fail(what, `expected ${want} ± ${tol}, got ${got}`);
  };
  const ok = (what, cond) => {
    checks += 1;
    if (!cond) fail(what);
  };
  const say = (line) => process.stdout.write(`  ${line}\n`);

  // --- 1. McNemar, hand-checkable ---
  //
  // b = 8, c = 1 → b+c = 9, min = 1:
  //   p_one = 2^-9 · [C(9,0) + C(9,1)] = (1 + 9)/512 = 10/512 = 0.01953125
  //   p_two = 2 · p_one = 0.0390625 ≤ 0.05  →  the exact test rejects.
  // b = 6, c = 0 → 2^-6·C(6,0) = 1/64 = 0.015625 → p_two = 0.03125, the smallest n at which the two-sided
  //   exact test can reject at all: b+c ≥ 6 with every discordant pair on one side.
  // b = 5, c = 4 → the balanced case: p_one = 2^-9 · Σ_{i≤4} C(9,i) = 256/512 = 0.5 exactly → p_two = 1,
  //   the most a paired binary comparison of 9 tasks can ever be worth. (b+c odd is what makes p_two reach 1;
  //   b = 5, c = 5 gives p_one = 638/1024 = 0.623046875 → p_two = 1 as well, by the cap.)
  // The exact p-values are computed from log-Γ binomial coefficients, so the tolerance is 1e-12 rather than
  // 1e-15: the value is exact in exact arithmetic and this asserts the arithmetic, not the float.
  near('McNemar exact, b=8 c=1: p_one = 10/512', mcnemarExactOneSided(8, 1), 10 / 512, 1e-12);
  near('McNemar exact, b=8 c=1: p_two = 20/512 = 0.0390625', 2 * mcnemarExactOneSided(8, 1), 0.0390625, 1e-12);
  near('McNemar exact, b=6 c=0: p_one = 1/64', mcnemarExactOneSided(6, 0), 1 / 64, 1e-12);
  near('McNemar exact, b=6 c=0: p_two = 0.03125 (the smallest n that can reject)', 2 * mcnemarExactOneSided(6, 0), 0.03125, 1e-12);
  near('McNemar exact, b=5 c=4: p_one = 0.5', mcnemarExactOneSided(5, 4), 0.5, 1e-12);
  eq('McNemar exact, b=5 c=4: p_two = 1 (the cap)', Math.min(1, 2 * mcnemarExactOneSided(5, 4)), 1);
  near('McNemar exact, b=5 c=5: p_one = 638/1024', mcnemarExactOneSided(5, 5), 638 / 1024, 1e-12);
  eq('McNemar exact, b=5 c=5: p_two = 1 (the cap)', Math.min(1, 2 * mcnemarExactOneSided(5, 5)), 1);
  near('McNemar exact, b=0 c=0: p = 1', mcnemarExactOneSided(0, 0), 1, 1e-12);
  say('McNemar exact: b=8 c=1 → p_one=10/512=0.01953125 (rejects); b=6 c=0 → p_two=0.03125; b=5 c=4 → p_one=0.5, p_two=1; b=0 c=0 → 1');

  // The method-choice rule, on both sides of its boundary. `--method exact` is the registered default and
  // the exact form stays *correct* at every n; the rule below is when the asymptotic form is the adequate
  // one, which is what `--method auto` follows.
  ok('b+c = 8 is not asymptotic territory', !asymptoticJustified(7, 1));
  ok('b+c = 10 with min 2 is not asymptotic territory', !asymptoticJustified(8, 2));
  ok('b+c = 40 with min 4 is NOT asymptotic territory (min < 5)', !asymptoticJustified(36, 4));
  ok('b+c = 40 with min 20 is asymptotic territory', asymptoticJustified(20, 20));
  // And the refusal threshold the exact test itself imposes: 2·2^-(b+c) ≤ 0.05 needs b+c ≥ 6, so no 5-task
  // paired run can reject at the registered α whatever it observes.
  ok('a 5-task paired run cannot reach alpha = 0.05 with the exact test', 2 * 2 ** -5 > 0.05);
  ok('a 6-task paired run can, with every discordant pair on one side', 2 * 2 ** -6 <= 0.05);
  // The asymptotic form, against a hand computation: b=20, c=10 → χ² = (10-1)²/30 = 2.7, z = √2.7 = 1.643168
  // → p = erfc(1.643168/√2) = erfc(1.161895) ≈ 0.100348.
  near('McNemar asymptotic (Edwards), b=20 c=10: χ²=2.7', ((20 - 10 - 1) ** 2) / 30, 2.7, 1e-12);
  near('McNemar asymptotic (Edwards), b=20 c=10: p ≈ 0.100348', mcnemarAsymptoticTwoSided(20, 10), 0.10034824, 1e-6);
  // The same statistic at b=25, c=5: χ² = 19²/30 = 12.03333, z = 3.46891 → p ≈ 0.000522.
  near('McNemar asymptotic, b=25 c=5: p ≈ 0.000522', mcnemarAsymptoticTwoSided(25, 5), 0.00052225, 1e-6);
  ok('the uncorrected statistic gives a smaller p than the corrected one (the correction is not decoration)',
    mcnemarAsymptoticTwoSided(20, 10, { correction: false }) < mcnemarAsymptoticTwoSided(20, 10));
  near('the margin variant is the one-sided shifted statistic: b=30 c=20, δ=0.02 → z=(0.2+0.02)·√50 → p≈0.0599',
    mcnemarAsymptoticOneSidedMargin(30, 20, 0.02), 0.05989, 1e-4);
  say('asymptotic: b=20 c=10 → p≈0.100348 (uncorrected smaller); b=25 c=5 → p≈0.000522; margin form b=30 c=20 δ=0.02 → p≈0.0599');

  // --- 2. Holm, worked by hand ---
  //
  // p = [0.001, 0.008, 0.039, 0.041], K = 4, α = 0.05:
  //   rank 1: min(1, 4·0.001) = 0.004                     → 0.004 ≤ 0.05  reject
  //   rank 2: max(0.004, min(1, 3·0.008)) = max(0.004, 0.024) = 0.024      → 0.024 ≤ 0.05  reject
  //   rank 3: max(0.024, 2·0.039) = 0.078                                  → > 0.05  stop
  //   rank 4: max(0.078, 1·0.041) = 0.078   (the running maximum is what stops the last, smaller raw p from
  //           reading as significant after a larger one failed)             → > 0.05  no rejection
  // → [0.004, 0.024, 0.078, 0.078]: two of four reject, where an uncorrected reading would have called
  //   three (0.001, 0.008 and 0.039 are all ≤ 0.05 raw). At α = 0.08 all four reject, because every adjusted
  //   value is then ≤ α — the point of the α = 0.05 row is that the *family* is what moved, not the data.
  {
    const h = holm([0.001, 0.008, 0.039, 0.041], 0.05);
    eq('Holm K', h.K, 4);
    near('Holm rank 1', h.entries[0].adjusted, 0.004, 1e-12);
    near('Holm rank 2', h.entries[1].adjusted, 0.024, 1e-12);
    near('Holm rank 3', h.entries[2].adjusted, 0.078, 1e-12);
    near('Holm rank 4 (monotone, not 0.041)', h.entries[3].adjusted, 0.078, 1e-12);
    eq('Holm rejects exactly two of four at 0.05', h.entries.filter((e) => e.reject).length, 2);
    ok('the two it rejects are ranks 1 and 2', h.entries[0].reject && h.entries[1].reject);
    ok('the two that were significant uncorrected are not both significant corrected',
      !h.entries[2].reject && !h.entries[3].reject);
    // The step-down walk, not `adjusted <= alpha`: K=2 with p = [0.04, 0.05] adjusts to [0.08, 0.08] and
    // rejects neither, which is also what the vector comparison gives — but the walk is what makes the
    // family a *step-down* and it is the rule this asserts.
    const two = holm([0.04, 0.05], 0.05);
    eq('Holm step-down rejects neither of [0.04, 0.05] at K=2', two.entries.filter((e) => e.reject).length, 0);
    eq('and both are rejected at alpha=0.08', holm([0.04, 0.05], 0.08).entries.filter((e) => e.reject).length, 2);
    const h2 = holm([0.001, 0.008, 0.039, 0.041], 0.08);
    eq('raising alpha to 0.08 rejects the whole family (every adjusted value is 0.078 or below)',
      h2.entries.filter((e) => e.reject).length, 4);
    const inOrder = holm([0.039, 0.001, 0.041, 0.008], 0.05);
    near('Holm is invariant to the input order (adjusted values follow the original positions)',
      inOrder.entries[1].adjusted, 0.004, 1e-12);
    eq('Holm ranks the shuffled input by p, not by position', inOrder.entries[1].rank, 1);
    eq('Holm ties take the conservative (later) rank factor', holm([0.02, 0.02], 0.05).entries[1].rank, 2);
    near('Holm ties get the same adjusted value', holm([0.02, 0.02], 0.05).entries[0].adjusted,
      holm([0.02, 0.02], 0.05).entries[1].adjusted, 1e-12);
    const single = holm([0.03], 0.05);
    near('Holm with K = 1 is the raw p', single.entries[0].adjusted, 0.03, 1e-12);
    ok('and K = 1 can reject', single.entries[0].reject);
  }
  say('Holm: [0.001,0.008,0.039,0.041] K=4 → [0.004,0.024,0.078,0.078]; two reject at 0.05 where three would uncorrected; monotone, order-invariant, ties conservative');

  // --- 3. Paired bootstrap reproduces under a fixed seed ---
  {
    // Δ_i = x_i - y_i = 10 + i for i = 0..29, so the mean difference is exactly 10 + 29/2 = 24.5 and the
    // per-task differences vary enough for the resampling to matter. Written out rather than derived from a
    // modulo, because a hand-checkable fixture whose means need a script to compute is not hand-checkable.
    const x = [];
    const y = [];
    for (let i = 0; i < 30; i += 1) {
      x.push(100 + i * 3);
      y.push(90 + i * 2);
    }
    const a = pairedBootstrap(x, y, { B: 10000, seed: 12345 });
    const b = pairedBootstrap(x, y, { B: 10000, seed: 12345 });
    eq('bootstrap B is what callers asked for', a.B, 10000);
    eq('bootstrap seed is recorded', a.seed, 12345);
    eq('bootstrap n is recorded', a.n, 30);
    eq('the same seed reproduces the same interval (low)', a.ciLow, b.ciLow);
    eq('the same seed reproduces the same interval (high)', a.ciHigh, b.ciHigh);
    eq('the same seed reproduces the same p-value', a.pTwoSided, b.pTwoSided);
    // The point estimate is the data's own mean difference and must not depend on the seed at all:
    // Δ_i = (100 + 3i) - (90 + 2i) = 10 + i → mean = 10 + 29/2 = 24.5.
    near('the paired difference is the data\'s mean difference, seed-independent', a.meanDiff, 24.5, 1e-12);
    near('mean(x) over the fixture', mean(x), 143.5, 1e-12);
    near('mean(y) over the fixture', mean(y), 119, 1e-12);
    ok('the interval brackets the point estimate', a.ciLow <= a.meanDiff && a.meanDiff <= a.ciHigh);
    const c = pairedBootstrap(x, y, { B: 10000, seed: 12346 });
    ok('a different seed gives a different interval (the seed is not ignored)', c.ciLow !== a.ciLow || c.ciHigh !== a.ciHigh);
    ok('but a different seed gives an interval of the same order (the seed is not the answer)',
      Math.abs(c.ciLow - a.ciLow) < 1 && Math.abs(c.ciHigh - a.ciHigh) < 1);
    // The resampled unit is the task: with n = 1 every resample is that task, so the interval is a point and
    // the achieved p is 0 or 1 with no uncertainty in it at all. Asserting that degeneracy is the honest half
    // of the refusal below: a tool that reported this as a significant 4.0 (95% CI [4, 4], p = 0) would be
    // printing the most confident number in the table from the least data. The refusal for n is what stops it.
    const one = pairedBootstrap([5], [1], { B: 1000, seed: 1 });
    eq('one task: every resample is the same task, so the interval has zero width (low)', one.ciLow, 4);
    eq('one task: every resample is the same task, so the interval has zero width (high)', one.ciHigh, 4);
    eq('one task away from zero: the degenerate interval reports p = 0, which is why the tool refuses it', one.pTwoSided, 0);
    const oneAtZero = pairedBootstrap([5], [5], { B: 1000, seed: 1 });
    eq('one task at zero: the degenerate interval reports p = 1', oneAtZero.pTwoSided, 1);
    say('bootstrap: seed 12345 reproduces [ciLow, ciHigh] and p exactly; mean diff 24.5 is seed-independent; one task → zero-width interval with p = 0 or 1 (refused for n, not dressed up)');
  }

  // --- 4. An unpaired input must be refused ---
  {
    const spec = validateInput({
      baseline: 'C0',
      arms: ['C0', 'C2'],
      primary: { metric: 'solved' },
      metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } },
      family: ['cost'],
      tasks: {
        t1: { taskId: 't1', C0: { solved: 0, cost: 1.0 }, C2: { solved: 1, cost: 0.9 } },
        t2: { taskId: 't2', C0: { solved: 1, cost: 1.1 }, C2: { solved: 1, cost: 1.0 } },
        // t3 was never run under C2 — the ragged case a "drop the row" tool would average away.
        t3: { taskId: 't3', C0: { solved: 1, cost: 1.2 } },
      },
    });
    const res = analyze(spec, { minN: 2 });
    eq('unpaired input is refused', res.status, 'refused: insufficient-pairing');
    eq('and the refusal names the pairing', res.refusal, 'insufficient-pairing');
    ok('the refusal states which key is unpaired', res.refusals[0].refusal_detail.some((d) => d.startsWith('t3 ')));
    eq('the refusal names the missing arm for that key', res.refusals[0].refusal_detail[0], 't3 (has C0; missing C2)');
    eq('the refusal counts the unpaired keys', res.pairing.droppedKeysJson.length, 1);
    eq('the refusal reports the shared pair count it would have used', res.pairing.sharedTaskKeys, 2);
    ok('no comparison is produced', res.comparisons.length === 0);
    ok('no verdict is produced', res.verdict === null);
    ok('the refusal line says no claim was produced', res.statusLine.includes('no p-value, no interval, no claim'));
    // The same input under --allow-drop narrows instead, and says so.
    const narrowed = analyze(spec, { minN: 2, allowDrop: true });
    eq('--allow-drop narrows to the shared keys', narrowed.status, 'ok');
    eq('--allow-drop reports the pair count it used', narrowed.pairing.pairsUsed, 2);
    eq('--allow-drop reports the dropped key', narrowed.pairing.droppedKeys.join(','), 't3');
    eq('--allow-drop names the dropped key in the report too', narrowed.pairing.droppedKeysJson.join(','), 't3');
    say('unpaired: refused: insufficient-pairing (t3 has C0, missing C2), no p-value emitted; --allow-drop narrows to 2 pairs and names the dropped key');
  }

  // --- 5. A one-task input must be refused for n ---
  {
    const spec = validateInput({
      baseline: 'C0',
      arms: ['C0', 'C2'],
      primary: { metric: 'solved' },
      metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } },
      family: ['cost'],
      tasks: {
        t1: { taskId: 't1', C0: { solved: 0, cost: 1.0 }, C2: { solved: 1, cost: 0.9 } },
      },
    });
    const res = analyze(spec, { minN: 20 });
    eq('one task is refused', res.status, 'refused: insufficient-n');
    eq('and the refusal names n', res.refusal, 'insufficient-n');
    ok('the refusal says what it needs', res.refusals[0].needs.includes('at least 20 paired tasks'));
    ok('the refusal says why one task is not enough', res.refusals[0].why.includes('nothing to resample'));
    ok('the refusal cites where the minimum came from', res.refusals[0].source.includes('--min-n'));
    ok('the refusal says the registered plan fixes no minimum', res.refusals[0].source.includes('fixes no minimum'));
    ok('no p-value is produced for one task', res.comparisons.length === 0);
    ok('no verdict is produced for one task', res.verdict === null);
    // And the same data at the floor is analysed — the refusal is a threshold, not a refusal to work.
    const atFloor = analyze(spec, { minN: 1, B: 2000, seed: 7 });
    eq('at --min-n 1 the same input analyses', atFloor.status, 'ok');
    eq('and reports the pair count it used', atFloor.pairing.pairsUsed, 1);
    eq('and its McNemar reads the one discordant pair', atFloor.comparisons[0].primary.b, 1);
    eq('and its c is 0', atFloor.comparisons[0].primary.c, 0);
    // b = 1, c = 0 → p_one = 2^-1·[C(1,0)+C(1,1)] = 1/2, p_two = 1: one task cannot reject at any α ≤ 0.5,
    // which is the arithmetic behind the "6 tasks is the floor for the exact test" statement.
    near('and its p_one is 1/2, the most one pair can ever say', atFloor.comparisons[0].primary.pOneSided, 0.5, 1e-12);
    eq('and it does not reject', atFloor.comparisons[0].primary.rejects, false);
    say('one task: refused: insufficient-n (needs >= 20, "nothing to resample"); at --min-n 1 it analyses and reports n=1, p_one=1/2, no rejection');
  }

  // --- 6. The end-to-end shape on a fixture with a known answer ---
  //
  // 12 paired tasks. C2 solves t1..t9 (9/12), C0 solves t1..t5 (5/12): the discordant pairs are exactly the
  // four tasks C2 solved and C0 did not, so b = 4, c = 0 and the exact test gives
  // p_one = 2^-4·C(4,0) = 1/16 = 0.0625 → p_two = 0.125: non-inferior, and not significant at 0.05 — a
  // 33 pp solve-rate gain on 12 tasks that the exact test still refuses to call, which is the honest shape
  // of a small paired run and the reason the registered grid runs n = 100.
  // cost: C0 mean 1.0, C2 exactly 0.7 (a 30 % cut), steps: 10 → 7. minN is set to 6, the smallest n at
  // which the exact test can reach 0.05 at all, so the fixture exercises the real path.
  //
  // The margin is 0 here, which is the registered rule exactly as FORMULAS.md §8 writes it (paired McNemar
  // against the baseline). The 2 pp margin of AGENT_BRIEF.md §9.3 needs `--method asymptotic` and is
  // exercised separately below, so the two are not silently merged into one number.
  {
    const tasks = {};
    for (let i = 1; i <= 12; i += 1) {
      tasks[`t${i}`] = {
        taskId: `t${i}`,
        C0: { solved: i <= 5 ? 1 : 0, cost: 1.0, steps: 10 },
        C2: { solved: i <= 9 ? 1 : 0, cost: 0.7, steps: 7 },
      };
    }
    const spec = validateInput({
      baseline: 'C0',
      arms: ['C0', 'C2'],
      primary: { metric: 'solved', margin: 0 },
      metrics: {
        solved: { kind: 'binary' },
        cost: { kind: 'continuous', higherIsBetter: false, minRelImprovement: 0.1 },
        steps: { kind: 'continuous', higherIsBetter: false, minRelImprovement: 0.1 },
      },
      family: ['cost', 'steps'],
      tasks,
    });
    const res = analyze(spec, { B: 10000, seed: 20261002, minN: 6 });
    eq('fixture status', res.status, 'ok');
    eq('fixture pair count', res.pairing.pairsUsed, 12);
    eq('fixture primary metric is the binary one', res.pairing.primaryMetric, 'solved');
    eq('fixture family is stated explicitly', res.pairing.family.metrics.join(','), 'cost,steps');
    const c = res.comparisons[0];
    eq('fixture McNemar b', c.primary.b, 4);
    eq('fixture McNemar c', c.primary.c, 0);
    near('fixture exact p_one = 1/16 (b=4, c=0)', c.primary.pOneSided, 1 / 16, 1e-12);
    near('fixture exact p_two = 1/8', c.primary.pTwoSided, 0.125, 1e-12);
    // The sensitivity is a function of the discordant count, not the task count: (z_{0.975} + z_{0.8})/√n_d
    // = 2.8016/√4 = 1.4008 at the 4 discordant pairs, and 2.8016/√12 = 0.8088 at the optimistic n_d = 12.
    near('the sensitivity is taken at the discordant count', c.primary.mdeAtN.difference, 2.8015843 / 2, 1e-6);
    ok('and says it is past the whole scale, not a quantity', !c.primary.mdeAtN.resolvable);
    near('the fully-discordant reading is the same expression at n=12', c.primary.mdeIfFullyDiscordant, 2.8015843 / Math.sqrt(12), 1e-6);
    ok('the exact test cannot reach alpha=0.05 with b+c = 4', c.primary.pTwoSided > 0.05);
    eq('fixture primary test is the exact one', c.primary.test.startsWith('McNemar exact'), true);
    eq('fixture delta is 4/12', c.primary.delta, 4 / 12);
    ok('fixture is non-inferior at margin 0', c.primary.nonInferior);
    ok('fixture primary does not reject at 0.05', !c.primary.rejects);
    near('fixture cost diff is exactly -0.3', c.secondary[0].meanDiff, -0.3, 1e-12);
    near('fixture steps diff is exactly -3', c.secondary[1].meanDiff, -3, 1e-12);
    // Every difference is the same, so every resample is that difference: the interval is a point and the
    // achieved p is 0. This is the degenerate-but-true case, asserted so the tool is known to report it
    // rather than to dress it up.
    eq('a constant difference gives a zero-width interval', c.secondary[0].ciLow, c.secondary[0].ciHigh);
    eq('and an achieved p of 0', c.secondary[0].pTwoSided, 0);
    eq('the criterion line is -10% of the baseline mean', c.secondary[0].line, -0.1);
    ok('the cost criterion passes anyway (the CI is past the -10% line)', c.secondary[0].improves);
    ok('the steps criterion passes too (-3 against -1.0)', c.secondary[1].improves);
    eq('family K', res.holm.K, 2);
    eq('Holm adjusted is monotone across the two entries', res.holm.entries[0].adjusted <= res.holm.entries[1].adjusted, true);
    ok('the verdict is success (non-inferior and a corrected secondary win)', res.verdict.success);
    ok('the summary line names the pair count, the family and the seed', res.statusLine.includes('12 paired task(s)') && res.statusLine.includes('seed=20261002') && res.statusLine.includes('K=2'));
    say('fixture: n=12, b=4 c=0 → p_one=1/16=0.0625 (non-inferior, not significant on 12 tasks); cost -0.3 and steps -3 with zero-width intervals (constant difference, reported as such); verdict success');

    // The 2 pp margin of AGENT_BRIEF.md §9.3 takes the asymptotic shifted statistic, and the output has to
    // say which test it used and why. b = 4, c = 0 → Δ̂ = 1, z = (1 + 0.02)·√4 = 2.04 → p_one = Φ(-2.04)
    // = 0.0207, and the non-inferiority decision at the margin is decided by Δ̂ ≥ -δ, which needs no test.
    const withMargin = analyze(validateInput({
      baseline: 'C0',
      arms: ['C0', 'C2'],
      primary: { metric: 'solved', margin: 0.02 },
      metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous', higherIsBetter: false } },
      family: ['cost'],
      tasks,
    }), { B: 1000, seed: 3, minN: 6, method: 'asymptotic' });
    eq('a margined primary uses the asymptotic test', withMargin.comparisons[0].primary.test.startsWith('McNemar asymptotic'), true);
    eq('and the output states why the asymptotic form was taken', withMargin.comparisons[0].primary.why, 'b+c = 4 >= 25 and min(b,c) = 0 >= 5');
    ok('and it does not claim the exact test would have been the registered default',
      !withMargin.comparisons[0].primary.why.includes('registered default'));
    near('and reports the shifted p for the margin: b=4 c=0, δ=0.02 → Φ(-2.04) ≈ 0.0207',
      withMargin.comparisons[0].primary.pForMargin, 0.02068, 1e-4);
    ok('and the non-inferiority decision at 2 pp is positive (Δ̂ = +1 ≥ -0.02)', withMargin.comparisons[0].primary.nonInferior);
  }

  // --- 7. Malformed input is an InputError, not a quietly-wrong number ---
  //
  // `bad()` runs the *whole* path — validate, then analyze — because several violations (a binary value that
  // is not 0/1, a metric missing from one arm) only become visible while the values are read, and a check
  // that stopped at `validateInput` would have certified them as fine.
  {
    const bad = (what, spec, needle) => {
      checks += 1;
      try {
        analyze(validateInput(spec), { minN: 1, B: 10, seed: 1, allowDrop: false });
        fail(`${what}: no error was raised`);
      } catch (err) {
        if (err && err.isSelfTestFailure) throw err;
        if (!err || !err.isInputError) {
          fail(`${what}: threw a non-input error: ${err && err.message}`);
        }
        if (needle && !err.message.includes(needle)) {
          fail(`${what}: message ${JSON.stringify(err.message)} does not mention ${JSON.stringify(needle)}`);
        }
      }
    };
    const base = {
      baseline: 'C0',
      arms: ['C0', 'C2'],
      primary: { metric: 'solved' },
      metrics: { solved: { kind: 'binary' } },
      tasks: { t1: { taskId: 't1', C0: { solved: 0 }, C2: { solved: 1 } } },
    };
    bad('an empty arms list', { ...base, arms: [] }, 'at least two arms');
    bad('a duplicated arm', { ...base, arms: ['C0', 'C0'] }, 'duplicate');
    bad('a baseline outside arms', { ...base, baseline: 'C9' }, 'is not in arms');
    bad('an unknown primary metric', { ...base, primary: { metric: 'wall' } }, 'not declared in metrics');
    bad('a continuous primary', { ...base, primary: { metric: 'cost' }, metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } } }, 'binary');
    bad('a task without a taskId', { ...base, tasks: { t1: { C0: { solved: 0 }, C2: { solved: 1 } } } }, 'taskId must be the task');
    bad('an unknown arm in a task row', { ...base, tasks: { t1: { taskId: 't1', C7: { solved: 0 } } } }, 'is not in arms');
    bad('a task key with no rows at all', { ...base, tasks: { t1: { taskId: 't1' } } }, 'declares no (task, arm) row');
    bad('a binary value that is not 0/1', { ...base, tasks: { t1: { taskId: 't1', C0: { solved: 2 }, C2: { solved: 1 } } } }, 'must be 0 or 1');
    bad('a non-finite metric value', { ...base, metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } }, family: ['cost'], tasks: { t1: { taskId: 't1', C0: { solved: 0, cost: null }, C2: { solved: 1, cost: 1 } } } }, 'finite number');
    bad('a family naming the primary metric', { ...base, metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } }, family: ['solved'] }, 'continuous');
    bad('a family listing a metric twice', { ...base, metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } }, family: ['cost', 'cost'] }, 'twice');
    // The ragged-metric case is *not* a malformed input: the file is well-formed and the answer is a refusal.
    // That distinction is the exit code (1 vs 2) and it is asserted here rather than blurred into the `bad`
    // list, because a tool that threw on a well-formed file that simply cannot support a claim would be
    // reporting the caller's data as broken.
    {
      const ragged = {
        ...base,
        metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } },
        family: ['cost'],
        tasks: {
          t1: { taskId: 't1', C0: { solved: 0, cost: 1.0 }, C2: { solved: 1, cost: 0.9 } },
          t2: { taskId: 't2', C0: { solved: 0, cost: 1.0 }, C2: { solved: 0 } },
        },
      };
      const refused = analyze(validateInput(ragged), { minN: 1, B: 10, seed: 1, allowDrop: false });
      checks += 1;
      if (refused.status !== 'refused: insufficient-pairing') {
        fail(`a metric missing from one arm should be refused, got ${refused.status}`);
      }
      eq('the refusal quotes the metric and the count',
        refused.refusals[0].what, 'metric "cost" is missing on 1 of 2 shared task keys (t2 (no cost for C2))');
      eq('and the primary metric was still complete', refused.pairing.sharedTaskKeys, 2);
      ok('no comparison is produced for a ragged metric', refused.comparisons.length === 0);
      ok('the refusal text reaches the report', render(refused).includes('no p-value, no confidence interval and no success flag are printed'));
      // With --allow-drop the same input analyses the keys that carry the metric, and says how many it lost.
      const narrowed = analyze(validateInput(ragged), { minN: 1, B: 100, seed: 1, allowDrop: true });
      eq('--allow-drop analyses the keys that carry the metric', narrowed.status, 'ok');
      eq('--allow-drop reports n = 1 for the contracted metric', narrowed.comparisons[0].secondary[0].n, 1);
      eq('and reports that one key was dropped for it', narrowed.comparisons[0].secondary[0].metricDropped, 1);
      ok('and keeps the refusal on the record as a note', narrowed.refusals[0].note.includes('--allow-drop'));
    }
    // A nonzero margin with the exact method is refused rather than quietly swapped for another test.
    const withMargin = validateInput({ ...base, primary: { metric: 'solved', margin: 0.02 } });
    checks += 1;
    try {
      analyze(withMargin, { minN: 1, method: 'exact' });
      fail('a nonzero margin under --method exact: no error was raised');
    } catch (err) {
      if (!err.isInputError || !err.message.includes('margin')) fail(`a nonzero margin under --method exact: wrong error ${err && err.message}`);
    }
    say('malformed input: 12 declared violations each raise an InputError with a message naming the violation; a nonzero margin under --method exact is refused');
  }

  // --- 8. The refusal text reaches the CLI's own report ---
  {
    const oneTask = {
      baseline: 'C0',
      arms: ['C0', 'C2'],
      primary: { metric: 'solved' },
      metrics: { solved: { kind: 'binary' }, cost: { kind: 'continuous' } },
      family: ['cost'],
      tasks: { t1: { taskId: 't1', C0: { solved: 0, cost: 1 }, C2: { solved: 1, cost: 1 } } },
    };
    const res = analyze(validateInput(oneTask), { minN: 20 });
    const text = render(res);
    ok('the rendered refusal carries the status', text.includes('status: refused: insufficient-n'));
    ok('the rendered refusal carries the family it would have used', text.includes('secondary family        : cost'));
    ok('the rendered refusal carries B and the seed it would have used',
      text.includes('bootstrap B             : 10000') && text.includes('seed                    : 20261002'));
    ok('the rendered refusal carries the minimum n and its provenance',
      text.includes('minimum paired n        : 20') && text.includes('the registered plan fixes none'));
    ok('the rendered refusal does not print a p-value', !/p \(one-sided\)/.test(text));
    ok('the rendered refusal does not print a confidence interval', !/95% CI/.test(text));
    ok('the rendered refusal states that nothing was produced',
      text.includes('no p-value, no confidence interval and no success flag are printed'));
    say('rendered refusal: states the status, the family, B, the seed and the minimum n, and prints no p-value and no interval');
  }

  process.stdout.write(`paired-stats --self-test: PASS (${checks} assertions)\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// 9. CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/paired-stats.mjs --input <results.json> [options]
       node scripts/paired-stats.mjs --self-test

The registered analysis protocol of docs/FORMULAS.md §8: paired McNemar on a binary primary metric,
paired bootstrap (B = 10^4, seeded) on the continuous secondary family, Holm step-down across that family,
and a refusal — not a degenerate number — when the pairing or the n cannot support a claim.

options
  --input <file>     the result set (JSON; shape in this file's header). Required unless --self-test.
  --baseline <arm>   override the input's baseline arm
  --primary <name>   override the input's primary (binary) metric
  --family <a,b,c>   override the pre-registered secondary family (continuous metrics). The family this
                     tool corrects is whatever is printed under "family"; it is never inferred from the
                     metrics that happen to be present.
  --metric <name>    restrict the family to one metric (repeatable)
  --b <n>            bootstrap resamples (default 10000, FORMULAS.md §8)
  --seed <n>         bootstrap seed (default 20261002). Recorded in every output.
  --min-n <n>        minimum paired tasks before a claim is produced (default 20; FORMULAS.md §8 fixes
                     no minimum — see this file's header and the refusal's own \`source\` line)
  --alpha <x>        significance level (default 0.05)
  --margin <x>       non-inferiority margin for the primary metric (default 0 = §8 as written; a nonzero
                     margin needs --method asymptotic, and the header says why)
  --method <m>       exact | asymptotic | auto (default exact; auto follows b+c >= 25 and min(b,c) >= 5)
  --allow-drop       analyse the task keys every arm shares, printing which keys were dropped, instead of
                     refusing a ragged input
  --json             print the machine-readable result instead of the report
  --self-test        run the synthetic fixtures (McNemar, bootstrap, Holm, unpaired, one task) and exit
  -h, --help         this text

exit codes: 0 = analysed (the status is in the output) · 1 = the input is unusable · 2 = refused for
insufficient pairing or insufficient n · 3 = usage error`;

function readFlagValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const inputPath = readFlagValue(argv, 'input');
  if (inputPath === true || inputPath === undefined) {
    process.stderr.write(`${USAGE}\npaired-stats: --input is required (or --self-test)\n`);
    return 3;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`paired-stats: cannot read ${inputPath}: ${err && err.message}\n`);
    return 1;
  }

  try {
    if (typeof raw.baseline !== 'string' || raw.baseline === '') {
      const b = readFlagValue(argv, 'baseline');
      if (typeof b === 'string') raw.baseline = b;
    }
    const prim = readFlagValue(argv, 'primary');
    if (typeof prim === 'string') raw.primary = { ...(raw.primary ?? {}), metric: prim };
    const bFlag = readFlagValue(argv, 'b');
    const seedFlag = readFlagValue(argv, 'seed');
    const minNFlag = readFlagValue(argv, 'min-n');
    const alphaFlag = readFlagValue(argv, 'alpha');
    const marginFlag = readFlagValue(argv, 'margin');
    const methodFlag = readFlagValue(argv, 'method');
    const familyFlag = readFlagValue(argv, 'family');
    if (typeof familyFlag === 'string') raw.family = familyFlag.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const metricFlags = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--metric' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) metricFlags.push(argv[i + 1]);
    }
    if (metricFlags.length > 0) {
      const declared = raw.family === undefined ? Object.keys(raw.metrics ?? {}) : raw.family;
      const unknown = metricFlags.filter((m) => !declared.includes(m));
      if (unknown.length > 0) throw new InputError(`--metric names ${unknown.join(', ')}, not in the declared family ${JSON.stringify(declared)}`);
      raw.family = metricFlags;
    }
    if (typeof marginFlag === 'string') raw.primary = { ...(raw.primary ?? {}), margin: Number(marginFlag) };

    const spec = validateInput(raw);
    const result = analyze(spec, {
      B: typeof bFlag === 'string' ? Number(bFlag) : 10000,
      seed: typeof seedFlag === 'string' ? Number(seedFlag) : 20261002,
      minN: typeof minNFlag === 'string' ? Number(minNFlag) : 20,
      alpha: typeof alphaFlag === 'string' ? Number(alphaFlag) : 0.05,
      allowDrop: argv.includes('--allow-drop'),
      method: typeof methodFlag === 'string' ? methodFlag : 'exact',
    });

    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${render(result)}\n`);
    }
    return result.status === 'ok' ? 0 : 2;
  } catch (err) {
    if (err && err.isInputError) {
      process.stderr.write(`paired-stats: ${err.message}\n`);
      return 1;
    }
    if (err && (err.code === 'ENOENT' || err.code === 'EISDIR')) {
      process.stderr.write(`paired-stats: cannot read ${inputPath}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/**
 * The CLI runs only when this file is the process entry point. Without the gate, `import('./paired-stats.mjs')`
 * from a test file would execute the tool's argument parser as a side effect of the import — which is how this
 * file was first written, and how the gate was found: the scratch reader that imported it printed the usage
 * text and exited 3. The exports (`analyze`, `holm`, `pairedBootstrap`, `mcnemar*`, `validateInput`) are the
 * interface a test file uses.
 */
export const isCliEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntry) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`paired-stats: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
}
