'use strict';
// Le squadre (gli agenti) le sceglie chi usa l'app, con UN file di impostazioni:
// ~/.151machine/squadre.json (percorso sovrascrivibile con env MACHINE_SQUADRE).
// Nel codice non c'è nessuna squadra: chi installa da zero vede solo
// «New Session». Esempio: docs/squadre.example.json.
//
// Forma (tutto opzionale):
//   { "teams":  { "<key>": { "title", "command": "/x"|null, "color": "<key>"|null, "icon": "<IC>" } },
//     "super":  { "<key>": { "on", "color": "#rrggbb", "icon", "name", "pos", "special" } },
//     "spawnModels": { "<key>": "opus" },
//     "dictationWords": "parole, separate, da virgola",
//     "titleAreas": "testo libero" }
//
// File assente o rotto = {} (fail-open, mai un crash). Letto una volta e tenuto
// in memoria; si rilegge solo se cambia il percorso o la data di modifica.
// Prova: tests/squadre.test.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_RE = /^[a-z0-9-]{1,32}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function percorso() {
  return process.env.MACHINE_SQUADRE || path.join(os.homedir(), '.151machine', 'squadre.json');
}

function testo(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

// Solo ciò che ha la forma giusta passa; il resto si scarta in silenzio.
function normalizza(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
  const out = {};
  const teams = {};
  for (const [k, t] of Object.entries(d.teams && typeof d.teams === 'object' ? d.teams : {})) {
    if (!KEY_RE.test(k) || !t || typeof t !== 'object') continue;
    teams[k] = {
      title: testo(t.title, 40) || k,
      command: typeof t.command === 'string' && /^\/[A-Za-z0-9_-]{1,40}$/.test(t.command) ? t.command : null,
      color: typeof t.color === 'string' && KEY_RE.test(t.color) ? t.color : null,
      icon: testo(t.icon, 40),
    };
  }
  if (Object.keys(teams).length) out.teams = teams;
  const sup = {};
  for (const [k, s] of Object.entries(d.super && typeof d.super === 'object' ? d.super : {})) {
    if (!KEY_RE.test(k) || !s || typeof s !== 'object') continue;
    sup[k] = {
      on: s.on !== false,
      color: typeof s.color === 'string' && COLOR_RE.test(s.color) ? s.color : null,
      icon: testo(s.icon, 40),
      name: testo(s.name, 40) || (k.charAt(0).toUpperCase() + k.slice(1)),
      pos: typeof s.pos === 'number' && isFinite(s.pos) ? s.pos : Object.keys(sup).length,
      special: s.special === true,
    };
  }
  if (Object.keys(sup).length) out.super = sup;
  const modelli = {};
  for (const [k, m] of Object.entries(d.spawnModels && typeof d.spawnModels === 'object' ? d.spawnModels : {})) {
    if (KEY_RE.test(k) && typeof m === 'string' && /^[A-Za-z0-9._\[\]-]{1,80}$/.test(m)) modelli[k] = m;
  }
  if (Object.keys(modelli).length) out.spawnModels = modelli;
  const parole = testo(d.dictationWords, 2000);
  if (parole) out.dictationWords = parole;
  const aree = testo(d.titleAreas, 4000);
  if (aree) out.titleAreas = aree;
  return out;
}

let cache = { p: null, mtime: null, dati: {} };

function leggi() {
  const p = percorso();
  let mtime;
  try { mtime = fs.statSync(p).mtimeMs; } catch (_) { cache = { p, mtime: null, dati: {} }; return {}; }
  if (cache.p === p && cache.mtime === mtime) return cache.dati;
  let dati = {};
  try { dati = normalizza(JSON.parse(fs.readFileSync(p, 'utf8'))); }
  catch (e) { console.warn('[SQUADRE] file non leggibile, nessuna squadra:', e.message); dati = {}; }
  cache = { p, mtime, dati };
  return dati;
}

// I super agenti numerati: chiave → tipo (il nome che si stampa sulla scheda,
// «WRITER 3»). Vuoto senza file.
function tipiFleet() {
  const s = leggi().super || {};
  const out = Object.create(null); // «constructor» o «__proto__» non sono tipi
  for (const k of Object.keys(s)) out[k] = s[k].name;
  return out;
}

module.exports = { leggi, tipiFleet, percorso, normalizza };
