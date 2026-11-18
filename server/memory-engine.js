'use strict';
/**
 * Automatic background memory — Phase 2: keyed upsert (LibreChat steal, adapted to Node).
 *
 * WHAT CHANGED FROM PHASE 1 (append + Jaccard):
 *  - Memories are now KEYED records ({key, value, category, tokenCount, updated_at}).
 *    Re-mentioning a fact UPSERTS the same key (overwrite/correct) instead of
 *    appending a near-duplicate. Solves the "likes tea / prefers coffee now" drift
 *    a flat append log cannot resolve.
 *  - A dedicated cheap extractor SEES the current memories (with keys) and decides to
 *    set (upsert) or delete keys — not a blind dump of every turn.
 *  - Token budget (MEMORY_TOKEN_LIMIT) keeps injected memory bounded. Since 12/10/2026
 *    the budget maintains itself: a new key always gets in, and the OLDEST keys (by
 *    updated_at) leave the active store into memory-archive.jsonl (append-only,
 *    written before memory.json). See _makeRoom / _persist.
 *  - Store is v2: { version:2, memories:[...] }. Old v1 arrays are migrated on load
 *    (lossless 1:1, newer entry wins on key collision). The on-disk backup made before
 *    this deploy lives next to the store as memory.json.bak-pre-keyed-*.
 *
 * UNCHANGED (the safety contract):
 *  - Modeled on server/auto-title.js: a cheap one-shot, fully wrapped — can NEVER
 *    throw into the chat path. Fire-and-forget from the auto-memory plugin hook.
 *  - Store is a JSON file OUTSIDE the repo (~/.151machine/memory/) so deploys/git
 *    can never clobber it.
 *  - GATED by MEMORY_AUTO (feature on/off). Unset = fully inert.
 *  - Sub-flag MEMORY_KEYED (default ON): set MEMORY_KEYED=0 to fall back to the legacy
 *    append+Jaccard extraction (kill-switch) while keeping the same v2 store.
 *
 * Same export surface as Phase 1: maybeExtract, getMemoryPreface, clearSession,
 * _parseFacts, STORE (callers in session-manager.js + plugins/auto-memory unchanged).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { oneShotArgs } = require('./oneshot-args');

const CLAUDE_BIN = 'claude';
const MEMORY_DIR = process.env.MEMORY_DIR || path.join(os.homedir(), '.151machine', 'memory');
const STORE = path.join(MEMORY_DIR, 'memory.json');
// Copia rotante dell'ultimo store buono. Un parse fallito sul file principale
// NON deve valere "nessuna memoria": senza questa copia il primo _saveAtomic()
// successivo riscriveva lo store davvero vuoto e tutte le memorie sparivano
// senza che nessuno se ne accorgesse. Stessa cura, identica, di
// server/session-manager.js (bakPath/load/save). Nome distinto dai vecchi
// backup `memory.json.bak-pre-keyed-*`: non si sovrappongono.
const STORE_BAK = STORE + '.bak';
// Archivio delle voci uscite dalla memoria attiva (manutenzione automatica,
// 12/10/2026 — «make it so I don't have to worry about stuff like that», the owner).
// Append-only, una riga JSON per voce: {archived_at, reason, memory:{...}}.
// Non si riscrive e non si accorcia mai (legge 1): è la memoria che non si perde.
const ARCHIVE = path.join(MEMORY_DIR, 'memory-archive.jsonl');
const EXTRACT_EVERY = parseInt(process.env.MEMORY_EXTRACT_EVERY || '4', 10); // every Nth completed turn
const CONTEXT_TURNS = 6;     // recent messages handed to the extractor
const MAX_PREFACE = 12;      // memories injected at session start
const JACCARD_DUP = 0.6;     // legacy near-duplicate threshold
const JACCARD_MERGE = 0.7;   // keyed: a "new" key this similar to an existing one upserts the existing
const TOKEN_LIMIT = parseInt(process.env.MEMORY_TOKEN_LIMIT || '2000', 10); // budget for stored memory
const ALLOWED_CATS = ['identity', 'preference', 'fact', 'contact', 'project', 'goal'];

let _cache = null;             // in-memory mirror of the store (v2 shape)
const _turnCounts = new Map(); // sessionId -> completed-turn count (in-process throttle)

function _keyedOn() { return process.env.MEMORY_KEYED !== '0'; } // default ON

function _ensureDir() { try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch {} }

function _estTokens(s) { return Math.max(1, Math.ceil(String(s || '').length / 4)); }

// Tokens currently occupied by the store — the one accounting used by the budget
// (_makeRoom) and by the log lines.
function _storeTokens(store) {
  const list = (store && Array.isArray(store.memories)) ? store.memories : [];
  return list.reduce((t, m) => t + (m.tokenCount || _estTokens(m.value)), 0);
}

function _validKey(k) {
  return typeof k === 'string' && /^[a-z][a-z0-9_]{0,48}$/.test(k) && k !== 'nothing';
}

function _normCat(c) {
  const v = String(c || 'fact').toLowerCase().trim();
  return ALLOWED_CATS.includes(v) ? v : 'fact';
}

// Build a stable snake_case key from a value + category, unique within `taken`.
function _slugKey(value, category, taken) {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'his',
    'her', 'their', 'them', 'they', 'is', 'are', 'has', 'have', 'wants', 'prefers',
    'uses', 'on', 'in', 'at', 'as', 'over', 'via', 'not', 'now', 'all']);
  const words = String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w && w.length > 2 && !stop.has(w)).slice(0, 3);
  let base = (_normCat(category) + '_' + (words.join('_') || 'note')).slice(0, 44);
  if (!/^[a-z]/.test(base)) base = 'fact_' + base;
  let key = base, i = 2;
  while (taken.has(key)) { key = (base + '_' + i).slice(0, 48); i++; }
  return key;
}

// --- store load / migrate / save -------------------------------------------

function _migrateV1(arr) {
  // arr: legacy [{id,text,category,ts,sessionId}]. Lossless 1:1 → keyed records.
  const taken = new Set();
  const memories = [];
  for (const m of arr) {
    const value = String((m && m.text) || '').trim();
    if (!value) continue;
    const category = _normCat(m && m.category);
    const key = _slugKey(value, category, taken);
    taken.add(key);
    memories.push({
      key, value, category,
      tokenCount: _estTokens(value),
      updated_at: (m && m.ts) || Date.now(),
      sessionId: (m && m.sessionId) || null,
    });
  }
  return { version: 2, memories };
}

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

function _load() {
  if (_cache) return _cache;
  let raw = null;
  if (fs.existsSync(STORE)) {
    try { raw = JSON.parse(fs.readFileSync(STORE, 'utf-8')); }
    catch (mainErr) {
      // Lo store e' corrotto. NON si ritorna vuoto in silenzio: si prova la
      // copia rotante, come fa session-manager.js:1480-1497.
      console.error(`[MEMORY] !!! memory.json parse FAILED (${mainErr.message}) — attempting .bak recovery`);
      try {
        if (!fs.existsSync(STORE_BAK)) throw new Error('no .bak present');
        raw = JSON.parse(fs.readFileSync(STORE_BAK, 'utf-8'));
        console.error('[MEMORY] !!! Recovered memories from memory.json.bak — memories preserved');
      } catch (bakErr) {
        console.error(`[MEMORY] !!! .bak recovery also FAILED (${bakErr.message}) — starting empty`);
        raw = null;
      }
    }
  }
  if (Array.isArray(raw)) {
    _cache = _migrateV1(raw); // v1 → v2 (in memory; persisted on next save)
  } else if (raw && raw.version === 2 && Array.isArray(raw.memories)) {
    _cache = raw;
  } else {
    _cache = { version: 2, memories: [] };
  }
  return _cache;
}

function _saveAtomic(store) {
  _ensureDir();
  try {
    const data = JSON.stringify(store, null, 2);
    _atomicWriteSync(STORE, data);
    _cache = store;
    // Scrittura principale riuscita: rispecchia sulla copia rotante (ultimo
    // buono noto), stessa sequenza di session-manager.js:1466-1478.
    try { _atomicWriteSync(STORE_BAK, data); }
    catch (bErr) { console.error('[MEMORY] backup save failed:', bErr.message); }
  } catch (e) { console.error('[MEMORY] save failed:', e.message); }
}

// --- manutenzione automatica: archivio + fare spazio ------------------------
// Fino al 12/10/2026 a budget pieno la memoria smetteva di imparare: le chiavi
// nuove venivano scartate («budget full — skipped new key») e poi l'estrazione
// stessa veniva saltata («extraction SKIPPED»). memory.json è rimasto fermo dal
// 16/08 a 1994/2000t. Ora la memoria fa spazio da sola: le voci MENO utili
// escono dalla memoria attiva e finiscono in coda all'archivio, intatte.

// Appende le voci uscite all'archivio. Scritto PRIMA di riscrivere memory.json:
// se questo fallisce, chi chiama non salva (una voce non può sparire dalla
// memoria senza essere arrivata nell'archivio). Lancia in caso d'errore.
function _appendArchive(records, reason) {
  if (!records || !records.length) return;
  _ensureDir();
  const at = Date.now();
  const lines = records.map(m => JSON.stringify({
    archived_at: at, archived_iso: new Date(at).toISOString(), reason, memory: m,
  })).join('\n') + '\n';
  fs.appendFileSync(ARCHIVE, lines);
}

// Toglie dalla memoria attiva le voci meno utili finché il totale sta nel budget.
// «Meno utile» = la più vecchia per updated_at (il solo segnale che il record ha:
// non esistono campi d'uso o d'importanza; l'estrattore la ritocca quando il
// fatto torna, quindi una voce vecchia è una voce che nessuno ha più nominato).
// Pareggio sulla chiave, per un ordine stabile. Le chiavi in `keep` (toccate in
// questo stesso giro) non escono mai. Le voci tolte vengono messe in `archived`.
function _makeRoom(store, keep, archived) {
  let total = _storeTokens(store);
  if (total <= TOKEN_LIMIT) return 0;
  const victims = store.memories
    .filter(m => !keep.has(m.key))
    .sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0) || String(a.key).localeCompare(String(b.key)));
  const out = new Set();
  for (const m of victims) {
    if (total <= TOKEN_LIMIT) break;
    out.add(m);
    total -= (m.tokenCount || _estTokens(m.value));
  }
  if (!out.size) return 0;
  store.memories = store.memories.filter(m => !out.has(m));
  for (const m of out) archived.push(m);
  return out.size;
}

// --- similarity helpers (legacy dedup + keyed merge guard) ------------------

function _toks(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function _jaccard(a, b) {
  const A = new Set(_toks(a)), B = new Set(_toks(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// --- the cheap extractor call -----------------------------------------------

function _callHaiku(prompt, timeoutMs = 30000) {
  return new Promise((resolve) => {
    try {
      // ISOLATED one-shot (audit 2026-08-20): no MCP, no user settings/skills,
      // no tool schemas, no transcript on disk. Preamble 28.016 -> 173 tokens.
      // See server/oneshot-args.js.
      execFile(CLAUDE_BIN, oneShotArgs(prompt, {
        system: 'You maintain a keyed long-term memory store and reply with a single JSON object. Output nothing else.',
      }), {
        timeout: timeoutMs, cwd: os.tmpdir(), encoding: 'utf-8',
      }, (err, stdout) => {
        if (err) { console.log('[MEMORY] haiku call failed:', err.message); resolve(null); return; }
        resolve((stdout || '').trim());
      });
    } catch (e) { console.log('[MEMORY] haiku spawn failed:', e.message); resolve(null); }
  });
}

// ---- KEYED path -------------------------------------------------------------

function _renderWithKeys(memories) {
  if (!memories.length) return '(none yet)';
  return memories.map(m => `- ["${m.key}"] (${m.category}) ${m.value}`).join('\n');
}

function _extractPromptKeyed(convo, memories) {
  return `You maintain an assistant's long-term memory of durable facts about the USER.
You are given the CURRENT memory (each item has a stable key) and a recent conversation.
Decide what to change. Be conservative — most turns change nothing.

Rules:
- Only durable facts the USER stated about themselves: identity, preferences, projects, goals, context — worth remembering weeks from now.
- IGNORE one-off task details, questions, transient state, and anything about the assistant.
- NEVER store PROJECT STATE: deployment status, what is live/broken/shipped, backlog or task items, or system internals. Those belong in the project files, not here. Capture ONLY durable facts about the PERSON.
- To ADD or CORRECT a fact, emit a "set" with a stable snake_case key. REUSE an existing key when the new fact updates/replaces it (this overwrites — that is how we avoid duplicates). Invent a new key only for a genuinely new fact.
- To remove something no longer true, emit its key in "delete".
- Each value is ONE complete present-tense sentence, under 18 words.
- Allowed categories: ${ALLOWED_CATS.join(', ')}.
- Change at most 3 keys. If nothing is worth changing, return exactly: {"set":[],"delete":[]}

CURRENT MEMORY:
${_renderWithKeys(memories)}

RECENT CONVERSATION:
"""
${convo}
"""

Return ONLY JSON of the form {"set":[{"key":"...","value":"...","category":"..."}],"delete":["..."]}:`;
}

function _parseOps(raw) {
  if (!raw) return { set: [], delete: [] };
  let s = String(raw).trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return { set: [], delete: [] };
  s = s.slice(i, j + 1);
  let obj;
  try { obj = JSON.parse(s); } catch { return { set: [], delete: [] }; }
  if (!obj || typeof obj !== 'object') return { set: [], delete: [] };
  const set = Array.isArray(obj.set) ? obj.set
    .filter(o => o && typeof o.value === 'string' && o.value.trim())
    .map(o => ({
      key: _validKey(o.key) ? o.key : null,
      value: o.value.trim().replace(/\s+/g, ' ').slice(0, 160),
      category: _normCat(o.category),
    }))
    .slice(0, 3) : [];
  const del = Array.isArray(obj.delete) ? obj.delete.filter(_validKey).slice(0, 3) : [];
  return { set, delete: del };
}

// `archived` (facoltativo): riceve le voci uscite per fare spazio. Chi chiama le
// scrive nell'archivio PRIMA di salvare (vedi _persist).
function _applyOps(store, ops, sessionId, archived = []) {
  const mems = store.memories;
  const byKey = new Map(mems.map(m => [m.key, m]));
  const taken = new Set(byKey.keys());
  let changed = 0;

  // deletes first
  for (const k of ops.delete) {
    if (byKey.has(k)) {
      store.memories = store.memories.filter(m => m.key !== k);
      byKey.delete(k); taken.delete(k); changed++;
    }
  }

  const touched = new Set(); // chiavi scritte in questo giro: non escono per fare spazio

  for (const op of ops.set) {
    const tok = _estTokens(op.value);
    let key = op.key;

    // Merge guard: a brand-new key whose value duplicates an EXISTING different key
    // → upsert the existing key instead of creating a near-dup.
    if (!key || !byKey.has(key)) {
      let best = null, bestScore = 0;
      for (const m of store.memories) {
        const sc = _jaccard(op.value, m.value);
        if (sc > bestScore) { bestScore = sc; best = m; }
      }
      if (best && bestScore >= JACCARD_MERGE) key = best.key;
    }
    if (!key) key = _slugKey(op.value, op.category, taken);

    const existing = byKey.get(key);
    if (existing) {
      if (existing.value !== op.value || existing.category !== op.category) {
        existing.value = op.value;
        existing.category = op.category;
        existing.tokenCount = tok;
        existing.updated_at = Date.now();
        existing.sessionId = sessionId;
        touched.add(key);
        changed++;
      }
    } else {
      // Una chiave nuova entra sempre (un valore è al massimo 160 caratteri =
      // 40t, il budget è 2000): se non c'è posto, _makeRoom qui sotto lo fa.
      const rec = { key, value: op.value, category: op.category, tokenCount: tok, updated_at: Date.now(), sessionId };
      store.memories.push(rec);
      byKey.set(key, rec); taken.add(key); touched.add(key); changed++;
    }
  }

  // Budget: le voci di questo giro restano; escono le più vecchie finché sta tutto.
  const out = _makeRoom(store, touched, archived);
  return changed + out;
}

// Archivio prima, memory.json dopo. Se l'archivio non si scrive, memory.json
// NON si tocca e la copia in RAM si butta (verrà riletta dal disco): una voce
// non sparisce mai senza essere arrivata nell'archivio. Ritorna true se salvato.
function _persist(store, archived) {
  if (archived && archived.length) {
    try { _appendArchive(archived, 'budget'); }
    catch (e) {
      console.error(`[MEMORY] archive write FAILED (${e.message}) — memory.json NOT rewritten`);
      _cache = null;
      return false;
    }
    const keys = archived.map(m => m.key);
    const shown = keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', …' : '');
    console.log(`[MEMORY] made room: archived ${keys.length} key(s) (${shown}) → ${path.basename(ARCHIVE)} (now ${_storeTokens(store)}/${TOKEN_LIMIT}t)`);
  }
  _saveAtomic(store);
  return true;
}

// ---- LEGACY path (kill-switch MEMORY_KEYED=0) ------------------------------

function _extractPrompt(convo) {
  return `You extract durable, long-term facts about the USER from a conversation, for an assistant's memory.

Rules:
- Only facts the USER stated about themselves: their identity, preferences, projects, goals, or context — things still worth remembering weeks from now.
- IGNORE one-off task details, questions, transient state, and anything about the assistant.
- NEVER store PROJECT STATE: deployment status, what is live/broken/shipped, backlog or task items, or system internals. Those belong in the project files, not here. Capture ONLY durable facts about the PERSON.
- At most 2 facts. Each under 15 words, present tense, self-contained.
- If nothing is worth remembering, return exactly: []

Allowed categories: ${ALLOWED_CATS.join(', ')}.

Return ONLY a JSON array, e.g.:
[{"text":"Prefers replies under 3 lines, no jargon","category":"preference"}]

Conversation:
"""
${convo}
"""

JSON array only:`;
}

// kept for back-compat + unit tests; parses the legacy [{text,category}] shape
function _parseFacts(raw) {
  if (!raw) return [];
  let s = String(raw).trim();
  const i = s.indexOf('['), j = s.lastIndexOf(']');
  if (i === -1 || j === -1 || j < i) return [];
  s = s.slice(i, j + 1);
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(o => o && typeof o.text === 'string' && o.text.trim())
      .map(o => ({ text: o.text.trim().slice(0, 140), category: _normCat(o.category) }))
      .slice(0, 2);
  } catch { return []; }
}

function _applyLegacy(store, facts, sessionId) {
  const taken = new Set(store.memories.map(m => m.key));
  let added = 0;
  for (const f of facts) {
    const t = String(f.text || '').trim();
    if (!t) continue;
    // dup against existing values
    let dup = false;
    for (const m of store.memories) {
      const e = m.value.trim().toLowerCase();
      if (e === t.toLowerCase() || _jaccard(t, m.value) >= JACCARD_DUP) { dup = true; break; }
    }
    if (dup) continue;
    const key = _slugKey(t, f.category, taken);
    taken.add(key);
    store.memories.push({ key, value: t, category: f.category, tokenCount: _estTokens(t), updated_at: Date.now(), sessionId });
    added++;
  }
  return added;
}

// --- public API --------------------------------------------------------------

/**
 * Fire-and-forget from the auto-memory plugin's onResponseComplete hook.
 * Returns fast on non-extract turns; never throws.
 */
async function maybeExtract(sessionId, history) {
  try {
    if (!process.env.MEMORY_AUTO) return;
    const n = (_turnCounts.get(sessionId) || 0) + 1;
    _turnCounts.set(sessionId, n);
    if (n % EXTRACT_EVERY !== 0) return;
    if (!Array.isArray(history) || !history.length) return;

    const recent = history.slice(-CONTEXT_TURNS)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 600)}`)
      .join('\n');
    if (!recent.trim()) return;

    const store = _load();

    // Nessun controllo preventivo sul budget (tolto il 12/10/2026): a memoria
    // piena l'estrazione gira lo stesso e _applyOps fa spazio archiviando le
    // voci più vecchie (_makeRoom). Prima qui si saltava la chiamata e la
    // memoria restava ferma per sempre.
    if (_keyedOn()) {
      const raw = await _callHaiku(_extractPromptKeyed(recent, store.memories));
      const ops = _parseOps(raw);
      if (!ops.set.length && !ops.delete.length) return;
      const archived = [];
      const changed = _applyOps(store, ops, sessionId, archived);
      if (changed && _persist(store, archived)) {
        console.log(`[MEMORY] keyed ${changed} change(s) from session ${String(sessionId).slice(0, 8)} (total ${store.memories.length}, ${_storeTokens(store)}t)`);
      }
    } else {
      const raw = await _callHaiku(_extractPrompt(recent));
      const facts = _parseFacts(raw);
      if (!facts.length) return;
      const added = _applyLegacy(store, facts, sessionId);
      if (added) {
        _saveAtomic(store);
        console.log(`[MEMORY] legacy +${added} from session ${String(sessionId).slice(0, 8)} (total ${store.memories.length})`);
      }
    }
  } catch (e) {
    console.error('[MEMORY] extract error:', e.message);
  }
}

/**
 * Returns a system-prompt addition with recent memories, or '' when off/empty.
 * Shape-agnostic: works whether the store was just migrated or already v2.
 */
function getMemoryPreface() {
  try {
    if (!process.env.MEMORY_AUTO) return '';
    const store = _load();
    const mems = store.memories;
    if (!mems.length) return '';
    // Tiebreak on key so two memories sharing an updated_at can't swap order
    // between calls — a stable order keeps the cached --append-system-prompt
    // byte-identical when nothing actually changed (openclaw harvest steal).
    const recent = mems.slice()
      .sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0) || String(a.key).localeCompare(String(b.key)))
      .slice(-MAX_PREFACE);
    const lines = recent.map(m => `- ${m.value}`).join('\n');
    return `\n\nWhat you already know about the user (learned from past chats — treat as background context; always defer to what they say right now):\n${lines}`;
  } catch { return ''; }
}

function clearSession(sessionId) { _turnCounts.delete(sessionId); }

module.exports = {
  maybeExtract, getMemoryPreface, clearSession, STORE, ARCHIVE,
  // exposed for tests / introspection:
  _parseFacts, _parseOps, _applyOps, _migrateV1, _slugKey, _load, _saveAtomic, _estTokens,
  _storeTokens, _extractPromptKeyed, _makeRoom, _appendArchive, _persist, TOKEN_LIMIT,
};
