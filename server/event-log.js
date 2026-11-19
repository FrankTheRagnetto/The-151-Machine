// Append-only system event log — Phase 1 of the "151 Observatory".
//
// Every meaningful action stamps ONE JSON line here, so the system can later
// see itself: usage frequency by team, turn speed, token cost. This converts
// the retroactive log-mention *proxies* into ground truth.
//
// Hard rule: this must NEVER throw into a hot path. A logging failure cannot be
// allowed to break a chat turn, a deploy, or shutdown — every write is
// fire-and-forget and wrapped. Kill switch: set EVENTS_LOG=0.
//
// Storage: ~/.151machine/events/events.jsonl (one event per line, append-only,
// no rotation yet — JSONL stays cheap; revisit if it ever gets large). Lives
// under ~/.151machine so the existing nightly backup copies it too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotateIfLarge } = require('./log-rotate');

const ENABLED = process.env.EVENTS_LOG !== '0';
const EVENTS_DIR = process.env.EVENTS_DIR
  || path.join(os.homedir(), '.151machine', 'events');
const EVENTS_FILE = path.join(EVENTS_DIR, 'events.jsonl');
// Size cap (1 generation kept as events.jsonl.1). ~5 MB ≈ many months at the
// current ~1 MB/month rate, so a live soak never trips it — this only stops
// unbounded growth over the long run. (The rare shell appends from deploy.sh
// bypass this; they're tiny + infrequent and just re-create the fresh file.)
const EVENTS_MAX_BYTES = Number(process.env.EVENTS_MAX_BYTES) || 5 * 1024 * 1024;

let _ready = false;
function ensureDir() {
  if (_ready) return;
  try { fs.mkdirSync(EVENTS_DIR, { recursive: true }); _ready = true; } catch { /* ignore */ }
}

// logEvent('turn', { session, team, duration_ms, tools, ... })
function logEvent(event, fields = {}) {
  if (!ENABLED) return;
  try {
    ensureDir();
    rotateIfLarge(EVENTS_FILE, EVENTS_MAX_BYTES);
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n';
    fs.appendFile(EVENTS_FILE, line, () => { /* fire-and-forget */ });
  } catch { /* never throw into a hot path */ }
}

module.exports = { logEvent, EVENTS_FILE };
