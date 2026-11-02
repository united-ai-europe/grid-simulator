# Changelog

## 0.1.1 — 2026-11-02

Hotfix. The robustness verdict could report ROBUST on a strategy with negative
expected value.

### The defect

`robustness()` labelled a run ROBUST when the **sign of the median** net PnL was
the same in all six combinations. For a grid strategy the median and the mean
routinely fall on opposite sides of zero: most paths collect small fees, and a
minority that exits the range loses a lot. The median then says "usually
positive" while the mean says "negative on average", and only the median was
being read.

Measured on a real run — DOGE, 25 levels, ±15%, 30 days, seed 475896362, 2,000
paths per combination:

| combination | median | mean | std. error | P(PnL<0) | CVaR 5% |
|---|---|---|---|---|---|
| A optimistic   | +5.48% | +1.04% | 0.249 | 30.6% | −29.2% |
| A conservative | +4.09% | **−0.89%** | 0.243 | 36.6% | −30.2% |
| B optimistic   | +5.49% | +0.42% | 0.267 | 33.4% | −32.0% |
| B conservative | +4.16% | **−1.45%** | 0.261 | 37.6% | −33.1% |
| C optimistic   | +6.53% | +1.17% | 0.289 | 29.6% | −35.2% |
| C conservative | +4.93% | **−0.92%** | 0.282 | 34.3% | −36.3% |

All six medians are positive, so 0.1.0 reported **ROBUST**. But the mean is
negative in all three conservative combinations, by 3.2 to 5.5 standard errors,
and between 30% and 38% of paths lose money. 0.1.1 reports **MIXED** on the
same input.

### Changed

- **`summarise()`** additionally returns `p_neg` (the share of values below
  zero), `cvar5` (the mean of the worst 5%, also called expected shortfall) and
  `cvar5_n` (how many values that average covers). Both are read from the
  already-sorted array, so they do not depend on the order the values arrived
  in.
- **`robustness()`** now decides on the **mean** and on its statistical
  significance. The label is `ROBUST` only when the mean net PnL has the same
  sign in all six combinations *and* each one is at least `ROBUST_SIGMAS` = 2
  standard errors from zero; `NEGATIVE EXPECTATION` when that condition holds
  with a negative sign; `MIXED` otherwise. The result carries `reason`,
  `mean_signs`, `median_signs`, `median_mean_disagree`,
  `insignificant_combinations`, `p_neg_min/max` and `cvar5_min/max`, so a caller
  can state *which* condition failed instead of guessing.
- **`makeModel()`** is exported, so a caller can report the volatility each
  model actually uses without duplicating the A/B/C dispatch.
- `tools/sim_tests.mjs`: new tests for `p_neg` and `cvar5` against
  hand-checkable inputs, for permutation invariance, for the 2-standard-error
  threshold exactly at its boundary, and a regression test pinned to the six
  measured DOGE values above, which must not yield `ROBUST`.

### Why 2 standard errors

The threshold separates "the sign is measured" from "the sign is Monte Carlo
noise": |mean| ≥ 2·SE is a two-sided interval of roughly 95% that does not reach
zero. Below it, claiming the sign is known reports sampling error as a result.
The remedy is in the reader's hands — more paths narrow the standard error as
1/√N, so a `MIXED` caused by insignificance can become a verdict by running
longer. A stricter threshold (3 SE) would demand about 2.25× the paths for the
same answer, which the decision does not warrant.

The threshold says nothing about **model** error. None of the three price models
contains a crash, returns are daily with an intraday Brownian bridge, and the
execution cost is a calibrated assumption. A `ROBUST` verdict remains a
statement about the models, not about the market.

### Status

Beta, unchanged. An independent re-audit of the engine is still pending; the
Beta label comes off only after it is completed.

## 0.1.0 — 2026-11-02

First public release of the engine and its tests.

### Corrected after independent audit (2026-11-01)

- **A-01 (critical):** the Brownian-bridge step did not converge. Corrected;
  covered by `tools/convergence_test.mjs`.
- **A-02 (critical):** the conservative safeguard was inoperative. Corrected;
  covered by `tools/sim_tests.mjs`.

### Status

Beta. An independent re-audit of the corrected engine is pending; the Beta label
will be removed only after it is completed.
