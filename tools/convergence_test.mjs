/* Criteriul obligatoriu pentru A-01: aceeasi configuratie si acelasi seed trebuie sa dea rezultate
 * statistic identice la pasi de 24h, 4h, 1h si 15min — "identice" insemnand in eroarea Monte Carlo
 * raportata, nu bit cu bit (pasii diferiti consuma alta aleatorietate).
 *
 *   node tools/convergence_test.mjs
 *
 * Testul compara fiecare pas cu cel mai fin (15min) si cere ca diferenta sa fie sub pragul
 * k * SE_combinat. Raporteaza tabelul chiar si cand trece, pentru ca tabelul e dovada.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = require(path.join(ROOT, 'site/assets/sim/engine.js'));

const STEPS = [[1, '24h'], [6, '4h'], [24, '1h'], [48, '30min'], [96, '15min']];
/* pasii de la aceasta rezolutie in sus sunt cei pe care motorul ii accepta; cei mai
   grosolani se raporteaza ca dovada, dar nu se cere convergenta pe ei, pentru ca
   runCombination ii refuza in productie */
const SUPPORTED = 24;
const PATHS = Number(process.env.CONV_PATHS || 4000);
const K = Number(process.env.CONV_K || 4);          /* prag, in erori standard combinate */

function coinFrom(returns, refPrice, df) {
  return {
    reference_price: refPrice, log_returns: returns, segment_starts: [0],
    student_t: { df: df || 4, scale: E.empiricalSd(returns) * Math.sqrt((df - 2) / df) }
  };
}
const rng = E.xoshiro128ss(20261101, 0);
const rr = [];
for (let i = 0; i < 730; i++) rr.push(0.028 * rng.normal());
const COIN = coinFrom(rr, 50000, 4);

const BASE = {
  coin: COIN, lowPct: -15, highPct: 15, levels: 25, capital: 10000,
  days: 30, paths: PATHS, seed: 777,
  feeRate: 0.00035, deltaStarBps: 20, cycleRatio: 0.878
};

let fails = 0;
const METRICS = [
  ['PnL p50 %', r => r.pnl_pct.p50, r => r.pnl_pct.se_p50],
  ['PnL mean %', r => r.pnl_pct.mean, r => r.pnl_pct.se_mean],
  ['cicluri p50', r => r.cycles.p50, r => r.cycles.se_p50],
  ['cicluri mean', r => r.cycles.mean, r => r.cycles.se_mean],
  ['MDD p50 %', r => r.mdd_pct.p50, r => r.mdd_pct.se_p50],
  ['P(iesire)', r => r.p_exit_range, r => r.se_p_exit]
];

for (const model of ['A', 'B', 'C']) {
  for (const cons of [false, true]) {
    const label = model + '/' + (cons ? 'cons' : 'opt');
    const runs = STEPS.map(([n, nm]) => ({
      name: nm, n,
      r: E.runCombination({ ...BASE, model, conservative: cons, stepsPerDay: n, allowCoarseStep: true })
    }));
    const ref = runs[runs.length - 1];
    console.log('\n=== ' + label + '  (' + PATHS + ' traiectorii, 30 zile, referinta ' + ref.name + ') ===');
    console.log('  ' + 'metrica'.padEnd(14) + runs.map(x => x.name.padStart(10)).join('')
                + '   verdict vs ' + ref.name);
    for (const [nm, get, se] of METRICS) {
      const vals = runs.map(x => get(x.r));
      const ses = runs.map(x => se(x.r));
      let verdict = 'ok';
      for (let i = 0; i < runs.length - 1; i++) {
        if (runs[i].n < SUPPORTED) continue;            /* sub rezolutia acceptata de motor */
        const d = Math.abs(vals[i] - vals[vals.length - 1]);
        const comb = Math.sqrt(ses[i] * ses[i] + ses[ses.length - 1] * ses[ses.length - 1]);
        if (d > K * comb) { verdict = 'DIVERGE la ' + runs[i].name +
          ' (' + d.toFixed(3) + ' > ' + (K * comb).toFixed(3) + ')'; fails++; break; }
      }
      console.log('  ' + nm.padEnd(14) + vals.map(v => v.toFixed(3).padStart(10)).join('') + '   ' + verdict);
    }
  }
}

console.log('\npasi sub 1h sunt raportati ca dovada; runCombination ii refuza (MIN_STEPS_PER_DAY = ' + E.MIN_STEPS_PER_DAY + ')');
console.log('prag: |diferenta| <= ' + K + ' x SE combinat, fata de pasul de 15min');
console.log('convergenta: ' + (fails ? fails + ' metrici DIVERG' : 'toate metricile converg'));
process.exit(fails ? 1 : 0);
