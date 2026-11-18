'use strict';

/**
 * restart-readiness.js — "is it safe to bounce the server RIGHT NOW?"
 * (Restart/deploy round 2026-08-16, punto 4: mai più registrazioni perse.)
 *
 * Tracks two things a restart would destroy:
 *   1. RECORDING — a client is actively recording a voice note. The client
 *      (public/js/dictation.js) sends {type:'dictation_state', active:true}
 *      over WS when recording starts, re-sends it as a heartbeat every 30 s
 *      while recording, and sends active:false when it stops. Entries expire
 *      after STALE_MS without a heartbeat so a crashed phone can never wedge
 *      deploys forever.
 *   2. TRANSCRIBING — an HTTP POST /api/dictation/transcribe is in flight
 *      (server/index.js wraps the route with begin/endTranscribe). Counted on
 *      whatever box the request is passing through, so the Pi counts a phone
 *      upload it is proxying to the PC and the PC counts the whisper run.
 *
 * Consumers:
 *   - GET /api/restart-readiness (public, like /api/health) — polled by
 *     tools/deploy.sh before it fires a deploy, on BOTH PC and Pi.
 *   - server/restart-control.js restart() — the in-process funnel waits
 *     (bounded) for readiness before performing the shutdown.
 *
 * No external deps. All state is in-memory (a restart resets it by design).
 */

const STALE_MS = 90 * 1000; // recording heartbeat is 30s — 3 missed beats = stale

// ws (or any opaque connection key) → last-heartbeat epoch ms
const recorders = new Map();
let transcribing = 0;

function prune() {
  const now = Date.now();
  for (const [ws, ts] of recorders) {
    if (now - ts > STALE_MS) recorders.delete(ws);
  }
}

/** Client said it started (active=true, heartbeats) or stopped (false) recording. */
function noteRecording(ws, active) {
  if (!ws) return;
  if (active) recorders.set(ws, Date.now());
  else recorders.delete(ws);
}

/** WS connection closed — whatever it was recording is gone with it. */
function dropConnection(ws) {
  recorders.delete(ws);
}

function beginTranscribe() { transcribing += 1; }
function endTranscribe() { transcribing = Math.max(0, transcribing - 1); }

function snapshot() {
  prune();
  const recording = recorders.size;
  return {
    ready: recording === 0 && transcribing === 0,
    recording,
    transcribing,
  };
}

/**
 * Wait (poll) until ready or maxWaitMs elapses. Resolves with the final
 * snapshot either way — the caller decides whether a timeout is fatal.
 * Used by restart-control.js so the funnel "parte da solo" once the text
 * has been delivered.
 */
function waitUntilReady({ maxWaitMs = 5 * 60 * 1000, pollMs = 2000, onWait } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    (function check() {
      const snap = snapshot();
      if (snap.ready || Date.now() - started >= maxWaitMs) return resolve(snap);
      if (typeof onWait === 'function') {
        try { onWait(snap, Date.now() - started); } catch {}
      }
      setTimeout(check, pollMs);
    })();
  });
}

module.exports = { noteRecording, dropConnection, beginTranscribe, endTranscribe, snapshot, waitUntilReady, STALE_MS };
