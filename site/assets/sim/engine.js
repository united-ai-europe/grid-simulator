/* iScanTrust — grid simulation engine. Pure JavaScript, no dependencies, no network.
 *
 * Runs identically in a Web Worker and in Node (for the test suite).
 * Everything is deterministic given (seed, path index): the same seed reproduces the same run.
 *
 * ---------------------------------------------------------------------------------------------
 * Intraday price path (rewritten 2026-11-01 after external audit findings A-01 / A-02).
 *
 * The previous version added, at each sub-step, an independent normal with the *marginal* variance
 * of a Brownian bridge. The marginals looked right but the increments were independent, so the path
 * had unbounded variation: the number of level crossings — and therefore cycles and PnL — grew
 * without limit as the sub-step shrank. Reported figures were an artefact of an arbitrary
 * discretisation parameter.
 *
 * What it does now. Within each day the path is a genuine Brownian bridge between the two daily
 * closes, sampled sequentially, and for every segment of that bridge the running MINIMUM and
 * MAXIMUM are drawn from their exact closed-form distributions rather than inferred from the
 * endpoints:
 *
 *     max of a bridge u -> v over duration tau, volatility s:
 *         M = ( u + v + sqrt( (v-u)^2 - 2 s^2 tau ln U ) ) / 2 ,  U ~ Uniform(0,1)
 *     min: the same with a minus sign before the square root.
 *
 * So a coarse step still sees the full range the price actually covered inside that step; the
 * extremes do not have to be rediscovered by subdividing. That is what makes the result converge
 * in step size instead of diverging. The remaining step dependence — repeated oscillations inside
 * one segment — is measured, not assumed: tools/convergence_test.mjs reports the figures at 24h,
 * 4h, 1h and 15min against the Monte Carlo error.
 *
 * Declared, and not verifiable from daily data (UNVERIFIED):
 *   - the order in which the minimum and the maximum are reached inside a segment. The convention
 *     is: a segment that ends higher than it started goes down to its minimum first; one that ends
 *     lower goes up to its maximum first.
 *   - the minimum and the maximum of a segment are drawn independently. They are in fact weakly
 *     dependent; the approximation is good while the segment's volatility is small next to the
 *     distance between the endpoints and is declared rather than hidden.
 *
 * Other declared conventions: the grid is spot, without leverage, initialised half cash and half
 * asset at the reference price; levels are spaced geometrically; the order size is the initial
 * inventory divided by the number of levels above the reference price. No model carries a trend.
 */

'use strict';

/* ------------------------------------------------------------------ PRNG */

function splitmix32(a) {
  return function () {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0);
  };
}

function xoshiro128ss(seed, stream) {
  const sm = splitmix32((seed ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0);
  let s0 = sm(), s1 = sm(), s2 = sm(), s3 = sm();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
  function next() {
    const r = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t;
    s3 = rotl(s3, 11);
    return r;
  }
  const rng = {
    u32: next,
    f64: function () { return (next() + 0.5) * 2.3283064365386963e-10; },
    int: function (n) { return next() % n; },
    normal: null
  };
  let spare = null;
  rng.normal = function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, s;
    do { u = rng.f64() * 2 - 1; v = rng.f64() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  };
  rng.gamma = function (shape) {
    if (shape < 1) return rng.gamma(shape + 1) * Math.pow(rng.f64(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, w;
      do { x = rng.normal(); w = 1 + c * x; } while (w <= 0);
      w = w * w * w;
      const u = rng.f64(), x2 = x * x;
      if (u < 1 - 0.0331 * x2 * x2) return d * w;
      if (Math.log(u) < 0.5 * x2 + d * (1 - w + Math.log(w))) return d * w;
    }
  };
  rng.studentT = function (nu) {
    const g = rng.gamma(nu / 2) * 2;
    return rng.normal() / Math.sqrt(g / nu);
  };
  return rng;
}

/* ------------------------------------------------------------------ statistics */

function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

const QS = [0.05, 0.25, 0.5, 0.75, 0.95];

/* Monte Carlo error, reported next to every figure so a difference between two runs can be judged
 * against it. The median gets a distribution-free interval from order statistics (no normality
 * assumed); the mean gets the usual standard error. */
function summarise(values) {
  const n = values.length;
  const s = Float64Array.from(values); s.sort();
  const out = {};
  for (const q of QS) out['p' + Math.round(q * 100)] = quantileSorted(s, q);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = s[i] - mean; v += d * d; }
  const sd = Math.sqrt(v / Math.max(1, n - 1));
  out.mean = mean;
  out.sd = sd;
  out.se_mean = sd / Math.sqrt(n);
  /* 95% interval for the median from the binomial order statistics */
  const half = 1.959963985 * Math.sqrt(n) / 2;
  const lo = Math.max(0, Math.floor(n / 2 - half));
  const hi = Math.min(n - 1, Math.ceil(n / 2 + half));
  out.p50_lo = s[lo];
  out.p50_hi = s[hi];
  out.se_p50 = (s[hi] - s[lo]) / (2 * 1.959963985);
  /* Probabilitatea de pierdere si media celei mai rele cozi de 5% (CVaR, numita si Expected
     Shortfall). Ambele se citesc din tabloul DEJA SORTAT, deci rezultatul nu depinde de ordinea in
     care au venit traiectoriile — aceeasi proprietate pe care se bazeaza partitionarea pe mai
     multi lucratori.
     De ce exista: pana la 0.1.1 rezultatul raporta mediana si P5, iar verdictul se uita doar la
     semnul medianei. Pe DOGE, 25 niveluri, +-15%, 30 zile, mediana era +4..+6% in toate cele sase
     combinatii — dar in cele trei conservatoare MEDIA era negativa, si o treime din traiectorii
     pierdeau bani. Mediana singura nu poate arata asta. */
  let neg = 0;
  for (let i = 0; i < n; i++) if (s[i] < 0) neg++; else break;   /* sortat crescator */
  out.p_neg = n ? neg / n : NaN;
  const k5 = Math.max(1, Math.round(0.05 * n));
  let tail = 0;
  for (let i = 0; i < k5; i++) tail += s[i];
  out.cvar5 = k5 ? tail / k5 : NaN;
  out.cvar5_n = k5;
  return out;
}

function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }

/* Maximum drawdown measured from the RUNNING PEAK, not from the starting value.
 * A path that rises 25% and then falls 18% has a drawdown of -18%, not 0. */
function maxDrawdownFromPeak(series) {
  let peak = -Infinity, mdd = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = v / peak - 1;
      if (dd < mdd) mdd = dd;
    }
  }
  return mdd;
}

/* ------------------------------------------------------------------ price models
 *
 * Every model returns { gen, sd }: a generator of daily log returns and the daily standard
 * deviation that the intraday bridge must use. The bridge volatility used to be the empirical sd
 * for all three models, which erased the models' disagreement on everything driven by intraday
 * movement — cycles came out identical to the decimal for A, B and C (audit A-05).
 */

/* Model A — block bootstrap of the observed daily log returns.
 *
 * A block may start at any s in [0, n-L], so return i is drawn with multiplicity
 * w_i = #{s : s <= i <= s+L-1}: L in the interior, fewer at the two ends. Centring on the
 * UNWEIGHTED mean therefore left a systematic drift (audit A-04: positive on all 30 coins).
 * The pool is centred on the weighted mean, so the generated path has exactly zero expected drift.
 */
function makeBootstrap(returns, segmentStarts, blockLen) {
  const n = returns.length;
  const breaks = new Uint8Array(n);
  for (const b of segmentStarts) if (b > 0 && b < n) breaks[b] = 1;
  const starts = [];
  for (let i = 0; i + blockLen <= n; i++) {
    let okStart = true;
    for (let k = 1; k < blockLen; k++) if (breaks[i + k]) { okStart = false; break; }
    if (okStart) starts.push(i);
  }
  if (starts.length === 0) for (let i = 0; i + blockLen <= n; i++) starts.push(i);
  const startArr = Int32Array.from(starts);

  const w = new Float64Array(n);
  for (let k = 0; k < startArr.length; k++) {
    for (let j = 0; j < blockLen; j++) w[startArr[k] + j] += 1;
  }
  let wsum = 0, wdot = 0;
  for (let i = 0; i < n; i++) { wsum += w[i]; wdot += w[i] * returns[i]; }
  const muW = wsum > 0 ? wdot / wsum : 0;

  const centred = new Float64Array(n);
  for (let i = 0; i < n; i++) centred[i] = returns[i] - muW;

  /* daily sd of what this model actually emits, weighted the same way */
  let v = 0;
  for (let i = 0; i < n; i++) v += w[i] * centred[i] * centred[i];
  const sd = Math.sqrt(wsum > 0 ? v / wsum : 0);

  return {
    sd: sd,
    weightedMean: muW,
    gen: function (rng, out, days) {
      let k = 0;
      while (k < days) {
        const s = startArr[rng.int(startArr.length)];
        for (let j = 0; j < blockLen && k < days; j++, k++) out[k] = centred[s + j];
      }
    }
  };
}

/* Model B — gaussian with the observed standard deviation, zero mean. */
function makeGaussian(returns) {
  const mu = mean(returns);
  let v = 0;
  for (let i = 0; i < returns.length; i++) { const d = returns[i] - mu; v += d * d; }
  const sd = Math.sqrt(v / Math.max(1, returns.length - 1));
  return { sd: sd, gen: function (rng, out, days) { for (let k = 0; k < days; k++) out[k] = sd * rng.normal(); } };
}

/* Model C — Student-t with the degrees of freedom estimated by maximum likelihood on the same
 * returns. Heavy tails measured, not assumed. The daily sd implied by the fit is scale*sqrt(df/(df-2)),
 * which is what the intraday bridge uses. NOTE: this model has heavy tails but contains no crash
 * scenario; see the note carried in the UI. */
function makeStudentT(df, scale) {
  const sd = df > 2 ? scale * Math.sqrt(df / (df - 2)) : scale;
  return { sd: sd, gen: function (rng, out, days) { for (let k = 0; k < days; k++) out[k] = scale * rng.studentT(df); } };
}

/* ------------------------------------------------------------------ grid */

function buildLevels(lo, hi, n) {
  const L = new Float64Array(n);
  if (n === 1) { L[0] = lo; return L; }
  const r = Math.pow(hi / lo, 1 / (n - 1));
  L[0] = lo;
  for (let i = 1; i < n; i++) L[i] = L[i - 1] * r;
  L[n - 1] = hi;
  return L;
}

const SIDE_NONE = 0, SIDE_BUY = 1, SIDE_SELL = 2;

/* Exact extremes of a Brownian bridge from u to v over duration tau with volatility s (log space). */
function bridgeMax(u, v, s2tau, rng) {
  const d = v - u;
  return 0.5 * (u + v + Math.sqrt(d * d - 2 * s2tau * Math.log(rng.f64())));
}
function bridgeMin(u, v, s2tau, rng) {
  const d = v - u;
  return 0.5 * (u + v - Math.sqrt(d * d - 2 * s2tau * Math.log(rng.f64())));
}

/* ------------------------------------------------------------------ one path */

function runPath(cfg, rng, dailyBuf) {
  const { levels, qty, feeRate, deltaStar, conservative, refPrice, capital, stepsPerDay, days, sd } = cfg;
  const nL = levels.length;
  const lowB = levels[0], highB = levels[nL - 1];

  let cash = capital / 2;
  let inv = (capital / 2) / refPrice;
  const invAtStart = inv;

  const slot = new Uint8Array(nL);
  const fromBuy = new Uint8Array(nL);
  for (let i = 0; i < nL; i++) slot[i] = levels[i] < refPrice ? SIDE_BUY : (levels[i] > refPrice ? SIDE_SELL : SIDE_NONE);

  let cycles = 0, feesPaid = 0, missedBuys = 0;
  let outsideSamples = 0, totalSamples = 0, everOutside = 0;
  /* Profit realised by completed cycles. The conservative haircut is applied to it continuously,
   * so the equity series the drawdown is read from is the SAME series the final PnL comes from
   * (audit A-06: they used to be two different trajectories). */
  let realisedCycleProfit = 0;
  const haircut = conservative ? (1 - cfg.cycleRatio) : 0;

  cfg.model(rng, dailyBuf, days);

  const eq = [];
  function equity(p) { return cash + inv * p - haircut * realisedCycleProfit; }
  let price = refPrice;
  eq.push(equity(refPrice));

  const dt = 1 / stepsPerDay;
  const s2dt = sd * sd * dt;

  /* ---- fills, driven only by the price the path has actually reached ----
   *
   * A pending order fills when the price reaches its level (optimistic) or passes it by at least
   * delta* (conservative). The test is on the price alone: a level is NOT consumed by being
   * crossed, and it is not forgotten once the move that crossed it has ended. That is what audit
   * A-02 found missing — the old rule only looked at the sub-step that happened to straddle the
   * level, so on a smooth path the conservative mode never fired and then reported better numbers
   * than the optimistic one because it had sold nothing.
   *
   * Because the rule depends only on the extremes the path reached, and the extremes are drawn
   * exactly, the outcome stops being a function of how finely the day is chopped up.
   */
  function fillBuys(pLow) {
    const trigger = conservative ? pLow / (1 - deltaStar) : pLow;
    for (let i = nL - 1; i >= 0; i--) {
      const lv = levels[i];
      if (lv < trigger) break;                 /* levels ascend: nothing deeper qualifies */
      if (slot[i] !== SIDE_BUY) continue;
      const cost = qty * lv * (1 + feeRate);
      if (cash < cost) { missedBuys++; continue; }
      cash -= cost; inv += qty; feesPaid += qty * lv * feeRate;
      slot[i] = SIDE_NONE;
      if (i + 1 < nL) { slot[i + 1] = SIDE_SELL; fromBuy[i + 1] = 1; }
    }
  }

  function fillSells(pHigh) {
    const trigger = conservative ? pHigh / (1 + deltaStar) : pHigh;
    for (let i = 0; i < nL; i++) {
      const lv = levels[i];
      if (lv > trigger) break;
      if (slot[i] !== SIDE_SELL) continue;
      if (inv < qty * (1 - 1e-9)) continue;
      const q = inv < qty ? inv : qty;
      cash += q * lv * (1 - feeRate); inv -= q; feesPaid += q * lv * feeRate;
      slot[i] = SIDE_NONE;
      if (fromBuy[i]) {
        const buyLv = levels[i - 1];
        cycles++;
        realisedCycleProfit += q * (lv * (1 - feeRate) - buyLv * (1 + feeRate));
        fromBuy[i] = 0;
      }
      if (i - 1 >= 0) slot[i - 1] = SIDE_BUY;
    }
  }

  for (let d = 0; d < days; d++) {
    const r = dailyBuf[d];
    const closeNext = price * Math.exp(r);
    let lnPrev = Math.log(price);
    const lnEnd = Math.log(closeNext);

    for (let s = 1; s <= stepsPerDay; s++) {
      /* sequential Brownian bridge: the next point, conditional on where we are and on the close */
      let lnNow;
      if (s === stepsPerDay) {
        lnNow = lnEnd;
      } else {
        const remaining = 1 - (s - 1) * dt;
        const m = lnPrev + (lnEnd - lnPrev) * (dt / remaining);
        const varc = sd * sd * dt * (remaining - dt) / remaining;
        lnNow = m + (varc > 0 ? Math.sqrt(varc) * rng.normal() : 0);
      }

      /* exact extremes of this segment */
      const segHi = bridgeMax(lnPrev, lnNow, s2dt, rng);
      const segLo = bridgeMin(lnPrev, lnNow, s2dt, rng);
      const pA = Math.exp(lnPrev), pB = Math.exp(lnNow);
      const pHi = Math.exp(segHi), pLo = Math.exp(segLo);

      /* declared ordering: a segment that ends higher goes down first, one that ends lower goes up first */
      /* Equity is sampled at the segment's EXTREMES as well as at its close. The drawdown is a
       * running-extremum statistic: read only at segment ends it keeps creeping deeper as the step
       * shrinks, because a finer grid of sample points finds more of the true low. The extremes are
       * known exactly here, so sampling them makes the drawdown stop depending on the step too. */
      if (pB >= pA) {
        fillBuys(pLo); eq.push(equity(pLo));
        fillSells(pHi); eq.push(equity(pHi));
        fillBuys(pB);
      } else {
        fillSells(pHi); eq.push(equity(pHi));
        fillBuys(pLo); eq.push(equity(pLo));
        fillSells(pB);
      }

      /* time outside the grid, measured on the segment's range rather than on its endpoints */
      totalSamples++;
      if (pLo < lowB || pHi > highB) { outsideSamples++; everOutside = 1; }

      lnPrev = lnNow;
      eq.push(equity(pB));
    }
    price = closeNext;
  }

  const finalEq = equity(price);
  const netPnl = finalEq - capital;

  return {
    pnlPct: 100 * netPnl / capital,
    mddPct: 100 * maxDrawdownFromPeak(eq),
    outside: everOutside,
    outsideFrac: outsideSamples / totalSamples,
    cycles: conservative ? cycles * cfg.cycleRatio : cycles,
    finalInvPct: 100 * inv * price / capital,
    fees: feesPaid,
    missedBuys: missedBuys,
    invAtStart: invAtStart
  };
}

/* ------------------------------------------------------------------ public API */

/* 0.2.0: ridicat de la 10.000. Peste plafon NU se mai trunchiaza in silenţiu — vezi
   `paths_requested` si eroarea din simulatePaths. Pana la 0.2.0, o cerere de 20.000 intorcea
   `paths: 10000` fara niciun semnal, deci un raport putea declara o precizie pe care nu o avea. */
const MAX_PATHS = 20000;
const BLOCK_DAYS = 5;

/* Intraday resolution. Fixed, not adapted to the device.
 *
 * Audit A-03: the step used to drop from 1h to 4h when the machine looked slow, so the same
 * configuration and the same seed produced different numbers on a desktop and on a phone. With the
 * corrected path the result is stable in the step above this resolution (tools/convergence_test.mjs),
 * but the only honest way to make the figure independent of the hardware is to stop letting the
 * hardware choose it. Anything coarser is refused; the only knob left that affects precision is the
 * number of paths, whose effect is reported as the Monte Carlo error next to every figure.
 *
 * 24 steps/day = 1 hour. Below 2h the figures stop moving by more than the Monte Carlo error; 1h is
 * one notch finer than that, as margin. */
const STEPS_PER_DAY = 24;
const MIN_STEPS_PER_DAY = 24;

function makeModel(name, coin) {
  if (typeof name === 'object' && name && name.gen) return name;     /* injected by the tests */
  const r = coin.log_returns;
  if (name === 'A') return makeBootstrap(r, coin.segment_starts || [0], BLOCK_DAYS);
  if (name === 'B') return makeGaussian(r);
  if (name === 'C') return makeStudentT(coin.student_t.df, coin.student_t.scale);
  throw new Error('unknown model: ' + name);
}

function empiricalSd(returns) {
  const mu = mean(returns);
  let v = 0;
  for (let i = 0; i < returns.length; i++) { const d = returns[i] - mu; v += d * d; }
  return Math.sqrt(v / Math.max(1, returns.length - 1));
}

/* ------------------------------------------------- bugetul de timp al unei rulari
 *
 * Costul e LINIAR in zile si in traiectorii, masurat: 1,307 ms pe traiectorie-combinatie la 30 de
 * zile si 3,936 la 90 (raport 2,97 pentru un orizont de 3,0), si plat intre 1.000 si 10.000 de
 * traiectorii. Deci costul total e `c · zile · traiectorii · combinatii`, cu o singura constanta
 * `c` de masurat. Pe aceasta masina c ≈ 0,0437 ms; pe dispozitivul vizitatorului se MASOARA la
 * fiecare incarcare a paginii, printr-o rulare scurta de calibrare, si nu se memoreaza nicaieri —
 * nici in localStorage, nici in sessionStorage — ca promisiunea "nu stocam nimic despre vizitator"
 * de pe /verify/ sa rămână literal adevarata.
 *
 * Pragurile sunt pe TIMP, nu pe tipul dispozitivului: un telefon nou poate fi mai rapid decat un
 * laptop vechi, iar o detectie pe user agent ar imbatrani. Singura regula legata de dispozitiv e
 * plafonul dur pe ecran tactil, unde o pagina care nu raspunde 40 de secunde e indistingabila de
 * una blocata si nu exista o fila de abandonat fara sa pierzi pagina.
 *
 * Toate pragurile stau aici, ca numere numite, si fiecare are motivul lui. `planPaths` e o functie
 * pura: de aceea fiecare ramura are test cu `c` injectat (rapid, mediu, lent, tactil), fara sa fie
 * nevoie de cronometrari manuale.
 */

/* Ţinta implicita. 8 s e cat durează o rulare pe care un vizitator o asteapta fara sa creada ca
   pagina s-a blocat, masurat impotriva implicitului de azi (2.000 de traiectorii, 30 de zile,
   ~2,6 s pe aceasta masina cu piscina actuala). */
const BUDGET_TARGET_S = 8;
/* Alegerile oferite, de la cea mai precisa in jos. Nu un continuum: un numar rotund e verificabil
   de cititor, iar `se ∝ 1/√N` face ca pasii intermediari sa nu schimbe mai nimic. */
const PATH_CHOICES = [10000, 5000, 2000];
/* Sub 1.000 de traiectorii eroarea Monte Carlo pe medie trece de 0,20 puncte procentuale
   (masurat: 0,2043% la 1.000), adica ordinul de marime al rezultatului insusi. */
const PATHS_MIN = 1000;
/* Pana aici se ruleaza fara sa intrebam. */
const RUN_FREE_S = 30;
/* Intre RUN_FREE_S si aici se cere confirmare, cu timpul estimat afisat. Peste, se refuza: o
   rulare de peste un minut si jumatate intr-o fila de browser e mai probabil o greseala de
   parametri decat o intentie. */
const RUN_CONFIRM_S = 90;
/* Ecran tactil: plafon dur, fara banda de confirmare. */
const COARSE_HARD_CAP_S = 30;

/* `c` e costul PISCINEI, nu al unui fir: milisecunde de ceas de perete pe traiectorie-zi-combinatie
   cand lucreaza toţi lucratorii. NU se mai imparte la numarul de lucratori.
   DE CE (masurat in browser, 02.11.2026): impartirea la `navigator.hardwareConcurrency` da un
   numar fictiv. Pe o masina cu nuclee de performanta SI de eficienţa, lucratorii nu merg toţi la
   viteza celui mai rapid — primele estimari au ieşit 2,1 s pentru o rulare care a durat 3,2 s, o
   subevaluare de 1,5x. Iar o estimare optimista e cel mai rau fel de estimare aici: toata politica
   de pragure (8 s ţinta, 30 s liber, 90 s refuz) se sprijina pe ea. Acum se masoara exact
   marimea folosita: se trimite acelasi lot tuturor lucratorilor simultan si se cronometreaza
   ceasul de perete, deci `c` include deja paralelismul real, inclusiv cat se pierde din el. */
function estimateSeconds(c, days, paths, combinations) {
  return (c * days * paths * Math.max(1, combinations)) / 1000;
}

/* Intoarce ce se ruleaza si DE CE, ca UI-ul sa poata afisa motivul in loc sa pară arbitrar.
     { paths, seconds, action: 'run'|'confirm'|'refuse', reason, warn, choices }
   `requested` null inseamna "alege tu"; un numar inseamna ca vizitatorul a cerut explicit. */
function planPaths(o) {
  const c = o.c, days = o.days;
  const combos = o.combinations === undefined ? 6 : o.combinations;
  /* Doar informativ, pentru afisare: `c` include deja paralelismul. */
  const workers = o.workers === undefined ? 1 : o.workers;
  const coarse = !!o.coarse;
  if (!(c > 0) || !(days >= 1)) throw new Error('planPaths: c and days must be positive');

  const est = function (n) { return estimateSeconds(c, days, n, combos); };
  const choices = PATH_CHOICES.map(function (n) {
    return { paths: n, seconds: est(n), over_cap: est(n) > (coarse ? COARSE_HARD_CAP_S : RUN_CONFIRM_S) };
  });

  let paths, chosenReason;
  if (o.requested === null || o.requested === undefined) {
    paths = PATHS_MIN;
    chosenReason = 'none of ' + PATH_CHOICES.join('/') + ' fits in ' + BUDGET_TARGET_S +
                   ' s, so the floor of ' + PATHS_MIN + ' paths is used';
    for (let i = 0; i < PATH_CHOICES.length; i++) {
      if (est(PATH_CHOICES[i]) <= BUDGET_TARGET_S) {
        paths = PATH_CHOICES[i];
        chosenReason = 'largest of ' + PATH_CHOICES.join('/') + ' that fits in ' +
                       BUDGET_TARGET_S + ' s on this device';
        break;
      }
    }
  } else {
    paths = Math.max(1, o.requested | 0);
    chosenReason = 'requested explicitly';
  }

  const seconds = est(paths);
  let action, reason, warn = null;

  if (paths > MAX_PATHS) {
    action = 'refuse';
    reason = paths + ' paths is above the engine limit of ' + MAX_PATHS;
  } else if (seconds <= RUN_FREE_S) {
    action = 'run';
    reason = 'estimated ' + seconds.toFixed(1) + ' s, under the ' + RUN_FREE_S + ' s threshold';
  } else if (paths <= PATHS_MIN) {
    /* Chiar si minimul depaseste pragul: nu exista o configuratie mai mica de oferit, deci se
       ruleaza si se spune ca dispozitivul e lent. Un refuz aici ar lasa vizitatorul fara nimic. */
    action = 'run';
    warn = 'slow-device';
    reason = 'even the floor of ' + PATHS_MIN + ' paths needs ' + seconds.toFixed(0) +
             ' s on this device';
  } else if (coarse) {
    action = 'refuse';
    reason = 'estimated ' + seconds.toFixed(0) + ' s, above the ' + COARSE_HARD_CAP_S +
             ' s cap for touch devices';
  } else if (seconds <= RUN_CONFIRM_S) {
    action = 'confirm';
    reason = 'estimated ' + seconds.toFixed(0) + ' s, above ' + RUN_FREE_S + ' s';
  } else {
    action = 'refuse';
    reason = 'estimated ' + seconds.toFixed(0) + ' s, above the ' + RUN_CONFIRM_S + ' s limit';
  }

  return { paths: paths, seconds: seconds, action: action, reason: reason,
           chosen_because: chosenReason, warn: warn, choices: choices,
           c: c, days: days, combinations: combos, workers: workers };
}

/* ------------------------------------------------- simulare si agregare, separate
 *
 * DE CE SUNT DOUA FUNCTII (0.2.0). O combinatie trebuie sa poata fi imparţita pe mai mulţi
 * lucratori si sa dea un rezultat IDENTIC BIT CU BIT, oricate ar fi. Asta nu se obţine combinand
 * statistici parţiale: `time_outside_range` se calculeaza cu mean(), care insumeaza in ordinea
 * indicilor, iar adunarea in virgula mobila nu e asociativa (masurat: 1,46e-15 diferenţa relativa
 * la permutare). Se obţine asa:
 *   simulatePaths()  produce traiectoriile BRUTE pentru un interval de indici;
 *   combineRaw()     le concateneaza IN ORDINEA INDICILOR si apeleaza summarise() O SINGURA DATA.
 * `runCombination` fara `raw` e exact `combineRaw([simulatePaths(...)])`, deci exista O SINGURA
 * cale de agregare in tot motorul. Cazul cu un lucrator si cazul cu N lucratori nu sunt doua
 * implementari care se intampla sa coincida: e aceeasi implementare.
 *
 * Traiectoria k depinde numai de (seed, k) — xoshiro128ss(seed, k) — deci `path_offset` alege CARE
 * traiectorii se calculeaza, fara sa schimbe niciuna.
 */

function _fixedSequence(returns) {
  /* Modelul unui replay: secvenţa zilnica e DATA. sd declarat e cel al episodului, fiindca puntea
     intrazi il foloseste pentru extremele din interiorul zilei. */
  const seq = Float64Array.from(returns);
  for (let i = 0; i < seq.length; i++) {
    if (!Number.isFinite(seq[i])) throw new Error('path.returns[' + i + '] is not finite');
  }
  if (seq.length === 0) throw new Error('path.returns is empty');
  return {
    sd: empiricalSd(seq),
    gen: function (rng, out, days) { for (let k = 0; k < days; k++) out[k] = seq[k]; }
  };
}

function simulatePaths(opts) {
  const coin = opts.coin;
  const replay = opts.path || null;
  if (replay && (opts.model || opts.modelFn)) {
    /* Un rezultat etichetat "model B" pe un drum impus ar fi o eticheta falsa. */
    throw new Error('path and model are mutually exclusive');
  }

  const requested = opts.paths | 0;
  if (requested > MAX_PATHS) {
    throw new Error('paths ' + requested + ' exceeds MAX_PATHS ' + MAX_PATHS);
  }
  const paths = Math.max(1, requested);
  const offset = Math.max(0, opts.path_offset | 0);

  /* Preţul de referinţa: intr-un replay e inchiderea zilei de START a episodului, nu preţul de
     azi. Altfel grila sta in locul greşit si rezultatul nu inseamna nimic. */
  const refPrice = replay && replay.ref_close !== undefined && replay.ref_close !== null
    ? replay.ref_close
    : coin.reference_price;
  if (!(refPrice > 0)) throw new Error('invalid reference price');

  const lo = refPrice * (1 + opts.lowPct / 100);
  const hi = refPrice * (1 + opts.highPct / 100);
  if (!(lo > 0 && hi > lo)) throw new Error('invalid grid range');
  const nLevels = Math.max(2, Math.min(100, opts.levels | 0));
  const levels = buildLevels(lo, hi, nLevels);

  let above = 0;
  for (let i = 0; i < nLevels; i++) if (levels[i] > refPrice) above++;
  const invInit = (opts.capital / 2) / refPrice;
  const qty = invInit / Math.max(1, above);

  const model = replay ? _fixedSequence(replay.returns) : makeModel(opts.modelFn || opts.model, coin);
  /* Orizontul unui replay e lungimea episodului. Nu se cicleaza si nu se trunchiaza: un episod de
     22 de zile rulat pe 30 ar repeta zile reale, iar pe 15 ar tăia caderea. */
  const days = replay ? replay.returns.length : opts.days;
  if (!(days >= 1)) throw new Error('invalid days');

  const cfg = {
    levels: levels,
    qty: qty,
    feeRate: opts.feeRate,
    deltaStar: opts.deltaStarBps / 10000,
    conservative: !!opts.conservative,
    cycleRatio: opts.cycleRatio,
    refPrice: refPrice,
    capital: opts.capital,
    /* allowCoarseStep exists only so tools/convergence_test.mjs can produce the evidence table
       at resolutions the engine itself refuses to run. */
    stepsPerDay: opts.allowCoarseStep
      ? Math.max(1, opts.stepsPerDay | 0)
      : Math.max(MIN_STEPS_PER_DAY, (opts.stepsPerDay | 0) || STEPS_PER_DAY),
    days: days,
    sd: model.sd,
    model: model.gen
  };

  const dailyBuf = new Float64Array(days);
  const pnl = new Float64Array(paths), mdd = new Float64Array(paths),
        cyc = new Float64Array(paths), finInv = new Float64Array(paths),
        outFrac = new Float64Array(paths);
  let nOutside = 0, nMissed = 0;

  for (let i = 0; i < paths; i++) {
    const k = offset + i;
    const rng = xoshiro128ss(opts.seed >>> 0, k);
    const res = runPath(cfg, rng, dailyBuf);
    pnl[i] = res.pnlPct; mdd[i] = res.mddPct; cyc[i] = res.cycles;
    finInv[i] = res.finalInvPct; outFrac[i] = res.outsideFrac;
    nOutside += res.outside;
    if (res.missedBuys) nMissed++;
    if (opts.onProgress && (i & 255) === 255) opts.onProgress(i + 1, paths);
  }
  if (opts.onProgress) opts.onProgress(paths, paths);

  return {
    raw: true,
    path_offset: offset,
    paths: paths,
    paths_requested: requested,
    pnl: pnl, mdd: mdd, cycles: cyc, final_inventory: finInv, outside_frac: outFrac,
    n_outside: nOutside, n_missed: nMissed,
    meta: {
      model: replay ? 'REPLAY' : (typeof opts.model === 'string' ? opts.model : 'INJECTED'),
      execution: opts.conservative ? 'CONSERVATIVE' : 'OPTIMISTIC',
      steps_per_day: cfg.stepsPerDay,
      model_sd: model.sd,
      reference_price: refPrice,
      days: days,
      path_label: replay ? (replay.label || 'unnamed path') : null,
      path_source: replay ? (replay.source || null) : null
    }
  };
}

function combineRaw(parts) {
  if (!parts || parts.length === 0) throw new Error('combineRaw: no parts');
  /* Ordinea indicilor, impusa aici: lucratorii pot raspunde in orice ordine, dar concatenarea NU
     are voie sa depinda de cine a terminat primul. */
  const ps = parts.slice().sort(function (a, b) { return a.path_offset - b.path_offset; });
  const m0 = ps[0].meta;
  let total = 0, requested = 0;
  for (let i = 0; i < ps.length; i++) {
    const m = ps[i].meta;
    if (m.model !== m0.model || m.execution !== m0.execution ||
        m.steps_per_day !== m0.steps_per_day || m.days !== m0.days ||
        m.model_sd !== m0.model_sd || m.path_label !== m0.path_label) {
      throw new Error('combineRaw: parts disagree on how they were produced');
    }
    if (ps[i].path_offset !== total) {
      throw new Error('combineRaw: parts do not tile the index range (gap or overlap at ' +
                      ps[i].path_offset + ', expected ' + total + ')');
    }
    total += ps[i].paths;
    requested += ps[i].paths_requested;
  }

  const cat = function (key) {
    const out = new Float64Array(total);
    let at = 0;
    for (let i = 0; i < ps.length; i++) { out.set(ps[i][key], at); at += ps[i][key].length; }
    return out;
  };
  const pnl = cat('pnl'), mddA = cat('mdd'), cycA = cat('cycles'),
        finA = cat('final_inventory'), outA = cat('outside_frac');
  let nOutside = 0, nMissed = 0;
  for (let i = 0; i < ps.length; i++) { nOutside += ps[i].n_outside; nMissed += ps[i].n_missed; }

  const pExit = nOutside / total;
  const out = {
    model: m0.model,
    execution: m0.execution,
    paths: total,
    paths_requested: requested,
    steps_per_day: m0.steps_per_day,
    model_sd: m0.model_sd,
    reference_price: m0.reference_price,
    days: m0.days,
    pnl_pct: summarise(pnl),
    mdd_pct: summarise(mddA),
    cycles: summarise(cycA),
    final_inventory_pct: summarise(finA),
    p_exit_range: pExit,
    se_p_exit: Math.sqrt(pExit * (1 - pExit) / total),
    time_outside_range: mean(outA),
    paths_with_missed_buys: nMissed
  };
  if (m0.path_label !== null) {
    out.path_label = m0.path_label;
    out.path_source = m0.path_source;
  }
  return out;
}

function runCombination(opts) {
  const part = simulatePaths(opts);
  return opts.raw ? part : combineRaw([part]);
}

/* Verdictul, pe MEDIE si pe semnificatia ei statistica.
 *
 * DE CE S-A SCHIMBAT (0.1.1). Pana aici verdictul era "ROBUST daca semnul MEDIANEI e acelasi in
 * toate sase combinatiile". Pe DOGE, 25 niveluri, +-15%, 30 zile, seed 475896362, cele sase
 * mediane erau +4,18% ... +6,27% — toate pozitive, deci verdict ROBUST. Dar mediile erau
 * +0,83 / -1,12 / +0,24 / -1,60 / +0,72 / -1,40 la erori standard de ~0,26: in toate trei
 * combinatiile CONSERVATOARE valoarea asteptata era negativa, semnificativ (-1,60 ± 0,27 e la
 * ~6 erori standard sub zero), iar 32-37% din traiectorii pierdeau bani. Verdictul numea ROBUSTA
 * o strategie cu valoare asteptata negativa. O mediana pozitiva cu o medie negativa e exact ce
 * produce o coada stanga grea, deci nu era un caz patologic rar: e tiparul normal al unei grile.
 *
 * DE CE 2 ERORI STANDARD. Pragul separa "semnul e masurat" de "semnul e zgomot Monte Carlo".
 * |medie| >= 2*se_medie corespunde unui interval de incredere bilateral de ~95% care nu atinge
 * zero (1,96 rotunjit la 2). Sub acest prag, A SPUNE ca semnul e cunoscut inseamna a raporta
 * eroarea de eşantionare ca rezultat — iar remediul e la indemana vizitatorului: mai multe
 * traiectorii strang se_medie ca 1/sqrt(N), deci "MIXED" din lipsa de semnificatie se poate
 * transforma in verdict rulând mai mult. Nu se foloseste un prag mai sever (3 erori) pentru ca
 * ar cere ~2,25 ori mai multe traiectorii pentru acelasi raspuns, fara ca riscul decis sa fie
 * al unei publicatii stiintifice.
 *
 * CE NU ACOPERA PRAGUL: eroarea de MODEL. 2 erori standard spun ca semnul mediei e real IN
 * MODEL. Niciunul dintre cele trei modele nu contine un crash, randamentele sunt zilnice cu o
 * punte browniana intrazi, iar costul de execuţie e o presupunere calibrata. Un verdict ROBUST
 * rămâne un rezultat despre modele, nu despre piaţa.
 */
const ROBUST_SIGMAS = 2;

function robustness(results) {
  /* Un replay NU e o distribuţie peste viitoruri posibile: secvenţa zilnica e fixa, singura
     aleatorietate rămasa e puntea intrazi, iar se_mean colapseaza (masurat: 0,006 fata de 0,121
     pe acelasi BTC la 22 de zile). Pragul de 2 erori standard ar declara atunci totul
     semnificativ si ar produce un verdict cu aparenţa de certitudine statistica pe un singur
     drum. E aceeasi clasa de greseala ca verdictul pe mediana reparat in 0.1.1 — de aceea e
     refuzata in cod, nu lasata pe seama apelantului. */
  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i].path_label !== undefined && results[i].path_label !== null) {
      throw new Error('robustness() does not apply to replay results (path_label: ' +
                      results[i].path_label + ')');
    }
  }
  const medianSigns = results.map(function (r) { return Math.sign(r.pnl_pct.p50); });
  const meanSigns = results.map(function (r) { return Math.sign(r.pnl_pct.mean); });
  const uniqMean = Array.from(new Set(meanSigns));
  /* Semnificatia se cere pe FIECARE combinatie: o singura combinatie nehotarata face ca intregul
     verdict sa nu fie hotarat, pentru ca verdictul e o afirmatie despre toate sase. */
  const insignificant = [];
  for (let i = 0; i < results.length; i++) {
    const m = results[i].pnl_pct.mean, se = results[i].pnl_pct.se_mean;
    if (!(Math.abs(m) >= ROBUST_SIGMAS * se)) insignificant.push(i);
  }
  const sameSign = uniqMean.length === 1 && uniqMean[0] !== 0;
  const significant = insignificant.length === 0;

  let label, reason;
  if (sameSign && significant) {
    label = uniqMean[0] > 0 ? 'ROBUST' : 'NEGATIVE EXPECTATION';
    reason = uniqMean[0] > 0
      ? 'mean net PnL is positive in all ' + results.length + ' combinations, each at least ' +
        ROBUST_SIGMAS + ' standard errors from zero'
      : 'mean net PnL is NEGATIVE in all ' + results.length + ' combinations, each at least ' +
        ROBUST_SIGMAS + ' standard errors from zero';
  } else {
    label = 'MIXED';
    reason = !sameSign
      ? 'the sign of the mean net PnL is not the same in all combinations'
      : 'the mean net PnL is within ' + ROBUST_SIGMAS + ' standard errors of zero in ' +
        insignificant.length + ' of ' + results.length + ' combinations (more paths would narrow it)';
  }

  const p5 = results.map(function (r) { return r.pnl_pct.p5; });
  const pneg = results.map(function (r) { return r.pnl_pct.p_neg; });
  const cv = results.map(function (r) { return r.pnl_pct.cvar5; });
  return {
    label: label,
    reason: reason,
    sigmas: ROBUST_SIGMAS,
    combinations: results.length,
    mean_signs: meanSigns,
    median_signs: medianSigns,
    /* Pastrat explicit: cand mediana si media nu sunt de acord, asta E constatarea, si UI-ul
       trebuie sa o poata spune in loc sa aleaga una dintre ele. */
    median_mean_disagree: medianSigns.some(function (sg, i) { return sg !== meanSigns[i]; }),
    insignificant_combinations: insignificant.length,
    p_neg_min: Math.min.apply(null, pneg),
    p_neg_max: Math.max.apply(null, pneg),
    cvar5_min: Math.min.apply(null, cv),
    cvar5_max: Math.max.apply(null, cv),
    p5_min: Math.min.apply(null, p5),
    p5_max: Math.max.apply(null, p5),
    p5_spread: Math.max.apply(null, p5) - Math.min.apply(null, p5)
  };
}

const ENGINE = {
  xoshiro128ss: xoshiro128ss,
  maxDrawdownFromPeak: maxDrawdownFromPeak,
  buildLevels: buildLevels,
  summarise: summarise,
  planPaths: planPaths,
  estimateSeconds: estimateSeconds,
  BUDGET_TARGET_S: BUDGET_TARGET_S,
  PATH_CHOICES: PATH_CHOICES,
  PATHS_MIN: PATHS_MIN,
  RUN_FREE_S: RUN_FREE_S,
  RUN_CONFIRM_S: RUN_CONFIRM_S,
  COARSE_HARD_CAP_S: COARSE_HARD_CAP_S,
  simulatePaths: simulatePaths,
  combineRaw: combineRaw,
  runCombination: runCombination,
  robustness: robustness,
  empiricalSd: empiricalSd,
  /* Exportat ca UI-ul sa poata arata volatilitatea pe care modelele o folosesc EFECTIV, fara
     sa-si rescrie propria dispecerie A/B/C — doua dispecerii care pot ajunge sa nu coincida sunt
     exact felul in care antetul a ajuns sa afiseze sigma30 langa rezultate rulate pe sigma de
     doi ani. */
  makeModel: makeModel,
  makeBootstrap: makeBootstrap,
  makeGaussian: makeGaussian,
  makeStudentT: makeStudentT,
  bridgeMax: bridgeMax,
  bridgeMin: bridgeMin,
  MAX_PATHS: MAX_PATHS,
  BLOCK_DAYS: BLOCK_DAYS,
  ROBUST_SIGMAS: ROBUST_SIGMAS,
  STEPS_PER_DAY: STEPS_PER_DAY,
  MIN_STEPS_PER_DAY: MIN_STEPS_PER_DAY
};

if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
if (typeof self !== 'undefined') self.ENGINE = ENGINE;
