'use strict';

/**
 * restart-control.js — THE single in-process restart funnel.
 *
 * STRUCTURAL RULE: every code path that intentionally bounces
 * this process MUST go through `restart()`. No raw `plannedShutdown()`,
 * `closeServersAndExit()`-for-restart, `process.exit()`-to-restart, or
 * JS-spawned `pm2 restart` anywhere else. `restart()` ARMS the post-deploy
 * verify marker BEFORE the process can die, so the session that triggered the
 * restart auto-reports once the app is back — then performs the shutdown via the
 * registered mechanism (deploy.js `plannedShutdown`, which saves state + drains
 * clients). tests/restart-arming.guard.test.js fails the build if any restart
 * path skips this funnel or stops arming.
 *
 * The OTHER restart class — a chat session running `bash deploy.sh` / `pm2
 * restart …` as a Bash TOOL — is not an in-process call (the shell runs it, not
 * Node), so it can't route through here. Its single chokepoint is the
 * stream-handler's `maybeRecordRestartCulprit`, which arms the same marker the
 * instant it SEES such a command. Two funnels, one arm primitive, one guard.
 *
 * Signal handlers (SIGTERM/SIGINT), crash handlers (uncaughtException), and the
 * EADDRINUSE/boot-gate bailouts are NOT restarts we chose — they are reactive
 * exits where pm2 (or the OS) is the initiator. They are out of scope for this
 * funnel and the guard ignores them.
 */

const restartIntent = require('./restart-intent');

let _shutdownImpl = null;
let _restarting = false;

/**
 * Register the real shutdown mechanism (deploy.js `plannedShutdown`). Called
 * once at boot from server/index.js after the deploy handler is built.
 */
function registerShutdownImpl(fn) {
  _shutdownImpl = fn;
}

/**
 * The funnel. Arm-then-restart.
 * @param {object} opts
 * @param {string} opts.reason     short human reason (also the shutdown log line)
 * @param {string} [opts.actor]    restart-intent actor (banner attribution)
 * @param {string} [opts.sessionId] session that triggered it (verify target; null = none)
 * @param {string} [opts.intent]   the command/intent string recorded in the arm marker
 * @param {string} [opts.detail]   extra detail for the restart-intent banner
 */
function restart({ reason, actor, sessionId, intent, detail } = {}) {
  if (_restarting) {
    console.log('[restart] already restarting — ignoring duplicate request');
    return;
  }
  _restarting = true;

  // 1. ARM first — this is the whole point of the funnel. sessionId may be null
  //    (e.g. memory watchdog) → armPostDeployVerify no-ops; there is no session
  //    to verify, but the funnel still ran and the guard is satisfied.
  try {
    restartIntent.armPostDeployVerify({ sessionId: sessionId || null, intent: intent || reason || 'restart' });
  } catch (e) {
    console.error('[restart] arm failed (continuing):', e.message);
  }

  // 2. Record the restart intent for the boot banner.
  try {
    restartIntent.writeIntent({
      actor: actor || 'restart-control',
      reason: reason || 'restart',
      detail: detail || intent || null,
    });
  } catch (e) {
    console.error('[restart] writeIntent failed (continuing):', e.message);
  }

  // 3. DICTATION GUARD (2026-08-16, punto 4): if a client is recording a voice
  //    note or a transcription is in flight, WAIT for the text to be delivered
  //    before bouncing — then proceed on our own ("parte da solo"). Bounded at
  //    10 min so a stale flag can never wedge a restart forever; kill switch
  //    RESTART_WAIT_DICTATION=0. tools/deploy.sh runs the same check up front,
  //    so this is the in-process second guard (covers /api/deploy full mode,
  //    watchdogs, and any other in-process restart caller).
  const performShutdown = () => {
    if (typeof _shutdownImpl === 'function') {
      _shutdownImpl(reason || 'restart');
    } else {
      console.error('[restart] no shutdown impl registered — hard-exit fallback');
      setTimeout(() => process.exit(0), 200);
    }
  };

  if (process.env.RESTART_WAIT_DICTATION === '0') return performShutdown();
  let readiness;
  try { readiness = require('./restart-readiness'); } catch { return performShutdown(); }
  const snap = readiness.snapshot();
  if (snap.ready) return performShutdown();
  console.log(`[restart] dictation in progress (recording=${snap.recording} transcribing=${snap.transcribing}) — waiting before shutdown`);
  let lastLog = 0;
  readiness.waitUntilReady({
    maxWaitMs: 10 * 60 * 1000,
    pollMs: 2000,
    onWait: (s, elapsed) => {
      if (elapsed - lastLog >= 20000) {
        lastLog = elapsed;
        console.log(`[restart] still waiting for dictation (recording=${s.recording} transcribing=${s.transcribing}, ${Math.round(elapsed / 1000)}s)`);
      }
    },
  }).then((finalSnap) => {
    if (!finalSnap.ready) {
      console.warn('[restart] dictation wait timed out (10 min) — proceeding with restart anyway');
    } else {
      console.log('[restart] dictation clear — proceeding with shutdown');
    }
    performShutdown();
  });
}

module.exports = { restart, registerShutdownImpl };
