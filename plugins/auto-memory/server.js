'use strict';
/**
 * Auto-Memory plugin.
 *
 * Registers an `onResponseComplete` hook that fires background memory extraction
 * (server/memory-engine.js). GATED by the MEMORY_AUTO env flag: when unset,
 * activate() registers NO hook at all, so the feature is fully inert — the
 * switch is genuinely OFF, not just no-op'ing per turn.
 *
 * Turn ON:  set MEMORY_AUTO=1 in ecosystem.linux.config.js (151-machine env),
 *           then `pm2 restart ecosystem.linux.config.js --only 151-machine`.
 * Roll back: delete the line + restart the same way.
 *
 * Safety: the hook dispatcher (plugin-loader emit) already try/catches every
 * hook call; on top of that we defer to setImmediate (so the response path
 * returns instantly) and maybeExtract() swallows all its own errors. This hook
 * cannot affect, delay, or break a chat turn.
 */

let memory = null;
try { memory = require('../../server/memory-engine'); } catch (e) { memory = null; }

module.exports = {
  activate(api) {
    if (!process.env.MEMORY_AUTO || !memory) {
      return {}; // switch OFF — no hook registered, nothing runs
    }
    const manager = api.manager;

    function onResponseComplete(sessionId) {
      setImmediate(() => {
        try {
          const s = manager.sessions.get(sessionId);
          const history = (s && Array.isArray(s.history)) ? s.history : [];
          memory.maybeExtract(sessionId, history);
        } catch {}
      });
    }

    console.log('[MEMORY] auto-memory plugin active (MEMORY_AUTO=1)');
    return { onResponseComplete };
  },
};
