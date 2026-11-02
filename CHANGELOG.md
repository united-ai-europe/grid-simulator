# Changelog

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
