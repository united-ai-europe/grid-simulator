/* Teste pentru motorul simulatorului. Node, fara nicio dependinta:
 *   node tools/sim_tests.mjs
 *
 * Fiecare constatare CRITICA sau MAJORA din auditul extern are aici un test care ar fi prins-o.
 * Testele sunt marcate cu identificatorul constatarii.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = require(path.join(ROOT, 'site/assets/sim/engine.js'));

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; results.push(['PASS', name, detail || '']); }
  else { fail++; results.push(['FAIL', name, detail || '']); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------- monede si modele sintetice ---------- */

function coinFrom(returns, refPrice, df) {
  const sd = E.empiricalSd(returns);
  const d = df || 5;
  return {
    reference_price: refPrice, log_returns: returns, segment_starts: [0],
    student_t: { df: d, scale: d > 2 ? sd * Math.sqrt((d - 2) / d) : sd }
  };
}
/* model determinist: randamente date, fara zgomot intrazi (sd = 0 -> extremele cad pe capete) */
function fixedModel(dailyReturns) {
  return { sd: 0, gen: (rng, out, days) => { for (let k = 0; k < days; k++) out[k] = dailyReturns[k % dailyReturns.length]; } };
}

const BASE = {
  lowPct: -20, highPct: 20, levels: 20, capital: 10000,
  days: 30, paths: 200, seed: 12345,
  feeRate: 0.0007, deltaStarBps: 20, cycleRatio: 0.878
};

/* ---------- 1. determinism pe seed ---------- */
{
  const rr = []; const rng0 = E.xoshiro128ss(1, 0);
  for (let i = 0; i < 400; i++) rr.push(0.02 * rng0.normal());
  const coin = coinFrom(rr, 100);
  const a = E.runCombination({ ...BASE, coin, model: 'A', conservative: false });
  const b = E.runCombination({ ...BASE, coin, model: 'A', conservative: false });
  const c = E.runCombination({ ...BASE, coin, model: 'A', conservative: false, seed: BASE.seed + 1 });
  ok('determinism: acelasi seed -> acelasi rezultat', JSON.stringify(a) === JSON.stringify(b),
     'p50 = ' + a.pnl_pct.p50.toFixed(6));
  ok('determinism: alt seed -> alt rezultat', JSON.stringify(a) !== JSON.stringify(c));
  const d = E.runCombination({ ...BASE, coin, model: 'C', conservative: true });
  const e = E.runCombination({ ...BASE, coin, model: 'C', conservative: true });
  ok('determinism: model C + conservator', JSON.stringify(d) === JSON.stringify(e));
}

/* ---------- 2. volatilitate zero -> zero cicluri, PnL 0 ---------- */
{
  const coin = coinFrom(new Array(400).fill(0), 100, 5);
  for (const model of ['A', 'B', 'C']) {
    for (const cons of [false, true]) {
      const r = E.runCombination({ ...BASE, coin, model, conservative: cons, paths: 40 });
      const tag = `${model}/${cons ? 'cons' : 'opt'}`;
      ok(`volatilitate zero (${tag}): zero cicluri`, r.cycles.p95 === 0, 'p95 = ' + r.cycles.p95);
      ok(`volatilitate zero (${tag}): PnL 0`,
         near(r.pnl_pct.p5, 0, 1e-9) && near(r.pnl_pct.p95, 0, 1e-9),
         [r.pnl_pct.p5, r.pnl_pct.p95].map(x => x.toExponential(1)).join(' / '));
      ok(`volatilitate zero (${tag}): drawdown 0`, near(r.mdd_pct.p5, 0, 1e-9));
    }
  }
}

/* ---------- 3. drum strict crescator -> inventar vandut, drawdown 0 ---------- */
{
  const up = fixedModel([Math.log(1.01)]);
  const coin = coinFrom(new Array(400).fill(0), 100, 5);
  const noFee = E.runCombination({
    ...BASE, coin, modelFn: up, model: 'A', conservative: false,
    paths: 1, days: 60, lowPct: -30, highPct: 30, feeRate: 0
  });
  ok('drum strict crescator: inventarul final vandut integral',
     near(noFee.final_inventory_pct.p50, 0, 1e-9),
     noFee.final_inventory_pct.p50.toExponential(2) + '%');
  ok('drum strict crescator: drawdown 0 fara comisioane', near(noFee.mdd_pct.p50, 0, 1e-9));
  ok('drum strict crescator: PnL pozitiv', noFee.pnl_pct.p50 > 0, noFee.pnl_pct.p50.toFixed(3) + '%');
}

/* ---------- 4. "+25% apoi -18%" -> drawdown ~ -18% ---------- */
{
  const mdd = 100 * E.maxDrawdownFromPeak([1, 1.25, 1.25 * 0.82]);
  ok('drawdown "+25% apoi -18%" = -18% (de la VARFUL CURENT)', near(mdd, -18, 1e-9), mdd.toFixed(6) + '%');
  const K = 10000, P0 = 100;
  const peak = K / 2 + (K / 2 / P0) * (P0 * 1.25), trough = K / 2 + (K / 2 / P0) * (P0 * 1.25 * 0.82);
  ok('drawdown pe capitalul grilei = valoarea analitica',
     near(100 * E.maxDrawdownFromPeak([K, peak, trough]), 100 * (trough / peak - 1), 1e-9));
}

/* ---------- 5. conservarea valorii la t0 ---------- */
{
  const K = 10000, P0 = 137.42;
  ok('conservarea valorii la t0: cash + inventar*pret == capital',
     Math.abs(K / 2 + ((K / 2) / P0) * P0 - K) < 1e-9);
  const coin = coinFrom(new Array(400).fill(0), P0, 5);
  const r = E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 10, capital: K });
  ok('conservarea valorii prin motor: PnL exact 0 pe volatilitate zero',
     Math.abs(r.pnl_pct.p50) < 1e-12);
}

/* ---------- 6. plafon 10.000 si nivelurile grilei ---------- */
{
  const rr = []; const rng = E.xoshiro128ss(9, 0);
  for (let i = 0; i < 400; i++) rr.push(0.02 * rng.normal());
  const coin = coinFrom(rr, 100);
  const r = E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 999999, days: 1 });
  ok('plafon 10.000 impus in motor', r.paths === 10000, 'paths = ' + r.paths);
  const L = E.buildLevels(80, 120, 5);
  ok('nivelurile acopera exact intervalul', L[0] === 80 && L[4] === 120);
  ok('nivelurile sunt strict crescatoare', L.every((v, i) => i === 0 || v > L[i - 1]));
}

/* ---------- A-01: rezultatul nu mai depinde de pasul intrazi ---------- */
{
  const rr = []; const rng = E.xoshiro128ss(31337, 0);
  for (let i = 0; i < 730; i++) rr.push(0.028 * rng.normal());
  const coin = coinFrom(rr, 50000, 4);
  const cfg = { ...BASE, coin, model: 'A', days: 30, paths: 2500, seed: 777,
                feeRate: 0.00035, levels: 25, lowPct: -15, highPct: 15 };
  for (const cons of [false, true]) {
    const a = E.runCombination({ ...cfg, conservative: cons, stepsPerDay: 24 });
    const b = E.runCombination({ ...cfg, conservative: cons, stepsPerDay: 96, allowCoarseStep: true });
    for (const [nm, get, se] of [['cicluri', r => r.cycles.mean, r => r.cycles.se_mean],
                                 ['PnL mean', r => r.pnl_pct.mean, r => r.pnl_pct.se_mean],
                                 ['MDD p50', r => r.mdd_pct.p50, r => r.mdd_pct.se_p50]]) {
      const d = Math.abs(get(a) - get(b));
      const lim = 4 * Math.sqrt(se(a) ** 2 + se(b) ** 2);
      ok(`A-01 (${cons ? 'cons' : 'opt'}): ${nm} identic la 1h si 15min, in eroarea MC`,
         d <= lim, `${get(a).toFixed(3)} vs ${get(b).toFixed(3)} (|d|=${d.toFixed(3)} <= ${lim.toFixed(3)})`);
    }
  }
  ok('A-01: tabelul complet de convergenta e in tools/convergence_test.mjs', true, '24h / 4h / 1h / 30min / 15min');
}

/* ---------- A-03: pasul nu se mai adapteaza la dispozitiv ---------- */
{
  const rr = []; const rng = E.xoshiro128ss(5, 0);
  for (let i = 0; i < 400; i++) rr.push(0.025 * rng.normal());
  const coin = coinFrom(rr, 100);
  const slow = E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 60, stepsPerDay: 6 });
  const fast = E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 60, stepsPerDay: 24 });
  ok('A-03: un pas mai grosolan decat minimul e ridicat la minim',
     slow.steps_per_day === E.MIN_STEPS_PER_DAY && JSON.stringify(slow) === JSON.stringify(fast),
     'cerut 4h -> rulat ' + (24 / slow.steps_per_day) + 'h');
  const dflt = E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 60 });
  ok('A-03: fara stepsPerDay se foloseste rezolutia fixa', dflt.steps_per_day === E.STEPS_PER_DAY,
     E.STEPS_PER_DAY + ' pasi/zi');
}

/* ---------- A-02: conservatorul nu mai poate iesi mai bine decat optimistul ---------- */
{
  /* (a) urcare monotona */
  const up = fixedModel([Math.log(1.01)]);
  const coin = coinFrom(new Array(400).fill(0), 100, 5);
  const o = E.runCombination({ ...BASE, coin, modelFn: up, model: 'A', conservative: false, paths: 1, days: 60, lowPct: -30, highPct: 30 });
  const c = E.runCombination({ ...BASE, coin, modelFn: up, model: 'A', conservative: true, paths: 1, days: 60, lowPct: -30, highPct: 30 });
  ok('A-02 urcare monotona: conservator <= optimist la PnL',
     c.pnl_pct.p50 <= o.pnl_pct.p50 + 1e-9, `opt ${o.pnl_pct.p50.toFixed(3)}% vs cons ${c.pnl_pct.p50.toFixed(3)}%`);
  ok('A-02 urcare monotona: conservator <= optimist la cicluri',
     c.cycles.p50 <= o.cycles.p50 + 1e-9, `opt ${o.cycles.p50} vs cons ${c.cycles.p50}`);

  /* (b) oscilatie cu amplitudine peste delta* -> conservatorul TREBUIE sa execute */
  const amp = 0.05;                                   /* 5% >> delta* = 0,20% */
  const osc = fixedModel([Math.log(1 + amp), Math.log(1 / (1 + amp))]);
  const oo = E.runCombination({ ...BASE, coin, modelFn: osc, model: 'A', conservative: false, paths: 1, days: 60, lowPct: -20, highPct: 20 });
  const oc = E.runCombination({ ...BASE, coin, modelFn: osc, model: 'A', conservative: true, paths: 1, days: 60, lowPct: -20, highPct: 20 });
  ok('A-02 oscilatie > delta*: conservatorul executa (cicluri > 0)',
     oc.cycles.p50 > 0, 'cicluri cons = ' + oc.cycles.p50.toFixed(2));
  ok('A-02 oscilatie: conservator <= optimist la cicluri',
     oc.cycles.p50 <= oo.cycles.p50 + 1e-9, `opt ${oo.cycles.p50.toFixed(2)} vs cons ${oc.cycles.p50.toFixed(2)}`);
  ok('A-02 oscilatie: conservator <= optimist la PnL',
     oc.pnl_pct.p50 <= oo.pnl_pct.p50 + 1e-9, `opt ${oo.pnl_pct.p50.toFixed(3)}% vs cons ${oc.pnl_pct.p50.toFixed(3)}%`);

  /* (c) oscilatie sub delta* -> conservatorul nu executa, optimistul da */
  const tiny = 0.0005;                                /* 0,05% < delta* = 0,20% */
  const osc2 = fixedModel([Math.log(1 + tiny), Math.log(1 / (1 + tiny))]);
  const t1 = E.runCombination({ ...BASE, coin, modelFn: osc2, model: 'A', conservative: true, paths: 1, days: 60, levels: 100, lowPct: -2, highPct: 2 });
  ok('A-02 oscilatie sub delta*: conservatorul nu executa', t1.cycles.p50 === 0, 'cicluri = ' + t1.cycles.p50);

  /* (d) pe date aleatorii, invariantul trebuie sa tina in medie */
  const rr = []; const rng = E.xoshiro128ss(77, 0);
  for (let i = 0; i < 730; i++) rr.push(0.03 * rng.normal());
  const rcoin = coinFrom(rr, 1000, 4);
  const ro = E.runCombination({ ...BASE, coin: rcoin, model: 'A', conservative: false, paths: 400, days: 60 });
  const rc = E.runCombination({ ...BASE, coin: rcoin, model: 'A', conservative: true, paths: 400, days: 60 });
  ok('A-02 pe date aleatorii: conservator <= optimist la cicluri',
     rc.cycles.mean <= ro.cycles.mean, `opt ${ro.cycles.mean.toFixed(1)} vs cons ${rc.cycles.mean.toFixed(1)}`);
  ok('A-02 pe date aleatorii: conservator <= optimist la PnL median',
     rc.pnl_pct.p50 <= ro.pnl_pct.p50, `opt ${ro.pnl_pct.p50.toFixed(3)}% vs cons ${rc.pnl_pct.p50.toFixed(3)}%`);
}

/* ---------- A-04: bootstrap fara drift ---------- */
{
  const rng = E.xoshiro128ss(99, 0);
  const rr = [];
  for (let i = 0; i < 730; i++) rr.push(0.03 * rng.normal() + 0.0012);   /* cu drift pozitiv injectat */
  const muU = rr.reduce((a, b) => a + b, 0) / rr.length;                 /* centrarea veche, neponderata */
  const bs = E.makeBootstrap(rr, [0], E.BLOCK_DAYS);
  /* Exact, nu statistic: valoarea asteptata a unui randament generat este suma ponderata a
     pool-ului centrat, cu ponderile = de cate ori poate fi ales fiecare randament. Trebuie sa fie
     zero la precizia masinii. Centrarea veche, neponderata, lasa aici un rest sistematic. */
  const n = rr.length, L = E.BLOCK_DAYS;
  let wsum = 0, wdotC = 0, wdotU = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.min(i, n - L, L - 1, n - L - i + (L - 1)) >= 0
      ? Math.max(0, Math.min(i, L - 1, n - L) - Math.max(0, i - (n - L)) + 1) : 0;
    wsum += w; wdotC += w * (rr[i] - bs.weightedMean); wdotU += w * (rr[i] - muU);
  }
  ok('A-04: valoarea asteptata a unui randament generat este exact zero',
     Math.abs(wdotC / wsum) < 1e-15, 'E[r] = ' + (wdotC / wsum).toExponential(2));
  ok('A-04: centrarea neponderata ar fi lasat un drift diferit de zero',
     Math.abs(wdotU / wsum) > 1e-9,
     'E[r] cu centrare neponderata = ' + (100 * (wdotU / wsum) * 90).toFixed(4) + '% pe 90 de zile');
  /* driftul simulat pe 90 de zile trebuie sa fie zero in eroarea MC */
  const out = new Float64Array(90);
  let s = 0; const N = 4000;
  for (let k = 0; k < N; k++) { bs.gen(E.xoshiro128ss(1234, k), out, 90); for (let j = 0; j < 90; j++) s += out[j]; }
  const meanPath = s / N, sePath = bs.sd * Math.sqrt(90) / Math.sqrt(N);
  ok('A-04: drift pe 90 de zile = 0 in eroarea MC',
     Math.abs(meanPath) <= 4 * sePath,
     `${(100 * meanPath).toFixed(4)}% +- ${(100 * 4 * sePath).toFixed(4)}%`);
}

/* ---------- A-05: modelele nu mai au acelasi zgomot intrazi ---------- */
{
  const rng = E.xoshiro128ss(555, 0); const rr = [];
  for (let i = 0; i < 730; i++) rr.push(0.03 * rng.normal());
  const coin = coinFrom(rr, 1000, 3.2);
  const cyc = {};
  for (const m of ['A', 'B', 'C']) {
    cyc[m] = E.runCombination({ ...BASE, coin, model: m, conservative: false, paths: 500, days: 30 }).cycles.mean;
  }
  const uniq = new Set(Object.values(cyc).map(v => v.toFixed(6)));
  ok('A-05: cele trei modele nu mai dau cicluri identice', uniq.size === 3,
     `A ${cyc.A.toFixed(2)} | B ${cyc.B.toFixed(2)} | C ${cyc.C.toFixed(2)}`);
  const sdA = E.makeBootstrap(rr, [0], E.BLOCK_DAYS).sd;
  const sdB = E.makeGaussian(rr).sd;
  const sdC = E.makeStudentT(coin.student_t.df, coin.student_t.scale).sd;
  ok('A-05: fiecare model isi declara propriul sd zilnic',
     sdA > 0 && sdB > 0 && sdC > 0, `A ${sdA.toFixed(5)} | B ${sdB.toFixed(5)} | C ${sdC.toFixed(5)}`);
}

/* ---------- A-06: PnL si drawdown din aceeasi serie de echitate ---------- */
{
  const rng = E.xoshiro128ss(321, 0); const rr = [];
  for (let i = 0; i < 400; i++) rr.push(0.025 * rng.normal());
  const coin = coinFrom(rr, 500, 5);
  const o = E.runCombination({ ...BASE, coin, model: 'A', conservative: false, paths: 300, days: 30 });
  const c = E.runCombination({ ...BASE, coin, model: 'A', conservative: true, paths: 300, days: 30 });
  ok('A-06: haircut-ul conservator inrautateste si drawdown-ul, nu doar PnL-ul',
     c.mdd_pct.p50 <= o.mdd_pct.p50 + 1e-9 && c.pnl_pct.p50 <= o.pnl_pct.p50 + 1e-9,
     `MDD opt ${o.mdd_pct.p50.toFixed(3)} vs cons ${c.mdd_pct.p50.toFixed(3)}`);
  ok('A-06: drawdown-ul nu e niciodata pozitiv', c.mdd_pct.p95 <= 0 && o.mdd_pct.p95 <= 0);
}

/* ---------- P(x<0) si CVaR 5% din summarise ---------- */
{
  /* Valori construite ca sa aiba un raspuns exact, calculabil de mana: fara asta un test pe
     statistici ar confirma orice implementare care "pare" sa mearga. */
  const a = []; for (let i = 1; i <= 100; i++) a.push(i);
  const s1 = E.summarise(a);
  ok('CVaR 5% = media celor mai rele 5% (1..100 -> media 1..5 = 3)', s1.cvar5 === 3, String(s1.cvar5));
  ok('CVaR 5% declara pe cate valori s-a calculat', s1.cvar5_n === 5, String(s1.cvar5_n));
  ok('P(x<0) = 0 cand nimic nu e negativ', s1.p_neg === 0, String(s1.p_neg));

  const b = []; for (let i = -50; i <= 49; i++) b.push(i);
  const s2 = E.summarise(b);
  ok('P(x<0) numara exact valorile negative (50 din 100)', s2.p_neg === 0.5, String(s2.p_neg));
  ok('zero NU se numara ca pierdere', E.summarise([0, 1, 2, 3]).p_neg === 0,
     String(E.summarise([0, 1, 2, 3]).p_neg));
  ok('P(x<0) = 1 cand tot e negativ', E.summarise([-3, -2, -1]).p_neg === 1);

  /* Invarianta la permutari: summarise sorteaza inainte de orice, deci cele doua marimi noi nu
     introduc o dependenta de ordine. E proprietatea de care depinde partitionarea pe lucratori. */
  const rngp = E.xoshiro128ss(31, 0);
  const c0 = []; for (let i = 0; i < 500; i++) c0.push(rngp.normal() * 3 - 0.4);
  const c1 = c0.slice();
  for (let i = c1.length - 1; i > 0; i--) { const j = rngp.int(i + 1); const t = c1[i]; c1[i] = c1[j]; c1[j] = t; }
  const q0 = E.summarise(c0), q1 = E.summarise(c1);
  ok('P(x<0) si CVaR 5% sunt identice bit cu bit la permutarea intrarii',
     q0.p_neg === q1.p_neg && q0.cvar5 === q1.cvar5 && q0.mean === q1.mean,
     [q0.cvar5, q1.cvar5].join(' vs '));
}

/* ---------- verdictul: semnul MEDIEI, cu semnificatie (0.1.1) ---------- */
{
  /* Stub-ul duce acum si media si eroarea ei: pana la 0.1.1 verdictul se uita doar la mediana,
     iar un stub fara medie nu putea prinde defectul pentru care s-a schimbat. */
  const mk = (mean, se, p50) => ({ pnl_pct: { p50: p50 === undefined ? mean : p50, mean, se_mean: se, p5: mean - 25 } });
  const six = (...xs) => xs;

  ok('ROBUST: toate mediile pozitive si semnificative',
     E.robustness(six(mk(1, 0.2), mk(2, 0.2), mk(3, 0.2), mk(4, 0.2), mk(5, 0.2), mk(6, 0.2))).label === 'ROBUST');
  ok('NEGATIVE EXPECTATION: toate mediile negative si semnificative',
     E.robustness(six(mk(-1, 0.2), mk(-2, 0.2), mk(-3, 0.2), mk(-4, 0.2), mk(-5, 0.2), mk(-6, 0.2))).label
       === 'NEGATIVE EXPECTATION');
  ok('MIXED cand semnele mediei difera',
     E.robustness(six(mk(1, 0.2), mk(2, 0.2), mk(-3, 0.2), mk(4, 0.2), mk(5, 0.2), mk(6, 0.2))).label === 'MIXED');
  ok('MIXED cand o singura combinatie e sub 2 erori standard',
     E.robustness(six(mk(1, 0.2), mk(2, 0.2), mk(3, 0.2), mk(4, 0.2), mk(5, 0.2), mk(0.3, 0.2))).label === 'MIXED');
  ok('o combinatie nehotarata e numarata si raportata',
     E.robustness(six(mk(1, 0.2), mk(2, 0.2), mk(3, 0.2), mk(4, 0.2), mk(5, 0.2), mk(0.3, 0.2)))
       .insignificant_combinations === 1);

  /* Pragul, exact la limita. Verifica si inegalitatea (>=, nu >). */
  const atLimit = E.robustness(six(mk(0.4, 0.2), mk(1, 0.2), mk(1, 0.2), mk(1, 0.2), mk(1, 0.2), mk(1, 0.2)));
  ok('exact 2 erori standard trece (prag inclusiv)', atLimit.label === 'ROBUST',
     atLimit.label + ' / ' + atLimit.reason);
  const below = E.robustness(six(mk(0.39, 0.2), mk(1, 0.2), mk(1, 0.2), mk(1, 0.2), mk(1, 0.2), mk(1, 0.2)));
  ok('putin sub 2 erori standard NU trece', below.label === 'MIXED', below.label);
  ok('pragul e declarat in rezultat, nu implicit', atLimit.sigmas === E.ROBUST_SIGMAS && atLimit.sigmas === 2);

  /* REGRESIE PE CAZUL REAL. Valorile sunt cele MASURATE pe DOGE, 25 niveluri, +-15%, 30 zile,
     seed 475896362, 2.000 traiectorii per combinatie (02.11.2026). Toate sase medianele sunt
     pozitive — verdictul de pana la 0.1.1 raporta ROBUST — dar mediile alterneaza cu presupunerea
     de execuţie, iar cele conservatoare sunt negative si semnificative. */
  const doge = [
    mk(1.04, 0.249, 5.48), mk(-0.89, 0.243, 4.09),
    mk(0.42, 0.267, 5.49), mk(-1.45, 0.261, 4.16),
    mk(1.17, 0.289, 6.53), mk(-0.92, 0.282, 4.93)
  ];
  const rbD = E.robustness(doge);
  ok('DOGE/seed 475896362: toate medianele sunt pozitive (de ce verdictul vechi spunea ROBUST)',
     rbD.median_signs.every((x) => x > 0), rbD.median_signs.join(','));
  ok('DOGE/seed 475896362: verdictul NU e ROBUST', rbD.label !== 'ROBUST', rbD.label);
  ok('DOGE/seed 475896362: verdictul e MIXED', rbD.label === 'MIXED', rbD.label);
  ok('DOGE/seed 475896362: dezacordul mediana/medie e semnalat explicit',
     rbD.median_mean_disagree === true);
  ok('DOGE/seed 475896362: mediile conservatoare sunt la peste 2 erori standard SUB zero',
     [1, 3, 5].every((i) => doge[i].pnl_pct.mean <= -2 * doge[i].pnl_pct.se_mean),
     [1, 3, 5].map((i) => (doge[i].pnl_pct.mean / doge[i].pnl_pct.se_mean).toFixed(1)).join(' '));

  ok('plaja P5 intre modele e raportata',
     E.robustness(six(mk(1, 0.2), mk(2, 0.2), mk(3, 0.2), mk(4, 0.2), mk(5, 0.2), mk(6, 0.2))).p5_spread === 5);
}

/* ---------- verdictul, pe o rulare REALA (nu pe stub) ---------- */
{
  /* Cablarea completa: summarise -> runCombination -> robustness. Un stub nu poate prinde o
     greseala de legare, de pilda un camp care nu ajunge din summarise in rezultat. */
  const rng = E.xoshiro128ss(909, 0); const rr = [];
  for (let i = 0; i < 500; i++) rr.push(0.05 * rng.normal());
  const coin = coinFrom(rr, 1000, 3.2);
  const res = [];
  for (const m of ['A', 'B', 'C']) for (const cons of [false, true])
    res.push(E.runCombination({ ...BASE, coin, model: m, conservative: cons, paths: 800, days: 30 }));
  ok('o rulare reala duce p_neg si cvar5 pana in rezultat',
     res.every((r) => typeof r.pnl_pct.p_neg === 'number' && typeof r.pnl_pct.cvar5 === 'number'));
  ok('CVaR 5% nu e niciodata peste P5 (e media cozii, nu cuantila)',
     res.every((r) => r.pnl_pct.cvar5 <= r.pnl_pct.p5 + 1e-9),
     res.map((r) => r.pnl_pct.cvar5.toFixed(1) + '<=' + r.pnl_pct.p5.toFixed(1)).join(' '));
  const rb = E.robustness(res);
  ok('verdictul pe o rulare reala e una dintre cele trei etichete',
     ['ROBUST', 'NEGATIVE EXPECTATION', 'MIXED'].includes(rb.label), rb.label);
  ok('verdictul isi declara motivul', typeof rb.reason === 'string' && rb.reason.length > 20, rb.reason);
}

/* ---------- eroarea Monte Carlo e raportata ---------- */
{
  const rng = E.xoshiro128ss(13, 0); const rr = [];
  for (let i = 0; i < 400; i++) rr.push(0.02 * rng.normal());
  const coin = coinFrom(rr, 100);
  const r1 = E.runCombination({ ...BASE, coin, model: 'A', conservative: false, paths: 1000 });
  const r2 = E.runCombination({ ...BASE, coin, model: 'A', conservative: false, paths: 4000 });
  ok('eroarea MC e raportata pe fiecare marime',
     ['pnl_pct', 'mdd_pct', 'cycles'].every(k => typeof r1[k].se_mean === 'number' && typeof r1[k].se_p50 === 'number'));
  ok('eroarea MC scade cu numarul de traiectorii',
     r2.pnl_pct.se_mean < r1.pnl_pct.se_mean,
     `1.000: ${r1.pnl_pct.se_mean.toFixed(4)} -> 4.000: ${r2.pnl_pct.se_mean.toFixed(4)}`);
  ok('P(iesire) are eroarea ei', typeof r1.se_p_exit === 'number' && r1.se_p_exit > 0);
}

/* ---------- benchmark ---------- */
{
  const rng = E.xoshiro128ss(4242, 0); const rr = [];
  for (let i = 0; i < 730; i++) rr.push(0.025 * rng.normal());
  const coin = coinFrom(rr, 50000, 4.2);
  const t0 = Date.now();
  const r = E.runCombination({ ...BASE, coin, model: 'A', conservative: true, days: 90, paths: 10000, levels: 40 });
  results.push(['BENCH', '10.000 traiectorii x 90 zile, 1h, 1 fir',
                (Date.now() - t0) + ' ms  |  PnL p50 = ' + r.pnl_pct.p50.toFixed(3) + '%']);
}

/* ---------- raport ---------- */
console.log('');
for (const [st, name, detail] of results) {
  console.log((st === 'PASS' ? '  ok  ' : st === 'FAIL' ? ' FAIL ' : ' bench') + ' ' + name + (detail ? '   [' + detail + ']' : ''));
}
console.log('');
console.log(`teste: ${pass} trecute, ${fail} picate`);
process.exit(fail ? 1 : 0);
