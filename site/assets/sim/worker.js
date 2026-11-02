/* iScanTrust — simulation worker. Runs engine.js off the main thread.
 * No network access of any kind: the calibration arrives in the start message. */

'use strict';
importScripts('/assets/sim/engine.js');

/* The cap is re-read from the engine rather than redeclared: two `const MAX_PATHS` in the same
   worker global scope is a SyntaxError that kills the worker before it can report anything. */
const WORKER_MAX_PATHS = self.ENGINE.MAX_PATHS;

self.onmessage = function (ev) {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  try {
    const job = msg.job;
    if (job.paths > WORKER_MAX_PATHS) job.paths = WORKER_MAX_PATHS;   /* hard cap, worker side */
    const res = self.ENGINE.runCombination(Object.assign({}, job, {
      onProgress: function (done, total) {
        self.postMessage({ type: 'progress', id: msg.id, done: done, total: total });
      }
    }));
    self.postMessage({ type: 'done', id: msg.id, result: res });
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, error: String(e && e.message || e) });
  }
};
