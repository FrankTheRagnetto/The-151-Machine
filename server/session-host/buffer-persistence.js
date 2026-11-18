/**
 * buffer-persistence.js — Phase 6 crash-safe daemon buffer.
 *
 * Context
 * -------
 * The daemon holds a ~2MB RAM ring buffer per session. Phase 5a replay reads
 * that buffer on WS join so clients don't see empty responses after a pm2
 * restart of the MAIN server. The unsolved failure mode: simultaneous death
 * of daemon + main (power outage, Windows hard reboot, kernel panic). RAM-only
 * buffer dies with the daemon → replay has nothing to replay → amnesia.
 *
 * This module mirrors the RAM buffer to disk so that on daemon restart we can
 * rehydrate each session's buffer from `data/session-buffers/<sid>.jsonl`
 * before any client reconnects. Replay then works across a joint crash.
 *
 * File format
 * -----------
 * One file per session, newline-delimited JSON. Each line:
 *   { t: <epoch ms>, s: "stdout"|"stderr", d: "<base64 bytes>" }
 * Base64 so raw bytes (CRLF, NULs, invalid UTF-8) survive line wrapping.
 *
 * Size contract
 * -------------
 *   FILE_CAP_BYTES   2 MB  — matches RAM ring-buffer byte budget
 *   On overflow: rename current file → `<sid>.jsonl.old` (replacing any prior
 *   .old), start fresh. Keep at most 1 .old. Total disk cap ≈ 4 MB/session.
 *
 * Write strategy
 * --------------
 * Per-session pending queue flushed every FLUSH_INTERVAL_MS (250ms). Chunks
 * arrive sub-millisecond; appending per chunk would thrash disk.
 * `flushNow(sid)` is called by the daemon's `flushBufferTo` path so replay
 * always sees the freshest bytes. Writes are async (fs.promises.appendFile),
 * never sync — the daemon must stay responsive on the pipe path.
 *
 * Hydration
 * ---------
 * On daemon boot, `hydrateAll()` scans the buffer dir and returns a Map of
 * sessionId → Array<{stream, data}> matching the daemon's in-memory shape.
 * Corruption handling: if the primary file has a malformed trailing line we
 * read all complete lines and drop the partial one. If JSON.parse fails
 * mid-file we fall back to `<sid>.jsonl.old`; if that also fails we log and
 * skip that session rather than crash boot.
 *
 * Cleanup
 * -------
 * On boot, delete files whose mtime > MAX_AGE_DAYS (30) so orphan files from
 * long-dead sessions don't grow the directory forever.
 *
 * Graceful degradation
 * --------------------
 * Every disk op is wrapped in try/catch. Disk full, EACCES, ENOSPC, etc. log
 * the error once per session and bail out of persistence for that session —
 * we NEVER crash the daemon over a disk problem. The in-memory buffer remains
 * the source of truth for live streaming.
 *
 * Zero deps (pure Node).
 */

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const BUFFER_DIR = path.join(
  path.resolve(__dirname, '..', '..'),  // .../151-terminal
  'data',
  'session-buffers'
);

const FILE_CAP_BYTES = 2 * 1024 * 1024;      // 2 MB per .jsonl (matches RAM buffer)
const FLUSH_INTERVAL_MS = 250;
const MAX_AGE_DAYS = 30;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

// Per-session state: { pending: [lines], size: currentFileBytes, writing: bool, disabled: bool }
const _state = new Map();
let _flushTimer = null;
let _logger = console;

function _setLogger(l) { if (l) _logger = l; }

function _filePath(sid) {
  return path.join(BUFFER_DIR, `${sid}.jsonl`);
}
function _oldPath(sid) {
  return path.join(BUFFER_DIR, `${sid}.jsonl.old`);
}

function _ensureDirSync() {
  try { fs.mkdirSync(BUFFER_DIR, { recursive: true }); } catch (err) {
    _logger.error && _logger.error('[buffer-persistence] mkdir failed:', err.message);
  }
}

function _getState(sid) {
  let st = _state.get(sid);
  if (!st) {
    st = { pending: [], size: 0, writing: false, disabled: false };
    // Seed size from existing file so rotation math is correct after hydrate.
    try {
      const stat = fs.statSync(_filePath(sid));
      st.size = stat.size;
    } catch { /* file doesn't exist yet */ }
    _state.set(sid, st);
  }
  return st;
}

function _ensureTimer() {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    // Snapshot keys — avoid iterating a map that may mutate during await.
    const sids = Array.from(_state.keys());
    for (const sid of sids) _flushSession(sid).catch(() => { /* logged in _flushSession */ });
  }, FLUSH_INTERVAL_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

function _encode(stream, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return JSON.stringify({ t: Date.now(), s: stream, d: bytes.toString('base64') }) + '\n';
}

/**
 * Buffer a chunk for async append. Non-blocking. Called from the daemon's
 * forward() handler (stdout/stderr 'data' events).
 */
function append(sid, stream, data) {
  if (!sid || !stream) return;
  const st = _getState(sid);
  if (st.disabled) return;
  try {
    const line = _encode(stream, data);
    st.pending.push(line);
    _ensureTimer();
  } catch (err) {
    _logger.error && _logger.error('[buffer-persistence] encode failed:', err.message);
  }
}

async function _rotateIfNeeded(sid, st, pendingBytes) {
  if (st.size + pendingBytes <= FILE_CAP_BYTES) return;
  const cur = _filePath(sid);
  const old = _oldPath(sid);
  try {
    // Remove any prior .old (cap retention at 1).
    try { await fsp.unlink(old); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    try { await fsp.rename(cur, old); } catch (err) {
      // If cur doesn't exist (e.g. first write), nothing to rotate.
      if (err.code !== 'ENOENT') throw err;
    }
    st.size = 0;
    _logger.log && _logger.log('[buffer-persistence] rotated', sid);
  } catch (err) {
    _logger.error && _logger.error('[buffer-persistence] rotate failed:', sid, err.message);
    // Rotation failed — disable this session's persistence to avoid runaway.
    st.disabled = true;
  }
}

async function _flushSession(sid) {
  const st = _state.get(sid);
  if (!st || st.disabled) return;
  if (st.writing) return;              // one-at-a-time per session
  if (!st.pending.length) return;
  st.writing = true;
  const batch = st.pending;
  st.pending = [];
  const payload = batch.join('');
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  try {
    _ensureDirSync();
    await _rotateIfNeeded(sid, st, payloadBytes);
    if (st.disabled) return;
    await fsp.appendFile(_filePath(sid), payload, 'utf8');
    st.size += payloadBytes;
  } catch (err) {
    // Disk full, permissions, etc. — degrade to RAM-only for this session.
    _logger.error && _logger.error('[buffer-persistence] append failed for', sid, err.message);
    st.disabled = true;
  } finally {
    st.writing = false;
  }
}

/**
 * Force-flush a single session. Called from the daemon's flushBufferTo right
 * before a client replay, so the replayed stream is as fresh as possible.
 * Awaits completion (hundreds of µs on SSD; fine for the one-shot replay path).
 */
async function flushNow(sid) {
  try { await _flushSession(sid); } catch { /* already logged */ }
}

/**
 * Purge a session's on-disk buffer. Called from doSpawn's orphan-kill path so
 * the new child starts with a clean slate (matches RAM behavior).
 */
async function purge(sid) {
  _state.delete(sid);
  const attempts = [_filePath(sid), _oldPath(sid)];
  for (const p of attempts) {
    try { await fsp.unlink(p); }
    catch (err) { if (err.code !== 'ENOENT') _logger.error && _logger.error('[buffer-persistence] purge', p, err.message); }
  }
}

/**
 * Parse one buffer file into an array of {stream, data} entries.
 * Tolerant of a truncated trailing line (partial write before crash).
 * Throws if the file is so corrupted that no complete line parses.
 */
function _parseFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const out = [];
  let sawGoodLine = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // If this is the last chunk and it has no trailing newline, it might be
    // a partial write. Try to parse anyway; on failure, drop silently.
    const isTrailing = (i === lines.length - 1);
    try {
      const obj = JSON.parse(line);
      if (obj && obj.s && typeof obj.d === 'string') {
        const data = Buffer.from(obj.d, 'base64').toString('utf8');
        out.push({ stream: obj.s, data });
        sawGoodLine = true;
      }
    } catch (err) {
      if (isTrailing) continue;  // partial write at EOF — expected after crash
      // Mid-file parse failure → corruption. Bail, caller tries .old.
      throw new Error(`parse failure at line ${i}: ${err.message}`);
    }
  }
  if (!sawGoodLine && lines.some((l) => l.length)) {
    throw new Error('no parseable lines');
  }
  return out;
}

/**
 * Hydrate buffers from disk. Returns Map<sid, Array<{stream, data}>>.
 * Also seeds `_state[sid].size` so post-hydrate rotation is correct.
 * Idempotent — safe to call once at boot.
 */
function hydrateAll() {
  const result = new Map();
  _ensureDirSync();
  let files;
  try {
    files = fs.readdirSync(BUFFER_DIR);
  } catch (err) {
    _logger.error && _logger.error('[buffer-persistence] readdir failed:', err.message);
    return result;
  }
  const primaries = files.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.old'));
  for (const fname of primaries) {
    const sid = fname.slice(0, -'.jsonl'.length);
    const primary = path.join(BUFFER_DIR, fname);
    const old = _oldPath(sid);
    let entries = null;
    try {
      entries = _parseFile(primary);
    } catch (err) {
      _logger.error && _logger.error('[buffer-persistence] primary corrupt for', sid, err.message);
      try {
        entries = _parseFile(old);
        _logger.log && _logger.log('[buffer-persistence] recovered', sid, 'from .old');
      } catch (err2) {
        _logger.error && _logger.error('[buffer-persistence] .old also failed for', sid, err2.message || 'not present');
        continue;
      }
    }
    if (!entries) continue;
    // Seed state so the next append knows the on-disk file size.
    let sz = 0;
    try { sz = fs.statSync(primary).size; } catch {}
    _state.set(sid, { pending: [], size: sz, writing: false, disabled: false });
    result.set(sid, entries);
    _logger.log && _logger.log('[buffer-persistence] hydrated', sid, 'entries=' + entries.length, 'bytes=' + sz);
  }
  return result;
}

/**
 * Cleanup: delete buffer files older than MAX_AGE_DAYS. Safe to run on boot.
 */
function cleanupOld() {
  _ensureDirSync();
  let files;
  try { files = fs.readdirSync(BUFFER_DIR); } catch { return; }
  const now = Date.now();
  let deleted = 0;
  for (const fname of files) {
    if (!fname.endsWith('.jsonl') && !fname.endsWith('.jsonl.old')) continue;
    const full = path.join(BUFFER_DIR, fname);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch (err) {
      _logger.error && _logger.error('[buffer-persistence] cleanup error', fname, err.message);
    }
  }
  if (deleted) _logger.log && _logger.log('[buffer-persistence] cleanup deleted', deleted, 'old files');
}

/**
 * Test / shutdown helper — stops the flush timer and drains pending batches.
 * Returns a Promise that resolves once all in-flight appends complete.
 */
async function drainAndStop() {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  const sids = Array.from(_state.keys());
  for (const sid of sids) await _flushSession(sid);
}

/**
 * Test helper — wipe the buffer dir + in-memory state. Never call from daemon.
 */
function _testReset() {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  _state.clear();
  try {
    const files = fs.readdirSync(BUFFER_DIR);
    for (const f of files) {
      try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch {}
    }
  } catch {}
}

/**
 * Test helper — clear ONLY the in-memory state, leaving files on disk.
 * Simulates a daemon crash (RAM gone, disk intact). Never call from daemon.
 */
function _testResetMemoryOnly() {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  _state.clear();
}

module.exports = {
  append,
  flushNow,
  purge,
  hydrateAll,
  cleanupOld,
  drainAndStop,
  _setLogger,
  _testReset,
  _testResetMemoryOnly,
  BUFFER_DIR,
  FILE_CAP_BYTES,
  FLUSH_INTERVAL_MS,
  MAX_AGE_DAYS,
};
