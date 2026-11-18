/**
 * stream-partials.js — M9 Fase B, Vettore 4 (hard-crash full-text partial).
 *
 * Problem
 * -------
 * The periodic flush in session-manager.startStream() writes only a 100-char
 * PREVIEW (session.lastMessage) into sessions.json every 10s. The FULL in-flight
 * reply reaches `history` only on the GRACEFUL shutdown paths (index.js
 * gracefulShutdown / deploy). A HARD crash (SIGKILL / power / uncaughtException
 * with no drain) therefore loses the whole partial except those 100 chars.
 *
 * This module is a DURABLE, per-session full-text partial store written the same
 * 10s the preview flush runs. On boot an ORPHAN partial (one whose full text was
 * NOT already flushed into history by a graceful path) is ADOPTED into history as
 * { role:'assistant', content:<text>, partial:true } — byte-mirroring exactly
 * what the graceful flush at index.js writes (~2323). The turn's clean completion
 * (or a graceful adopt) DELETES the file so it never double-adopts.
 *
 * Design (mirrors restart-journal.js):
 *  - Store OUTSIDE the repo (~/.151machine/stream-partials/) so deploy/git never
 *    clobber it. Env override STREAM_PARTIALS_DIR.
 *  - One atomic .json per session (temp+rename — copied from restart-intent.js).
 *  - Flag-gated by RESTART_MEMORY. Off ⇒ every export is inert (early return),
 *    nothing is written, read, or deleted; behavior byte-identical to before.
 *
 * Zero external deps. Never throws into the live response path (all wrapped).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PARTIALS_DIR = process.env.STREAM_PARTIALS_DIR
  || path.join(os.homedir(), '.151machine', 'stream-partials');

const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // delete stale files > 7 days
const PRUNE_MAX_FILES = 50;                        // hard cap on file count

function _on() { return !!process.env.RESTART_MEMORY; }

function _ensureDir() { try { fs.mkdirSync(PARTIALS_DIR, { recursive: true }); } catch {} }

// Session ids are uuids; be defensive — never let a crafted id escape the dir.
function _fileFor(sessionId) {
  const safe = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  return path.join(PARTIALS_DIR, safe + '.json');
}

function _atomicWrite(targetPath, data) {
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, targetPath);
}

/**
 * Write/overwrite the full-text partial for a session. Called (flag-gated) from
 * the 10s stream flush. Fully wrapped — never throws into the response path.
 * @param {string} sessionId
 * @param {string} text            the FULL buf.text so far
 * @param {string} [claudeSessionId]
 */
function writePartial(sessionId, text, claudeSessionId) {
  if (!_on()) return;
  try {
    if (typeof text !== 'string' || !text) return;
    const file = _fileFor(sessionId);
    if (!file) return;
    _ensureDir();
    _atomicWrite(file, JSON.stringify({
      sessionId,
      text,
      claudeSessionId: claudeSessionId || null,
      at: new Date().toISOString(),
    }));
  } catch (e) {
    try { console.error('[stream-partials] writePartial failed:', e.message); } catch {}
  }
}

/** Delete a session's partial file. Called on clean turn completion / clearStream. */
function clearPartial(sessionId) {
  if (!_on()) return;
  try {
    const file = _fileFor(sessionId);
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    try { console.error('[stream-partials] clearPartial failed:', e.message); } catch {}
  }
}

/**
 * Read one session's partial ({ sessionId, text, claudeSessionId, at }) or null.
 */
function readPartial(sessionId) {
  if (!_on()) return null;
  try {
    const file = _fileFor(sessionId);
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    try { console.error('[stream-partials] readPartial failed:', e.message); } catch {}
    return null;
  }
}

/**
 * BOOT ADOPT. For every on-disk partial, adopt its full text into the owning
 * session's history as { role:'assistant', content:<text>, partial:true } —
 * mirroring the graceful flush at index.js — UNLESS the session already carries
 * that text (a graceful path already flushed it, so this would double-adopt).
 * Idempotent: the file is DELETED after adopt (or after finding it already
 * represented), so a second boot never re-adopts.
 *
 * @param {SessionManager} manager   the live manager (sessions already loaded)
 * @returns {number} how many partials were adopted into history
 */
function adoptOrphans(manager) {
  if (!_on()) return 0;
  let adopted = 0;
  try {
    if (!fs.existsSync(PARTIALS_DIR)) return 0;
    const files = fs.readdirSync(PARTIALS_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const full = path.join(PARTIALS_DIR, f);
      let entry;
      try { entry = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { entry = null; }
      // Malformed / empty → drop it, nothing to adopt.
      if (!entry || typeof entry.text !== 'string' || !entry.text || !entry.sessionId) {
        try { fs.unlinkSync(full); } catch {}
        continue;
      }
      const session = manager.sessions && manager.sessions.get(entry.sessionId);
      // Session gone (deleted/purged) → nothing to adopt into; clean up.
      if (!session) { try { fs.unlinkSync(full); } catch {} continue; }

      // IDEMPOTENCY GUARD: if the LAST assistant message already holds this text
      // (a graceful flush beat us to it, or a prior boot adopted it), do NOT add
      // a duplicate. We compare against the full text AND the graceful-mark
      // suffix that Fase A (vector 1) may have appended to it.
      const hist = Array.isArray(session.history) ? session.history : [];
      const last = hist[hist.length - 1];
      const alreadyPresent = !!(last
        && last.role === 'assistant'
        && typeof last.content === 'string'
        && (last.content === entry.text || last.content.startsWith(entry.text)));
      if (alreadyPresent) { try { fs.unlinkSync(full); } catch {} continue; }

      hist.push({ role: 'assistant', content: entry.text, partial: true });
      session.history = hist;
      session.lastMessage = entry.text.slice(0, 100);
      adopted += 1;
      try { fs.unlinkSync(full); } catch {}
    }
    if (adopted > 0) {
      try { manager.saveSync(); } catch {}
    }
  } catch (e) {
    try { console.error('[stream-partials] adoptOrphans failed:', e.message); } catch {}
  }
  return adopted;
}

/**
 * Prune stale/excess partial files so they never accumulate forever. Safe on
 * boot. Fully wrapped. Mirrors restart-journal.prune().
 */
function prune() {
  if (!_on()) return;
  try {
    if (!fs.existsSync(PARTIALS_DIR)) return;
    const now = Date.now();
    let files = fs.readdirSync(PARTIALS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(PARTIALS_DIR, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        return { full, mtime };
      });
    for (const f of files) {
      if (now - f.mtime > PRUNE_MAX_AGE_MS) {
        try { fs.unlinkSync(f.full); } catch {}
        f._deleted = true;
      }
    }
    files = files.filter((f) => !f._deleted);
    if (files.length > PRUNE_MAX_FILES) {
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files.slice(0, files.length - PRUNE_MAX_FILES)) {
        try { fs.unlinkSync(f.full); } catch {}
      }
    }
  } catch (e) {
    try { console.error('[stream-partials] prune failed:', e.message); } catch {}
  }
}

module.exports = {
  writePartial,
  clearPartial,
  readPartial,
  adoptOrphans,
  prune,
  PARTIALS_DIR,
};
