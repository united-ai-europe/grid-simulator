# Grid Simulator

Client-side Monte Carlo engine behind the grid simulator published at
https://united-ai-europe.com/simulator/

**Status: Beta. An independent re-audit of the engine is pending.**
Results are research output, not investment advice.

## Contents

| Path | What it is |
|---|---|
| `site/assets/sim/engine.js` | simulation engine (pure JavaScript, no dependencies) |
| `site/assets/sim/worker.js` | Web Worker wrapper used by the browser |
| `tools/sim_tests.mjs` | unit tests of the engine |
| `tools/convergence_test.mjs` | statistical convergence tests |
| `docs/calibration-schema.md` | structure of the public calibration document |
| `CHANGELOG.md` | corrections log, including defects found by audit |

## Running the tests

Requires Node.js 18 or newer. No packages are installed.

## Calibration

The engine is parameterised by a calibration document published at
`https://united-ai-europe.com/api/calibration`. Its structure is described in
`docs/calibration-schema.md`. The document carries its own SHA-256, which the
browser verifies before use.

## Security

See `SECURITY.md`.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
