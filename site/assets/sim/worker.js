/* iScanTrust — simulation worker. Runs engine.js off the main thread.
 * No network access of any kind: the calibration arrives in the start message. */

'use strict';
importScripts('/assets/sim/engine.js');

self.onmessage = function (ev) {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  try {
    const job = msg.job;
    /* 0.2.0: plafonul NU se mai aplica aici in silenţiu. Pana la 0.2.0 workerul facea
       `if (job.paths > MAX_PATHS) job.paths = MAX_PATHS`, deci o cerere prea mare se intorcea
       redusa, fara niciun semnal, iar firul principal raporta o precizie pe care nu o avea.
       Acum simulatePaths arunca, iar eroarea ajunge la UI prin ramura de mai jos. */
    const part = self.ENGINE.simulatePaths(Object.assign({}, job, {
      raw: true,
      onProgress: function (done, total) {
        self.postMessage({ type: 'progress', id: msg.id, done: done, total: total });
      }
    }));
    /* Traiectoriile BRUTE se intorc firului principal, care le concateneaza in ordinea indicilor
       si apeleaza summarise() o singura data — altfel rezultatul ar depinde de numarul de
       lucratori (time_outside_range se insumeaza in ordinea indicilor). Tablourile se MUTA, nu se
       copiaza: lista de transfer face postMessage sa predea proprietatea asupra memoriei. */
    const out = {
      raw: true,
      path_offset: part.path_offset,
      paths: part.paths,
      paths_requested: part.paths_requested,
      pnl: part.pnl, mdd: part.mdd, cycles: part.cycles,
      final_inventory: part.final_inventory, outside_frac: part.outside_frac,
      n_outside: part.n_outside, n_missed: part.n_missed,
      meta: part.meta
    };
    self.postMessage({ type: 'done', id: msg.id, part: out },
      [part.pnl.buffer, part.mdd.buffer, part.cycles.buffer,
       part.final_inventory.buffer, part.outside_frac.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, error: String(e && e.message || e) });
  }
};
