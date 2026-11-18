'use strict';

/**
 * stream-log.js — Detached-runs ordered replay log (Odysseus steal #4).
 *
 * Flag-gated by DETACHED_RUNS (the caller gates; this module is inert unless
 * record()/startTurn() are actually invoked). Keeps a per-session, in-memory,
 * monotonically-sequenced log of the assistant turn's stream events so a client
 * that closed the tab/app mid-turn — or that lost the in-stream `done` to a
 * relay HTTP timeout on the phone path — can reconnect and replay EXACTLY the
 * events it missed (seq > lastSeq), in order, additively. The terminal `done`/
 * `error` event lives in the log until the next turn or until it ages out, so a
 * finished turn ALWAYS has a terminal marker to deliver on reconnect — that is
 * the bulletproof spinner-clear guarantee, independent of the dropped inline
 * `done` (the reliable session_status_changed broadcast remains a 2nd authority).
 *
 * Design notes:
 *  - `seq` is monotonic for the SESSION's server lifetime, never reset (a client
 *    tracks the highest seq it has seen; resetting would strand it). startTurn()
 *    clears the EVENT buffer at each new turn but leaves the seq counter running,
 *    so a stale previous-turn `done` can never bleed into a new turn's replay
 *    while the seq math (lastSeq vs minSeq) stays valid.
 *  - Ring-trimmed by count + age like the other out-of-repo stores. If a client's
 *    lastSeq predates the retained window (a gap), replaySince() reports {ok:false}
 *    so the caller falls back to the full tail snapshot (buildResumePayload) — no
 *    silent partial replay.
 *  - Only assistant-turn STREAM events are logged (LOGGABLE). Control frames
 *    (ack/stopped/queued_messages/user_message/session_*) are NOT replayed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_EVENTS = Number(process.env.DETACHED_MAX_EVENTS) || 3000;
const MAX_AGE_MS = Number(process.env.DETACHED_MAX_AGE_MS) || 15 * 60 * 1000;
const MAX_SESSIONS = Number(process.env.DETACHED_MAX_SESSIONS) || 64;

// --- M9 Fase B, Vettore 3: cross-restart replay persistence -----------------
// The in-memory `logs` Map is wiped by a restart and `seq` restarts at 0, so a
// reconnecting client's `replaySince(lastSeq)` finds an empty log → {ok:false}
// → the caller re-runs the whole turn (vector 1) instead of replaying the missed
// events. Fix: persist ONLY the LAST turn per session (the retained events +
// seq + updatedAt) atomically under ~/.151machine/, and reload it at boot so seq
// does NOT reset to 0. Bounded by the same MAX_AGE_MS / MAX_SESSIONS semantics.
//
// Flag-gated by DETACHED_RUNS: every disk helper early-returns when the flag is
// off (the call sites are already flag-gated too), so flag-off = zero disk I/O =
// byte-identical. Atomic temp+rename write (copied from restart-intent.js).
const STREAM_LOG_DIR = process.env.DETACHED_STREAM_LOG_DIR
  || path.join(os.homedir(), '.151machine', 'stream-log');
// Debounce disk writes so a fast delta stream doesn't hammer the FS: at most one
// snapshot per session per this interval; a turn boundary (startTurn) and the
// terminal done/error still force an immediate flush so a restart mid-turn is
// always covered.
const PERSIST_DEBOUNCE_MS = Number(process.env.DETACHED_PERSIST_DEBOUNCE_MS) || 2000;

function _on() { return !!process.env.DETACHED_RUNS; }
function _ensureDir() { try { fs.mkdirSync(STREAM_LOG_DIR, { recursive: true }); } catch {} }
function _fileFor(sid) {
  const safe = String(sid || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  return path.join(STREAM_LOG_DIR, safe + '.json');
}
function _atomicWrite(targetPath, data) {
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, targetPath);
}

const _pendingWrite = new Map(); // sid -> timer handle (debounce)

// Persist one session's snapshot to disk. force=true bypasses the debounce
// (turn boundary / terminal event). Fully wrapped — never throws into the
// live response path.
function _persist(sid, force) {
  if (!_on() || !sid) return;
  const l = logs.get(sid);
  if (!l) return;
  const doWrite = () => {
    _pendingWrite.delete(sid);
    try {
      const cur = logs.get(sid);
      if (!cur) return;
      const file = _fileFor(sid);
      if (!file) return;
      _ensureDir();
      _atomicWrite(file, JSON.stringify({
        sid,
        seq: cur.seq,
        epoch: cur.epoch,
        events: cur.events,
        updatedAt: cur.updatedAt,
      }));
    } catch (e) {
      try { console.error('[stream-log] persist failed:', e.message); } catch {}
    }
  };
  if (force) {
    const t = _pendingWrite.get(sid);
    if (t) { clearTimeout(t); _pendingWrite.delete(sid); }
    doWrite();
    return;
  }
  if (_pendingWrite.has(sid)) return; // a write is already scheduled
  const timer = setTimeout(doWrite, PERSIST_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  _pendingWrite.set(sid, timer);
}

function _unpersist(sid) {
  if (!_on() || !sid) return;
  const t = _pendingWrite.get(sid);
  if (t) { clearTimeout(t); _pendingWrite.delete(sid); }
  try {
    const file = _fileFor(sid);
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    try { console.error('[stream-log] unpersist failed:', e.message); } catch {}
  }
}

/**
 * BOOT: reload persisted snapshots into `logs` so seq does NOT restart at 0 and
 * a reconnect-after-restart REPLAYS the missed events instead of re-running.
 * Applies the same age/count bounds as the in-memory store and drops stale/
 * malformed/over-cap files. Flag-off / no-dir ⇒ no-op. Fully wrapped.
 * @returns {number} sessions restored into the in-memory log
 */
function loadFromDisk() {
  if (!_on()) return 0;
  let restored = 0;
  try {
    if (!fs.existsSync(STREAM_LOG_DIR)) return 0;
    const cutoff = Date.now() - MAX_AGE_MS;
    let files = fs.readdirSync(STREAM_LOG_DIR).filter((f) => f.endsWith('.json'));
    const loaded = [];
    for (const f of files) {
      const full = path.join(STREAM_LOG_DIR, f);
      let entry;
      try { entry = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { entry = null; }
      if (!entry || !entry.sid || typeof entry.seq !== 'number' || !Array.isArray(entry.events)) {
        try { fs.unlinkSync(full); } catch {}
        continue;
      }
      // Age-out whole snapshots that are too old to be useful.
      if ((entry.updatedAt || 0) < cutoff) {
        try { fs.unlinkSync(full); } catch {}
        continue;
      }
      loaded.push({ full, entry });
    }
    // Enforce MAX_SESSIONS (keep the freshest by updatedAt).
    loaded.sort((a, b) => (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0));
    for (let i = 0; i < loaded.length; i++) {
      const { full, entry } = loaded[i];
      if (i >= MAX_SESSIONS) { try { fs.unlinkSync(full); } catch {} continue; }
      // Trim events by count on the way in (age already bounded above).
      let events = entry.events;
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
      logs.set(entry.sid, {
        seq: entry.seq,          // preserve the monotonic counter — do NOT reset
        // Preserve the epoch too — same lifetime, same counter. Old snapshots
        // without one get a fresh epoch (counters can't be trusted across the
        // format change anyway).
        epoch: (typeof entry.epoch === 'number') ? entry.epoch : Date.now(),
        events,
        updatedAt: entry.updatedAt || Date.now(),
      });
      restored += 1;
    }
  } catch (e) {
    try { console.error('[stream-log] loadFromDisk failed:', e.message); } catch {}
  }
  return restored;
}

// Event types that constitute the live assistant turn stream. Everything else
// sent via sendToSession is a control frame and is deliberately not replayed.
const LOGGABLE = new Set([
  'delta', 'thinking', 'thinking_start',
  'tool_start', 'tool_use', 'tool_progress', 'tool_done',
  'status', 'done', 'error', 'model_info',
]);

const logs = new Map(); // sid -> { seq, events: [{ seq, t, data }], updatedAt }

function _get(sid) {
  let l = logs.get(sid);
  // ROUND CHAT bug 1/3 (2026-08-16): `epoch` identifies THIS counter's lifetime.
  // The seq counter silently restarts from 0 whenever the log entry is dropped
  // (15-min age-out in _pruneSessions / loadFromDisk, MAX_SESSIONS eviction,
  // restart with a stale snapshot). A client that kept the app open holds the
  // OLD high-water mark and seq-gates the whole new turn (delta+done) → empty
  // reply + ghost "Running command". Stamping the epoch on every event lets the
  // client detect the restart and reset its counters instead of gating.
  if (!l) { l = { seq: 0, epoch: Date.now(), events: [], updatedAt: Date.now() }; logs.set(sid, l); }
  return l;
}

function _trim(l) {
  const cutoff = Date.now() - MAX_AGE_MS;
  while (l.events.length && (l.events.length > MAX_EVENTS || l.events[0].t < cutoff)) {
    l.events.shift();
  }
}

// Drop whole sessions we haven't touched in a long time, and cap the session
// count (LRU-ish by updatedAt) so a long-lived server can't grow unbounded.
function _pruneSessions() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [sid, l] of logs) {
    if (l.updatedAt < cutoff) logs.delete(sid);
  }
  if (logs.size > MAX_SESSIONS) {
    const sorted = Array.from(logs.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const drop = sorted.length - MAX_SESSIONS;
    for (let i = 0; i < drop; i++) logs.delete(sorted[i][0]);
  }
}

/**
 * Begin a new assistant turn: clear the retained events but keep the monotonic
 * seq counter running. Called (flag-gated) from session-manager.startStream.
 */
function startTurn(sid) {
  if (!sid) return;
  const l = _get(sid);
  l.events = [];
  l.updatedAt = Date.now();
  _pruneSessions();
  // Turn boundary → force an immediate snapshot (bypass debounce) so a restart
  // right after a new turn opens still finds a consistent (empty-events, current
  // seq) on-disk state rather than a stale previous turn.
  _persist(sid, true);
}

/**
 * Record one outgoing stream event. Mutates `data` to stamp `_seq` (so the LIVE
 * payload the client receives also carries the sequence number — that's how the
 * client tracks lastSeq). No-op for non-stream/control frames.
 */
function record(sid, data) {
  if (!sid || !data || !LOGGABLE.has(data.type)) return;
  const l = _get(sid);
  l.seq += 1;
  data._seq = l.seq;
  data._epoch = l.epoch; // client resets its seq counters when this changes
  l.events.push({ seq: l.seq, t: Date.now(), data });
  l.updatedAt = Date.now();
  _trim(l);
  // Persist: debounced for streaming deltas, but force an immediate write on a
  // terminal marker so a finished turn is durably replayable even if the server
  // dies the instant after `done`/`error`.
  const terminal = data.type === 'done' || data.type === 'error';
  _persist(sid, terminal);
}

function currentSeq(sid) {
  const l = logs.get(sid);
  return l ? l.seq : 0;
}

function currentEpoch(sid) {
  const l = logs.get(sid);
  return l ? l.epoch : null;
}

/**
 * Return the ordered events with seq > lastSeq.
 *   { ok: true,  events: [...], seq }  — caller sends a `replay` batch.
 *   { ok: false }                      — gap (events trimmed below lastSeq+1)
 *                                        or no log; caller falls back to the
 *                                        full tail snapshot (buildResumePayload).
 */
function replaySince(sid, lastSeq, clientEpoch) {
  const l = logs.get(sid);
  // ROUND CHAT bug 1 (2026-08-16): if the client's counters come from a
  // DIFFERENT epoch (the log was dropped/aged-out and the seq counter
  // restarted), its lastSeq is meaningless — an inflated value would make
  // `lastSeq >= l.seq` report "already current" and silently swallow the
  // whole finished turn (the proven empty-reply path). Treat it as 0 so the
  // turn is replayed in full.
  if (l && clientEpoch != null && clientEpoch !== l.epoch) lastSeq = 0;
  if (!l || l.events.length === 0) {
    // No retained events. If lastSeq is already at/over the counter the client
    // is current (nothing to do); otherwise we can't reconstruct — fall back.
    if (l && (Number(lastSeq) || 0) >= l.seq) return { ok: true, events: [], seq: l.seq, epoch: l.epoch };
    return { ok: false };
  }
  lastSeq = Number(lastSeq) || 0;
  if (lastSeq >= l.seq) return { ok: true, events: [], seq: l.seq, epoch: l.epoch }; // already current
  const minSeq = l.events[0].seq;
  if (lastSeq < minSeq - 1) return { ok: false }; // gap — older events were trimmed
  const events = l.events.filter((e) => e.seq > lastSeq).map((e) => e.data);
  return { ok: true, events, seq: l.seq, epoch: l.epoch };
}

function clear(sid) {
  logs.delete(sid);
  _unpersist(sid);
}

module.exports = { startTurn, record, currentSeq, currentEpoch, replaySince, clear, loadFromDisk, LOGGABLE };
