'use strict';

/**
 * M9 Fase C · Vettore 6 — draft-pinned attachment registry.
 *
 * Option A (upload-on-add): the client uploads an attachment the instant it's
 * attached (before the chat message is sent) and persists ONLY the returned ref
 * (path/name/mime/size) in its per-session draft (localStorage). The blob is NOT
 * kept client-side, so after a reload/restart the client can no longer re-upload
 * it — the file MUST survive on the server.
 *
 * The boot orphan-sweep (attachment-cleanup.js) deletes any attachment file that
 * no session history references. A draft-attached-but-never-sent file is exactly
 * such a file, so without protection the sweep would delete it and the persisted
 * draft ref would dangle. This registry records those still-in-a-draft paths so
 * the sweep treats them as "alive".
 *
 * Storage: atomic (temp+rename) JSON at ~/.151machine/draft-attachments.json —
 * outside the repo (never committed), under .151machine (backup-mirrorable),
 * same convention as alert-center / restart-journal. Keyed by absolute path
 * (globally unique) → { sid, ts }.
 *
 * Gating is the CALLER's job (RESTART_MEMORY, PC-only) — mirrors the sweep it
 * cooperates with. This module is pure + side-effect-free on require.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.151machine');
const STORE_FILE = path.join(STORE_DIR, 'draft-attachments.json');
// Copia rotante dell'ultimo registro buono. Un parse fallito sul file
// principale NON deve valere "non c'e' niente": senza questa copia la prima
// _write() successiva riscriveva il registro davvero vuoto, e a quel punto
// attachment-cleanup.js (:76-80) non vedeva piu' nessun allegato "vivo" e
// cancellava i file delle bozze — che il client non sa piu' ricaricare.
// Stessa cura, identica, di server/session-manager.js (bakPath/load/save).
const BAK_FILE = STORE_FILE + '.bak';

// --- Scritture atomiche (copiate da server/session-manager.js) --------------
// Il nome del file temporaneo DEVE essere privato per ogni scrittura. Con il
// nome fisso `<target>.tmp` due scritture sovrapposte puntavano allo STESSO
// temporaneo: la prima lo rinominava sul bersaglio, la seconda non trovava
// piu' niente da rinominare e moriva con ENOENT — la scrittura era persa in
// silenzio. E' esattamente il difetto misurato in session-manager.js:134-144
// (114 scritture perse in 46 giorni). pid + contatore monotono + casuale
// tolgono il nome condiviso; l'ultimo rename() vince, che e' l'intento.
let _tmpSeq = 0;
function _tmpPathFor(targetPath) {
  _tmpSeq = (_tmpSeq + 1) % 1000000;
  return `${targetPath}.${process.pid}.${_tmpSeq}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}
function _atomicWriteSync(targetPath, data) {
  const tmp = _tmpPathFor(targetPath);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    // Non lasciare un temporaneo orfano; l'errore si propaga comunque.
    try { fs.unlinkSync(tmp); } catch { /* gia' sparito */ }
    throw err;
  }
}

function _read() {
  if (!fs.existsSync(STORE_FILE)) return {};
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch (mainErr) {
    // Il file principale e' corrotto. NON si ritorna vuoto in silenzio: si
    // prova la copia rotante, come fa session-manager.js:1480-1497.
    console.error(`[DRAFT-ATTACH] !!! draft-attachments.json parse FAILED (${mainErr.message}) — attempting .bak recovery`);
    try {
      if (!fs.existsSync(BAK_FILE)) throw new Error('no .bak present');
      obj = JSON.parse(fs.readFileSync(BAK_FILE, 'utf-8'));
      console.error('[DRAFT-ATTACH] !!! Recovered draft pins from draft-attachments.json.bak — attachments preserved');
    } catch (bakErr) {
      console.error(`[DRAFT-ATTACH] !!! .bak recovery also FAILED (${bakErr.message}) — starting empty`);
      return {};
    }
  }
  return (obj && typeof obj === 'object') ? obj : {};
}

function _write(obj) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const data = JSON.stringify(obj);
    _atomicWriteSync(STORE_FILE, data);
    // Scrittura principale riuscita: rispecchia sulla copia rotante
    // (ultimo buono noto), stessa sequenza di session-manager.js:1466-1478.
    try { _atomicWriteSync(BAK_FILE, data); }
    catch (bErr) { console.error('[DRAFT-ATTACH] backup write failed:', bErr.message); }
  } catch (e) {
    console.error('[DRAFT-ATTACH] write failed:', e.message);
  }
}

/** Pin one or more absolute attachment paths to a session's draft. */
function pin(sessionId, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const store = _read();
  let changed = false;
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    store[path.resolve(p)] = { sid: sessionId || null, ts: Date.now() };
    changed = true;
  }
  if (changed) _write(store);
}

/** Unpin specific paths (draft cleared / attachment removed / message sent). */
function unpin(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const store = _read();
  let changed = false;
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const k = path.resolve(p);
    if (k in store) { delete store[k]; changed = true; }
  }
  if (changed) _write(store);
}

/**
 * All currently draft-pinned absolute paths that STILL exist on disk. Self-heals:
 * a pinned entry whose file is gone (sent+pruned elsewhere, or removed) is dropped
 * so the registry can't grow unbounded. Returns a Set for O(1) membership in the
 * sweep.
 */
function all() {
  const store = _read();
  const live = new Set();
  let changed = false;
  for (const k of Object.keys(store)) {
    if (fs.existsSync(k)) live.add(k);
    else { delete store[k]; changed = true; }
  }
  if (changed) _write(store);
  return live;
}

module.exports = { pin, unpin, all, STORE_FILE };
