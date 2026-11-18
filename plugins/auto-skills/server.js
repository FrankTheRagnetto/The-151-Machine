'use strict';
/**
 * Auto-Skills plugin (Odysseus steal #3).
 *
 * Registers an `onResponseComplete` hook that fires the background skill-writer
 * (server/skill-writer.js) AFTER genuine multi-step agent work. GATED by the
 * SKILLS_AUTO env flag: when unset, activate() registers NO hook at all, so the
 * feature is fully inert — the switch is genuinely OFF, not just no-op'ing.
 *
 * Turn ON:  set SKILLS_AUTO=1 in ecosystem.linux.config.js (151-machine env),
 *           then `pm2 restart ecosystem.linux.config.js --only 151-machine`.
 * Roll back: delete the line + restart the same way.
 *
 * Safety (mirrors auto-memory's 3 layers): (1) activate() returns {} when off —
 * no hook registered; (2) the hook dispatcher (plugin-loader emit) try/catches
 * every hook; (3) the hook body defers to setImmediate (response path returns
 * instantly) + try/catch, and maybeWriteSkill() swallows all its own errors.
 * It cannot affect, delay, or break a chat turn.
 */

let skillWriter = null;
try { skillWriter = require('../../server/skill-writer'); } catch (e) { skillWriter = null; }

let skillCurator = null;
try { skillCurator = require('../../server/skill-curator'); } catch (e) { skillCurator = null; }

module.exports = {
  activate(api) {
    // The Curator (harvest steal #2) is gated by its OWN flag (SKILLS_CURATOR),
    // independent of SKILLS_AUTO: it tends the existing draft library (aging +
    // dry-run consolidation report) even if no new skills are being written.
    // No-op + no timer unless SKILLS_CURATOR is set.
    if (skillCurator) { try { skillCurator.startCuratorScheduler(); } catch {} }

    if (!process.env.SKILLS_AUTO || !skillWriter) {
      return {}; // switch OFF — no hook registered, nothing runs
    }
    const manager = api.manager;

    function onResponseComplete(sessionId) {
      setImmediate(() => {
        try {
          const s = manager.sessions.get(sessionId);
          const history = (s && Array.isArray(s.history)) ? s.history : [];
          skillWriter.maybeWriteSkill(sessionId, history);
        } catch {}
      });
    }

    console.log('[SKILLS] auto-skills plugin active (SKILLS_AUTO=1)');
    return { onResponseComplete };
  },
};
