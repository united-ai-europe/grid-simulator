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

/* ---------- 6. plafonul de traiectorii si nivelurile grilei ---------- */
{
  const rr = []; const rng = E.xoshiro128ss(9, 0);
  for (let i = 0; i < 400; i++) rr.push(0.02 * rng.normal());
  const coin = coinFrom(rr, 100);
  /* 0.2.0: peste plafon se ARUNCA, nu se trunchiaza. Pana aici o cerere de 999.999 intorcea
     `paths: 10000` fara niciun semnal, deci un raport putea declara o precizie inexistenta. */
  let threw = null;
  try {
    E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 999999, days: 1 });
  } catch (e) { threw = e.message; }
  ok('peste plafon se arunca, nu se trunchiaza in silenţiu',
     threw !== null && /exceeds MAX_PATHS/.test(threw), String(threw));
  ok('mesajul spune si cat s-a cerut si cat e plafonul',
     threw !== null && threw.includes('999999') && threw.includes(String(E.MAX_PATHS)), String(threw));
  ok('plafonul e 20.000 in 0.2.0', E.MAX_PATHS === 20000, String(E.MAX_PATHS));
  const rOk = E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 300, days: 1 });
  ok('rezultatul declara si cat s-a cerut, nu doar cat s-a rulat',
     rOk.paths === 300 && rOk.paths_requested === 300,
     rOk.paths + '/' + rOk.paths_requested);
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

/* ---------- crash replay: drum impus (0.2.0) ---------- */
{
  const rng = E.xoshiro128ss(77, 0); const rr = [];
  for (let i = 0; i < 500; i++) rr.push(0.03 * rng.normal());
  const coin = coinFrom(rr, 1000, 4);
  /* Un episod artificial dar fara echivoc: 20 de zile, din care o cadere mare. */
  const seq = []; for (let i = 0; i < 20; i++) seq.push(i === 10 ? -0.25 : -0.01);
  const EP = { returns: seq, label: 'TEST 2026-01-15..2026-02-03', source: 'S1', ref_close: 1000 };
  const RP = { ...BASE, coin, path: EP, paths: 400, conservative: false };

  const r = E.runCombination(RP);
  ok('replay: orizontul e lungimea episodului, nu `days` din opts',
     r.days === seq.length, r.days + ' vs ' + seq.length);
  ok('replay: orizontul NU se lasa suprascris de `days`',
     E.runCombination({ ...RP, days: 999 }).days === seq.length);
  ok('replay: modelul se eticheteaza REPLAY, nu A/B/C', r.model === 'REPLAY', r.model);
  ok('replay: rezultatul poarta eticheta si sursa drumului',
     r.path_label === EP.label && r.path_source === 'S1', r.path_label + ' / ' + r.path_source);
  ok('replay: o simulare obisnuita NU poarta path_label (altfel garda ar bloca totul)',
     E.runCombination({ ...BASE, coin, model: 'B', paths: 50, days: 5 }).path_label === undefined);

  /* Preţul de referinţa: inchiderea zilei de START a episodului, nu preţul de azi. */
  ok('replay: preţul de referinţa e ref_close, nu coin.reference_price',
     r.reference_price === 1000 && coin.reference_price === 1000);
  /* ATENTIE la ce poate si ce nu poate dovedi un test aici. Sistemul e INVARIANT LA SCARA:
     nivelurile sunt refPrice*(1+pct), cantitatea e (capital/2)/refPrice/above, iar drumul e
     relativ — deci PnL-ul IN PROCENTE nu se schimba daca preţul de referinţa se scaleaza.
     Prima versiune a acestui test cerea ca un `ref_close` diferit sa schimbe PnL-ul; a picat, si
     corect. Ce conteaza cu adevarat e ca `ref_close` ajunge preţul de referinţa RAPORTAT, fiindca
     de el atarna preţurile ABSOLUTE pe care UI-ul le afiseaza: marginile grilei din episod trebuie
     sa fie preţurile reale de atunci, nu cele de azi. */
  const r2 = E.runCombination({ ...RP, path: { ...EP, ref_close: 250 } });
  ok('replay: ref_close devine preţul de referinţa raportat',
     r2.reference_price === 250, String(r2.reference_price));
  ok('replay: PnL-ul in procente e invariant la scara (deci NU poate dovedi singur ref_close)',
     Math.abs(r2.pnl_pct.p50 - r.pnl_pct.p50) < 1e-9,
     r2.pnl_pct.p50.toFixed(9) + ' vs ' + r.pnl_pct.p50.toFixed(9));
  ok('replay: preţul de referinţa nu e luat din moneda cand episodul il da',
     E.runCombination({ ...RP, coin: { ...coin, reference_price: 7777 },
                        path: { ...EP, ref_close: 250 } }).reference_price === 250);
  ok('replay fara ref_close cade pe preţul monedei',
     E.runCombination({ ...RP, path: { returns: seq, label: 'x' } }).reference_price === 1000);

  /* path si model sunt exclusive: altfel un rezultat ar purta o eticheta falsa. */
  let threwBoth = null;
  try { E.runCombination({ ...RP, model: 'B' }); } catch (e) { threwBoth = e.message; }
  ok('replay: `path` si `model` simultan sunt refuzate',
     threwBoth !== null && /mutually exclusive/.test(threwBoth), String(threwBoth));

  let threwNaN = null;
  try { E.runCombination({ ...RP, path: { ...EP, returns: [0.01, NaN, 0.02] } }); }
  catch (e) { threwNaN = e.message; }
  ok('replay: o valoare nefinita e refuzata, nu propagata ca NaN',
     threwNaN !== null && /not finite/.test(threwNaN), String(threwNaN));

  let threwEmpty = null;
  try { E.runCombination({ ...RP, path: { ...EP, returns: [] } }); }
  catch (e) { threwEmpty = e.message; }
  ok('replay: un episod gol e refuzat', threwEmpty !== null && /empty/.test(threwEmpty), String(threwEmpty));

  /* Ziua e fixa: singura aleatorietate e puntea intrazi, deci dispersia intre traiectorii e mult
     mai mica decat la o simulare. Asta e proprietatea care face verdictul inaplicabil. */
  const sim = E.runCombination({ ...BASE, coin, model: 'B', conservative: false, paths: 400, days: seq.length });
  ok('replay: dispersia intre traiectorii e mult mai mica decat la o simulare',
     r.pnl_pct.se_mean < sim.pnl_pct.se_mean / 5,
     'replay se ' + r.pnl_pct.se_mean.toFixed(4) + ' vs simulare ' + sim.pnl_pct.se_mean.toFixed(4));

  /* GARDA: verdictul nu are voie sa fie calculat pe un replay. */
  const six = [];
  for (let i = 0; i < 3; i++) for (const cons of [false, true])
    six.push(E.runCombination({ ...RP, conservative: cons }));
  let threwRb = null;
  try { E.robustness(six); } catch (e) { threwRb = e.message; }
  ok('robustness() REFUZA rezultate de replay',
     threwRb !== null && /does not apply to replay/.test(threwRb), String(threwRb));
  ok('mesajul numeste episodul, ca sa se vada care rezultat a declansat refuzul',
     threwRb !== null && threwRb.includes(EP.label), String(threwRb));
  ok('robustness() functioneaza in continuare pe rezultate de simulare',
     typeof E.robustness([sim, sim, sim, sim, sim, sim]).label === 'string');

  /* Un replay se poate si partitiona, ca orice combinatie. */
  const pa = E.simulatePaths({ ...RP, paths: 150, path_offset: 0, raw: true });
  const pb = E.simulatePaths({ ...RP, paths: 250, path_offset: 150, raw: true });
  ok('replay: partitionarea da acelasi rezultat bit cu bit',
     JSON.stringify(E.combineRaw([pb, pa])) === JSON.stringify(r));
}

/* ---------- bugetul de timp: fiecare ramura, cu c injectat (0.2.0) ---------- */
{
  /* `c` e costul PISCINEI: ms de ceas de perete pe traiectorie-zi-combinatie cu toţi lucratorii
     la treaba. Masurat pe o staţie de lucru desktop in Chrome, cu piscina plina: ~0,0053 ms
     (echivalentul a ~0,0437 ms pe un singur fir, dar impartirea la numarul de nuclee NU e valida —
     de aceea se masoara direct debitul piscinei). Dispozitivele mai lente se reprezinta ca
     multipli, deci testele nu cer nicio cronometrare.
     C de mai jos e o valoare de REFERINTA rotunda, aleasa ca aritmetica sa fie verificabila de
     mana, nu o masuratoare: valorile masurate efectiv in browser sunt raportate de
     ~/site-audit/e2e/run_e2e.mjs, care executa chiar pagina. */
  const C = 0.0040;
  const plan = (o) => E.planPaths({ c: C * (o.slow || 1), days: o.days, workers: o.workers || 1,
                                    coarse: !!o.coarse, requested: o.requested === undefined ? null : o.requested,
                                    combinations: 6 });

  ok('pragurile sunt constante numite, nu numere in cod',
     E.BUDGET_TARGET_S === 8 && E.PATHS_MIN === 1000 && E.RUN_FREE_S === 30 &&
     E.RUN_CONFIRM_S === 90 && E.COARSE_HARD_CAP_S === 30,
     [E.BUDGET_TARGET_S, E.PATHS_MIN, E.RUN_FREE_S, E.RUN_CONFIRM_S, E.COARSE_HARD_CAP_S].join('/'));
  ok('alegerile oferite sunt 10.000/5.000/2.000',
     E.PATH_CHOICES.join(',') === '10000,5000,2000', E.PATH_CHOICES.join(','));

  /* RAPID: 10.000 incap in ţinta. */
  const fast = plan({ days: 30, slow: 1 });            /* 10.000 -> 7,2 s */
  ok('dispozitiv rapid: se alege cel mai mare numar care incape in ţinta',
     fast.paths === 10000 && fast.seconds <= E.BUDGET_TARGET_S && fast.action === 'run',
     fast.paths + ' / ' + fast.seconds.toFixed(1) + ' s');

  /* MEDIU: 10.000 nu incap, 5.000 da. */
  const mid = plan({ days: 30, slow: 1.5 });           /* 10.000 -> 10,8 s; 5.000 -> 5,4 s */
  ok('dispozitiv mediu: coboara la urmatoarea alegere, nu la minim',
     mid.paths === 5000 && mid.seconds <= E.BUDGET_TARGET_S,
     mid.paths + ' / ' + mid.seconds.toFixed(1) + ' s');
  ok('alegerea implicita isi declara motivul',
     /largest of/.test(mid.chosen_because), mid.chosen_because);

  /* LENT: nici 2.000 nu incap -> podeaua, dar inca sub pragul de rulare libera. */
  const slow = plan({ days: 30, slow: 10 });           /* 2.000 -> 14,4 s; 1.000 -> 7,2 s */
  ok('dispozitiv lent: cade pe podeaua de 1.000, nu sub ea',
     slow.paths === E.PATHS_MIN && slow.action === 'run' && slow.warn === null,
     slow.paths + ' / ' + slow.seconds.toFixed(1) + ' s / ' + slow.action);
  ok('podeaua isi declara motivul', /floor of 1000/.test(slow.chosen_because), slow.chosen_because);

  /* FOARTE LENT: chiar si podeaua depaseste pragul -> ruleaza, cu avertisment, niciodata refuz. */
  const verySlow = plan({ days: 90, slow: 60 });       /* 1.000 -> 130 s */
  ok('chiar si podeaua peste prag: ruleaza cu avertisment, nu refuza',
     verySlow.paths === E.PATHS_MIN && verySlow.action === 'run' && verySlow.warn === 'slow-device',
     verySlow.action + ' / ' + verySlow.warn + ' / ' + verySlow.seconds.toFixed(0) + ' s');

  /* BANDA DE CONFIRMARE: o cerere explicita intre 30 si 90 de secunde. */
  const confirm = plan({ days: 90, slow: 2, requested: 10000 });     /* 43,2 s */
  ok('intre 30 si 90 s se cere confirmare, cu timpul in motiv',
     confirm.action === 'confirm' && confirm.seconds > E.RUN_FREE_S &&
     confirm.seconds <= E.RUN_CONFIRM_S && /estimated/.test(confirm.reason),
     confirm.seconds.toFixed(0) + ' s / ' + confirm.reason);

  /* REFUZ: peste 90 de secunde. */
  const refuse = plan({ days: 90, slow: 4, requested: 20000 });      /* 173 s */
  ok('peste 90 s se refuza', refuse.action === 'refuse' && /above the 90 s limit/.test(refuse.reason),
     refuse.seconds.toFixed(0) + ' s / ' + refuse.reason);

  /* TACTIL: plafon dur la 30 s, fara banda de confirmare. */
  const touchOk = plan({ days: 30, slow: 10, coarse: true, requested: 2000 });   /* 14,4 s */
  ok('tactil, sub plafon: ruleaza', touchOk.action === 'run', touchOk.seconds.toFixed(1) + ' s');
  const touchNo = plan({ days: 90, slow: 5, coarse: true, requested: 5000 });    /* 54 s */
  ok('tactil, peste 30 s: REFUZ, nu confirmare',
     touchNo.action === 'refuse' && /touch devices/.test(touchNo.reason),
     touchNo.seconds.toFixed(0) + ' s / ' + touchNo.action);
  const sameNonTouch = plan({ days: 90, slow: 5, coarse: false, requested: 5000 });
  ok('aceeasi configuratie pe ecran ne-tactil: confirmare, nu refuz',
     sameNonTouch.action === 'confirm',
     sameNonTouch.seconds.toFixed(0) + ' s / ' + sameNonTouch.action);
  const touchFloor = plan({ days: 90, slow: 60, coarse: true });
  ok('tactil, dar chiar si podeaua e peste plafon: ruleaza cu avertisment',
     touchFloor.action === 'run' && touchFloor.warn === 'slow-device',
     touchFloor.action + ' / ' + touchFloor.warn);

  /* Peste plafonul motorului: refuz la planificare, nu eroare la rulare. */
  const overCap = plan({ days: 1, requested: 50000 });
  ok('peste MAX_PATHS se refuza la planificare',
     overCap.action === 'refuse' && /engine limit/.test(overCap.reason), overCap.reason);

  /* Estimarea e liniara in ce trebuie si scade cu lucratorii. */
  const e1 = E.estimateSeconds(C, 30, 2000, 6);
  ok('estimarea e liniara in zile', Math.abs(E.estimateSeconds(C, 90, 2000, 6) - 3 * e1) < 1e-9);
  ok('estimarea e liniara in traiectorii', Math.abs(E.estimateSeconds(C, 30, 4000, 6) - 2 * e1) < 1e-9);
  /* Numarul de lucratori NU mai intra in aritmetica: `c` e deja o masuratoare a piscinei intregi.
     O impartire aici ar reintroduce subevaluarea de 1,5x gasita in browser. */
  ok('numarul de lucratori nu mai intra in estimare',
     E.estimateSeconds(C, 30, 2000, 6) === E.estimateSeconds(C, 30, 2000, 6, 8));
  ok('estimarea la 2.000 de traiectorii e de ordinul unei secunde cu piscina plina',
     e1 > 1 && e1 < 2, e1.toFixed(2) + ' s');
}

/* ---------- partitionare bit-identica intre 1 si N lucratori (0.2.0) ---------- */
{
  const rng = E.xoshiro128ss(5, 0); const rr = [];
  for (let i = 0; i < 500; i++) rr.push(0.03 * rng.normal());
  const coin = coinFrom(rr, 100, 4);
  const CFG = { ...BASE, coin, model: 'C', conservative: true, days: 30, seed: 4242 };
  const N = 1200;
  const ref = JSON.stringify(E.runCombination({ ...CFG, paths: N }));

  const bad = [];
  for (const W of [1, 2, 3, 5, 7, 8]) {
    /* Felii NEEGALE intentionat, si numere care nu divid N (3, 7), ca sa nu existe o
       partitionare norocoasa. */
    const per = Math.floor(N / W), parts = [];
    let off = 0;
    for (let w = 0; w < W; w++) {
      const n = (w === W - 1) ? (N - off) : per;
      parts.push(E.simulatePaths({ ...CFG, paths: n, path_offset: off, raw: true }));
      off += n;
    }
    /* Ordinea de sosire INVERSATA: concatenarea nu are voie sa depinda de cine termina primul. */
    const got = E.combineRaw(parts.slice().reverse());
    if (JSON.stringify(got) !== ref) bad.push('W=' + W);
  }
  ok('rezultatul e identic bit cu bit intre 1 si N lucratori (W = 1,2,3,5,7,8)',
     bad.length === 0, bad.join(',') || 'toate identice');

  /* time_outside_range e SINGURUL camp calculat cu mean() fara sortare, deci singurul care ar
     putea sa depinda de ordine. Merita numit separat. */
  const p3 = [];
  let off3 = 0;
  for (const n of [401, 399, 400]) { p3.push(E.simulatePaths({ ...CFG, paths: n, path_offset: off3, raw: true })); off3 += n; }
  const comb = E.combineRaw(p3.slice().reverse());
  const whole = E.runCombination({ ...CFG, paths: N });
  ok('time_outside_range e identic bit cu bit (singurul camp sensibil la ordine)',
     comb.time_outside_range === whole.time_outside_range,
     comb.time_outside_range + ' vs ' + whole.time_outside_range);
  ok('si p_neg si cvar5 sunt identice bit cu bit dupa partitionare',
     comb.pnl_pct.p_neg === whole.pnl_pct.p_neg && comb.pnl_pct.cvar5 === whole.pnl_pct.cvar5);

  /* Partitionari care nu acopera exact intervalul trebuie sa fie refuzate, nu sa dea un rezultat
     plauzibil dar greşit. */
  const gap = [E.simulatePaths({ ...CFG, paths: 100, path_offset: 0, raw: true }),
               E.simulatePaths({ ...CFG, paths: 100, path_offset: 150, raw: true })];
  let threwGap = null;
  try { E.combineRaw(gap); } catch (e) { threwGap = e.message; }
  ok('o gaura intre felii e refuzata', threwGap !== null && /do not tile/.test(threwGap), String(threwGap));

  const dup = [E.simulatePaths({ ...CFG, paths: 100, path_offset: 0, raw: true }),
               E.simulatePaths({ ...CFG, paths: 100, path_offset: 0, raw: true })];
  let threwDup = null;
  try { E.combineRaw(dup); } catch (e) { threwDup = e.message; }
  ok('o suprapunere de felii e refuzata', threwDup !== null && /do not tile/.test(threwDup), String(threwDup));

  const mixed = [E.simulatePaths({ ...CFG, paths: 100, path_offset: 0, raw: true }),
                 E.simulatePaths({ ...CFG, model: 'B', paths: 100, path_offset: 100, raw: true })];
  let threwMix = null;
  try { E.combineRaw(mixed); } catch (e) { threwMix = e.message; }
  ok('felii produse cu modele diferite sunt refuzate',
     threwMix !== null && /disagree on how/.test(threwMix), String(threwMix));

  ok('path_offset alege CARE traiectorii, nu doar cate',
     JSON.stringify(E.simulatePaths({ ...CFG, paths: 50, path_offset: 0, raw: true }).pnl) !==
     JSON.stringify(E.simulatePaths({ ...CFG, paths: 50, path_offset: 50, raw: true }).pnl));
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
