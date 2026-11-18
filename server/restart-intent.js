/**
 * restart-intent.js — Amnesia-fix Phase 4 helper.
 *
 * Contract
 * --------
 * A restart-intent file is a short JSON describing WHO is about to restart the
 * 151-machine server and WHY. Every in-process restart path writes one BEFORE
 * killing the process (all of them go through server/restart-control.js).
 *
 * On boot, the NEW server process calls `readAndConsumeIntent()` once:
 *   - If the file exists → return the parsed entry, append to history, delete.
 *   - If the file does NOT exist → call `detectUnexpectedRestart()`. If the
 *     last recorded heartbeat shows an unexpected gap, synthesize an
 *     "unknown actor" entry and still append to history.
 *
 * The server caches the return value in memory as `lastRestartBanner` and
 * uses it for the boot log and the sessions' restart notes. (The old
 * `GET /api/restart-banner` + `/dismiss` routes were removed 2026-10-12: no
 * client read them any more.)
 *
 * On a live server, a 30s interval touches `server-heartbeat.json` so the
 * NEXT boot can detect surprise restarts (anything that killed the process
 * without writing an intent).
 *
 * Files (all under <repo>/system/)
 * --------------------------------
 *   restart-intent.json    ephemeral, one-shot; consumed on boot
 *   restart-history.jsonl  append-only log, one JSON object per line
 *   server-heartbeat.json  touched every 30s by the live server
 *
 * Atomicity: all writes go via writeFileSync to a .tmp then rename over the
 * target. The protected-path gate DOES NOT apply to Node fs.writeFile at
 * runtime (verified 2026-04-18) — the Claude Code sandbox blocks Write/Edit
 * tool calls only, not arbitrary child processes.
 *
 * Zero external deps. Do not import anything except 'fs', 'path',
 * 'child_process', 'os'.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Lives alongside the server code so it travels with the repo regardless of host.
// Pre-2026-05-18 this was a hardcoded Windows path that survived the Linux migration
// as a literal directory name — fixed 2026-05-27.
const SYSTEM_DIR = path.join(__dirname, '..', 'system');
const INTENT_PATH    = path.join(SYSTEM_DIR, 'restart-intent.json');
const HISTORY_PATH   = path.join(SYSTEM_DIR, 'restart-history.jsonl');
const HEARTBEAT_PATH = path.join(SYSTEM_DIR, 'server-heartbeat.json');
const CULPRIT_PATH   = path.join(SYSTEM_DIR, 'restart-culprit.json');
const POST_DEPLOY_VERIFY_PATH = path.join(SYSTEM_DIR, 'post-deploy-verify.json');

const HEARTBEAT_GAP_MS = 30 * 1000; // tolerate one missed tick
const GAP_THRESHOLD_MS = 45 * 1000; // > this since last heartbeat = suspicious
const CULPRIT_FRESH_MS = 90 * 1000; // a culprit older than this is unrelated to this restart
const POST_DEPLOY_FRESH_MS = 5 * 60 * 1000; // an armed verify older than this is stale → ignored

function safeIso() {
  return new Date().toISOString();
}

function tryGetCommitShort() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'),
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
}

function atomicWrite(targetPath, data) {
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, targetPath);
}

function appendHistoryLine(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[restart-intent] appendHistoryLine failed:', err.message);
  }
}

/**
 * Write an intent file. Called BEFORE a restart is initiated.
 * @param {object} opts
 * @param {string} opts.actor  e.g. 'deploy-endpoint', 'watchdog', 'session-id:abc'
 * @param {string} opts.reason short human-readable reason
 * @param {string} [opts.detail] optional longer detail
 */
function writeIntent({ actor, reason, detail }) {
  const entry = {
    at: safeIso(),
    actor: actor || 'unknown',
    reason: reason || 'no reason',
    detail: detail || null,
    commit: tryGetCommitShort(),
    pid: process.pid,
  };
  try {
    fs.mkdirSync(SYSTEM_DIR, { recursive: true });
    atomicWrite(INTENT_PATH, JSON.stringify(entry, null, 2));
  } catch (err) {
    console.error('[restart-intent] writeIntent failed:', err.message);
  }
  return entry;
}

/**
 * Read, consume, archive. Called ONCE on server boot.
 * Returns the intent entry or null.
 * On success: appends to history, deletes the intent file.
 */
function readAndConsumeIntent() {
  let entry = null;
  try {
    if (fs.existsSync(INTENT_PATH)) {
      const raw = fs.readFileSync(INTENT_PATH, 'utf8');
      entry = JSON.parse(raw);
      appendHistoryLine(entry);
      try { fs.unlinkSync(INTENT_PATH); } catch {}
      return entry;
    }
  } catch (err) {
    console.error('[restart-intent] readAndConsumeIntent failed:', err.message);
  }
  return null;
}

/**
 * No intent was found. Inspect the heartbeat file to classify the restart:
 *   - Heartbeat gap > GAP_THRESHOLD_MS → "unattributed restart" (crash-like).
 *   - Heartbeat gap small OR missing    → "manual / quick restart" (still a restart!).
 * We ALWAYS synthesize something so the user sees a banner on every boot that
 * didn't write an intent. No blind spots. Appends to history either way.
 */
function detectUnexpectedRestart() {
  let gapMs = null;
  let hbPid = null;
  try {
    if (fs.existsSync(HEARTBEAT_PATH)) {
      const raw = fs.readFileSync(HEARTBEAT_PATH, 'utf8');
      const hb = JSON.parse(raw);
      const lastTs = Date.parse(hb.ts);
      if (Number.isFinite(lastTs)) gapMs = Date.now() - lastTs;
      hbPid = hb.pid || null;
    }
  } catch (err) {
    console.error('[restart-intent] detectUnexpectedRestart read failed:', err.message);
  }
  const unattributed = gapMs != null && gapMs >= GAP_THRESHOLD_MS;
  const actor  = unattributed ? 'unknown' : 'system';
  const reason = unattributed ? 'unattributed restart' : 'server restarted';
  let detail;
  if (gapMs == null) {
    detail = 'no intent, no prior heartbeat — first boot or fresh install';
  } else if (unattributed) {
    detail = `no intent recorded; last heartbeat ${Math.round(gapMs / 1000)}s ago (pid ${hbPid || '?'})`;
  } else {
    detail = `quick restart (last heartbeat ${Math.round(gapMs / 1000)}s ago, pid ${hbPid || '?'}) — likely manual pm2 restart or fast deploy without intent`;
  }
  const entry = {
    at: safeIso(),
    actor,
    reason,
    detail,
    commit: tryGetCommitShort(),
    pid: process.pid,
  };
  try { appendHistoryLine(entry); } catch {}
  return entry;
}

/**
 * Restart ATTRIBUTION ("who did it").
 *
 * A restart triggered FROM a chat session (e.g. the session ran `bash
 * tools/deploy.sh`, `pm2 restart`, or curl'd /api/deploy) kills the server
 * before the triggering tool even finishes — so we can't wait for tool_done to
 * learn who did it. Instead the stream handler calls `recordCulprit()` the
 * instant it SEES such a command (tool_use), stamping the session id + title.
 * On the next boot, `readAndConsumeCulprit()` hands the name to the banner.
 * Ephemeral + one-shot like the intent file; a freshness window guards against
 * an old, unrelated deploy command being blamed for a later surprise restart.
 */
function recordCulprit({ sessionId, title, command }) {
  try {
    fs.mkdirSync(SYSTEM_DIR, { recursive: true });
    atomicWrite(CULPRIT_PATH, JSON.stringify({
      at: safeIso(),
      sessionId: sessionId || null,
      title: title || null,
      command: command ? String(command).slice(0, 200) : null,
    }));
  } catch (err) {
    console.error('[restart-intent] recordCulprit failed:', err.message);
  }
}

function readAndConsumeCulprit() {
  try {
    if (!fs.existsSync(CULPRIT_PATH)) return null;
    const raw = fs.readFileSync(CULPRIT_PATH, 'utf8');
    const c = JSON.parse(raw);
    try { fs.unlinkSync(CULPRIT_PATH); } catch {}
    const ts = Date.parse(c.at);
    if (!Number.isFinite(ts) || Date.now() - ts > CULPRIT_FRESH_MS) return null;
    return c;
  } catch (err) {
    console.error('[restart-intent] readAndConsumeCulprit failed:', err.message);
    return null;
  }
}

/**
 * POST-DEPLOY VERIFY ARMING ("a restart is coming — verify it on the way back").
 *
 * This is the ARM half of the arm-then-restart contract. EVERY restart funnel
 * (the in-process restart() helper AND the stream-handler chokepoint that sees a
 * session fire a deploy/pm2 command) calls this BEFORE the process can die. On
 * the next boot the resume loop reads the armed marker and injects ONE read-only
 * verification turn into the session that triggered the restart, so it reports
 * back unprompted instead of sitting frozen.
 *
 * Why arm explicitly instead of reconstructing intent on boot: the old approach
 * guessed ("is the culprit command a deploy?") with a regex that drifted out of
 * sync and missed external pm2/manual restarts. Arming records the truth at the
 * source — nonced (so a stale marker can't masquerade as a fresh arm), carrying
 * the intent string (the actual command/reason), keyed by session id.
 *
 * Contract:
 *   - sessionId REQUIRED to mean anything — a restart with no triggering session
 *     (e.g. the memory watchdog) has nothing to verify, so we no-op. The funnel
 *     still "armed"; there was simply no target.
 *   - The marker SELF-DELETES the moment the verify fires (clearArmedVerify),
 *     and readArmedVerify deletes anything past POST_DEPLOY_FRESH_MS. So an
 *     arm-but-fail restart can never spuriously fire a verify minutes later.
 */
function armPostDeployVerify({ sessionId, intent } = {}) {
  if (!sessionId) return null; // nothing to verify without a triggering session
  const entry = {
    nonce: crypto.randomBytes(8).toString('hex'),
    sessionId,
    intent: intent ? String(intent).slice(0, 200) : null,
    at: safeIso(),
  };
  try {
    fs.mkdirSync(SYSTEM_DIR, { recursive: true });
    atomicWrite(POST_DEPLOY_VERIFY_PATH, JSON.stringify(entry));
  } catch (err) {
    console.error('[restart-intent] armPostDeployVerify failed:', err.message);
    return null;
  }
  return entry;
}

/**
 * Read the armed verify marker. Returns the fresh entry, or null. If the marker
 * is older than POST_DEPLOY_FRESH_MS it is treated as stale, DELETED, and null
 * is returned (so a crashed/aborted arm can never fire late). Does NOT delete a
 * fresh marker — the caller deletes it the instant it acts on it.
 */
function readArmedVerify() {
  try {
    if (!fs.existsSync(POST_DEPLOY_VERIFY_PATH)) return null;
    const raw = fs.readFileSync(POST_DEPLOY_VERIFY_PATH, 'utf8');
    const entry = JSON.parse(raw);
    const ts = Date.parse(entry && entry.at);
    if (!Number.isFinite(ts) || Date.now() - ts > POST_DEPLOY_FRESH_MS) {
      try { fs.unlinkSync(POST_DEPLOY_VERIFY_PATH); } catch {}
      return null;
    }
    return entry;
  } catch (err) {
    console.error('[restart-intent] readArmedVerify failed:', err.message);
    return null;
  }
}

/** Delete the armed verify marker. Called the MOMENT the verify turn fires. */
function clearArmedVerify() {
  try { fs.unlinkSync(POST_DEPLOY_VERIFY_PATH); } catch {}
}

/**
 * Atomic heartbeat write. Call every 30s from the live server.
 */
function touchHeartbeat() {
  try {
    fs.mkdirSync(SYSTEM_DIR, { recursive: true });
    atomicWrite(HEARTBEAT_PATH, JSON.stringify({ ts: safeIso(), pid: process.pid }));
  } catch (err) {
    // Silent — heartbeat failures should never crash the server.
  }
}

/**
 * Convenience: start the heartbeat interval. Returns the timer handle so the
 * caller can clearInterval() if they want to. Unrefs so it never blocks exit.
 */
function startHeartbeat(intervalMs) {
  const ms = intervalMs || HEARTBEAT_GAP_MS;
  touchHeartbeat();
  const t = setInterval(touchHeartbeat, ms);
  if (t.unref) t.unref();
  return t;
}

module.exports = {
  writeIntent,
  readAndConsumeIntent,
  detectUnexpectedRestart,
  recordCulprit,
  readAndConsumeCulprit,
  armPostDeployVerify,
  readArmedVerify,
  clearArmedVerify,
  touchHeartbeat,
  startHeartbeat,
  INTENT_PATH,
  HISTORY_PATH,
  HEARTBEAT_PATH,
  CULPRIT_PATH,
  POST_DEPLOY_VERIFY_PATH,
};
