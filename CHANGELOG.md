# Changelog

## 0.2.0 — 2026-11-02

Crash replay, configurable precision, and bit-identical partitioning across
workers.

### Crash replay: the limit we had been declaring, measured

Every result the engine produces carries the note that none of its three price
models contains a crash. 0.2.0 makes that limit quantitative. `runCombination`
accepts `path: { returns, ref_close, label, source }` — a real daily sequence
instead of a model — and runs the same grid through it.

BTC, 22 days, grid ±15%, 25 levels, 2,000 paths, the real episode of
15 January – 6 February 2026:

| | PnL p50 | PnL p5 | PnL p95 | se(p50) | MDD p50 | P(exit) |
|---|---|---|---|---|---|---|
| **Replay of the real episode** | **−28.00%** | −29.43% | −27.63% | 0.006 | −29.2% | **100.0%** |
| Model B, two years of returns | +1.76% | **−10.52%** | +5.05% | 0.121 | −5.0% | 33.4% |

The model's P5 — its declared bad case — is less than half the loss of an
episode that actually happened. The replay result falls entirely outside the
model's 5th-to-95th percentile range.

A replay is **one past, not a distribution over futures**: the daily sequence is
fixed and only the intraday bridge is random, which is why `se(p50)` collapses
from 0.121 to 0.006. `robustness()` therefore **throws** when given results that
carry a `path_label`. Scoring six execution variants of a single path with a
2-standard-error test would dress one history up as statistical certainty — the
same class of mistake as the median-sign verdict fixed in 0.1.1.

Episodes are selected by a published rule, not by preference: a BTC peak-to-trough
fall of at least 30% completed within 90 days, non-overlapping, all that qualify.
Coins with no history inside an episode are reported as having none. No synthetic
or rescaled path is ever substituted.

### Configurable precision, and no silent truncation

- `MAX_PATHS` raised from 10,000 to 20,000. A request above the limit now
  **throws** instead of being clamped. Until 0.2.0 a request for 20,000 returned
  `paths: 10000` with no signal, so a report could claim a precision it did not
  have. Every result also carries `paths_requested` beside `paths`.
- `planPaths()` turns a measured device speed into a configuration and a reason.
  The cost is linear in both days and paths — measured: 1.307 ms per
  path-combination at 30 days and 3.936 at 90, flat between 1,000 and 10,000
  paths — so a single constant `c` is enough to predict the runtime. All
  thresholds are named constants in one place with their justification:
  `BUDGET_TARGET_S`, `PATH_CHOICES`, `PATHS_MIN`, `RUN_FREE_S`,
  `RUN_CONFIRM_S`, `COARSE_HARD_CAP_S`.
- `estimateSeconds()` is exported for callers that want to show a time before
  starting.

### Bit-identical partitioning across workers

`runCombination` was split into `simulatePaths()` (raw paths for a range of
indices, selected with `path_offset`) and `combineRaw()` (concatenation **in
index order** followed by a single `summarise()` call). `runCombination` without
`raw` is exactly `combineRaw([simulatePaths(...)])`, so there is only one
aggregation path in the engine: the one-worker and N-worker cases are not two
implementations that happen to agree, they are the same implementation.

This matters because `time_outside_range` is computed with a plain mean over the
paths in index order, and floating-point addition is not associative — measured
relative difference under permutation: 1.46e-15. Combining per-worker summaries
would therefore have produced results that depend on the number of cores.
`combineRaw()` rejects partitions that leave a gap, overlap, or mix parts
produced differently, rather than returning a plausible wrong answer.

Tests cover W ∈ {1, 2, 3, 5, 7, 8} with deliberately unequal slices and slice
counts that do not divide the total (3, 7), with parts delivered in reverse
order, and assert bit-identity including `time_outside_range` specifically.

### A runtime estimate that does not flatter the device

`planPaths()` consumes `c`, the wall-clock cost per path-day-combination **of the
whole worker pool**, and `estimateSeconds()` no longer divides by a worker count.
Two earlier shapes of this calculation were wrong in the same direction, and an
end-to-end test in a real browser caught both:

- measuring one worker and dividing by `navigator.hardwareConcurrency`
  under-estimated by about 1.5x, because performance and efficiency cores do not
  run at the same rate;
- measuring the whole pool but only the workers under-estimated by up to 1.57x,
  because `combineRaw()` and `summarise()` run on the main thread and were not
  being measured at all.

Both errors made the estimate optimistic, which is the one direction that
matters: the 30-second and 90-second gates would then have let through runs
longer than the visitor agreed to. The caller is expected to measure `c` with a
scaled-down run of the same shape as a real one.

### Verified, not assumed

`tools/convergence_test.mjs` was re-run at 20,000 paths. Its threshold is
`K · combined SE`, which tightens as the standard error falls, so more paths make
the test stricter rather than easier. All metrics still converge at 24h, 4h, 1h,
30min and 15min steps.

### Status

Beta, unchanged. 0.2.0 adds surface to audit — an imposed path, a partitioning,
a higher cap — so the version bump moves the independent re-audit further away,
not closer. The Beta label comes off only after it is completed.

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
