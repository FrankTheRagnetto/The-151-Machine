/**
 * restart-journal.js — Restart-amnesia fix (Odysseus steal follow-up).
 *
 * Problem
 * -------
 * When the server restarts (deploy / crash / memory-watchdog) while a chat turn
 * is in flight, the turn's tool side-effects are only durably recorded if the
 * turn finishes cleanly. An interrupted turn records nothing, so after the boot
 * the resumed session re-runs the original request blind ("amnesia") — e.g. it
 * re-deploys because it doesn't know it already deployed.
 *
 * This module is a DURABLE, per-session action journal written the MOMENT each
 * tool finishes (independent of whether the whole turn completes). On resume it
 * is read back and injected into the model's context so the session comes back
 * knowing what it already did.
 *
 * Design (mirrors memory-engine.js):
 *  - Store is OUTSIDE the repo (~/.151machine/restart-journal/) so deploy/git
 *    never clobber it. Env override RESTART_JOURNAL_DIR.
 *  - One append-only .jsonl per session. Append (not atomic-rewrite) — like
 *    restart-history.jsonl — so a live write is cheap and crash-safe.
 *  - A clean turn boundary DELETES the session file (the turn finished, no
 *    amnesia risk). A restart-kill skips that delete, so the file survives = the
 *    evidence the resumed turn reads.
 *  - Flag-gated by RESTART_MEMORY. Off ⇒ every export is inert (early return),
 *    nothing is written or read, behavior byte-identical to before.
 *
 * Zero external deps. Never throws into the live response path (all wrapped).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const JOURNAL_DIR = process.env.RESTART_JOURNAL_DIR
  || path.join(os.homedir(), '.151machine', 'restart-journal');

const MAX_VAL = 140;       // truncate tool input/result to this many chars
const DEFAULT_TAIL = 8;    // journal lines surfaced to the model on resume
const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // delete stale files > 7 days
const PRUNE_MAX_FILES = 50;                        // hard cap on file count

function _on() { return !!process.env.RESTART_MEMORY; }

function _ensureDir() { try { fs.mkdirSync(JOURNAL_DIR, { recursive: true }); } catch {} }

// Session ids are uuids, but be defensive — never let a crafted id escape the dir.
function _fileFor(sessionId) {
  const safe = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  return path.join(JOURNAL_DIR, safe + '.jsonl');
}

function _trunc(v) {
  let s;
  if (v == null) s = '';
  else if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_VAL ? s.slice(0, MAX_VAL) + '…' : s;
}

/**
 * Append one record. Fire-and-forget: called from setImmediate, fully wrapped.
 * @param {string} sessionId
 * @param {object} rec { kind?, tool?, input?, result?, isError? }
 */
function recordAction(sessionId, rec) {
  if (!_on()) return;
  try {
    const file = _fileFor(sessionId);
    if (!file) return;
    _ensureDir();
    const entry = {
      at: new Date().toISOString(),
      kind: rec.kind || 'tool',
      tool: rec.tool || 'unknown',
      input: _trunc(rec.input),
      result: _trunc(rec.result),
      isError: !!rec.isError,
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    // Never throw into the response path.
    try { console.error('[restart-journal] recordAction failed:', e.message); } catch {}
  }
}

/** Read the last N journal entries for a session (most-recent last). */
function readTail(sessionId, n = DEFAULT_TAIL) {
  if (!_on()) return [];
  try {
    const file = _fileFor(sessionId);
    if (!file || !fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-n);
    const out = [];
    for (const ln of tail) { try { out.push(JSON.parse(ln)); } catch {} }
    return out;
  } catch (e) {
    try { console.error('[restart-journal] readTail failed:', e.message); } catch {}
    return [];
  }
}

/** Delete a session's journal file. Called on clean turn completion. */
function clearSession(sessionId) {
  if (!_on()) return;
  try {
    const file = _fileFor(sessionId);
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    try { console.error('[restart-journal] clearSession failed:', e.message); } catch {}
  }
}

/**
 * Prune stale/excess journal files so they never accumulate forever.
 * Deletes files older than PRUNE_MAX_AGE_MS, then enforces PRUNE_MAX_FILES
 * (oldest-first). Safe to call on boot. Fully wrapped.
 */
function prune() {
  if (!_on()) return;
  try {
    if (!fs.existsSync(JOURNAL_DIR)) return;
    const now = Date.now();
    let files = fs.readdirSync(JOURNAL_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(JOURNAL_DIR, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        return { full, mtime };
      });
    // Age-based prune.
    for (const f of files) {
      if (now - f.mtime > PRUNE_MAX_AGE_MS) {
        try { fs.unlinkSync(f.full); } catch {}
        f._deleted = true;
      }
    }
    files = files.filter((f) => !f._deleted);
    // Count cap (oldest first).
    if (files.length > PRUNE_MAX_FILES) {
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files.slice(0, files.length - PRUNE_MAX_FILES)) {
        try { fs.unlinkSync(f.full); } catch {}
      }
    }
  } catch (e) {
    try { console.error('[restart-journal] prune failed:', e.message); } catch {}
  }
}

/**
 * Build the system-prompt note injected into a resumed turn.
 * @param {object} banner   lastRestartBanner ({ at, reason })
 * @param {Array}  entries  readTail() output
 * @returns {string} '' when nothing to say.
 */
function formatNote(banner, entries) {
  if (!_on()) return '';
  if (!entries || !entries.length) return '';
  let when = '';
  if (banner && banner.at) {
    try {
      when = ' at ' + new Date(banner.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {}
  }
  const reason = banner && banner.reason ? ` (${banner.reason})` : '';
  const lines = entries.map((e) => {
    const status = e.isError ? 'FAILED' : 'ok';
    if (e.kind === 'partial_text') {
      return `  • [you had started replying]: ${e.result || e.input || ''}`;
    }
    const inp = e.input ? ` ${e.input}` : '';
    const res = e.result ? ` → ${e.result}` : '';
    return `  • ${e.tool}${inp}${res} [${status}]`;
  });
  return `\n\n⚠ SERVER RESTART RECOVERY: the server restarted${when}${reason} while THIS session had a turn in flight. Before the restart, in this session you had already run:\n${lines.join('\n')}\nVerify the current state before repeating any of these — do NOT blindly re-run an action (e.g. a deploy/commit) that may have already completed. Continue from where you left off.`;
}

module.exports = {
  recordAction,
  readTail,
  clearSession,
  prune,
  formatNote,
  JOURNAL_DIR,
};
