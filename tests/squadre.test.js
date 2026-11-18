#!/usr/bin/env node
'use strict';
// Le squadre le sceglie chi usa l'app con UN file (server/squadre.js,
// docs/squadre.example.json). Nel codice nessuna squadra.
//   (a) senza file: solo New Session, nessuna scheda speciale, /api/squadre → {};
//   (b) col file d'esempio: le squadre compaiono, la scheda speciale c'è col suo nome;
//   (c) file rotto → come senza file.
// Pura: server/squadre.js in node, e il codice vero di public/js/sessions.js
// (lista Sessions) in una sandbox vm con un DOM finto minimo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squadre-'));
const FILE = path.join(tmp, 'squadre.json');
process.env.MACHINE_SQUADRE = FILE;
const squadre = require('../server/squadre');
const esempio = rd('docs/squadre.example.json');

// ---------- il server ----------
ok(JSON.stringify(squadre.leggi()) === '{}', '(a) senza file: leggi() → {}');
ok(Object.keys(squadre.tipiFleet()).length === 0, '(a) senza file: nessun tipo numerato');
ok(/app\.get\('\/api\/squadre', \(_req, res\) => \{\s*res\.json\(require\('\.\/squadre'\)\.leggi\(\)\);/.test(rd('server/index.js')),
  '(a) GET /api/squadre risponde leggi() (sotto /api, stessa autenticazione)');

fs.writeFileSync(FILE, esempio);
const d = squadre.leggi();
ok(d.teams && d.teams.notes && d.teams.notes.command === '/notes', '(b) col file: le squadre ci sono');
ok(d.super && d.super.lead && d.super.lead.special === true && d.super.lead.name === 'Lead', '(b) col file: la scheda speciale è quella dichiarata');
ok(squadre.tipiFleet().writer === 'Writer' && squadre.tipiFleet().constructor === undefined, '(b) tipi numerati = i «super» del file (e niente di ereditato)');
ok(d.dictationWords && d.titleAreas, '(b) parole del dettato e aree dei titoli arrivano');

// la rilettura a cambio di data
const t0 = Date.now() / 1000;
fs.writeFileSync(FILE, JSON.stringify({ super: { solo: { name: 'Solo' } } }));
fs.utimesSync(FILE, t0 + 5, t0 + 5);
ok(squadre.leggi().super && squadre.leggi().super.solo && !squadre.leggi().teams, 'il file cambiato si rilegge da solo');

fs.writeFileSync(FILE, '{ questo non è json');
fs.utimesSync(FILE, t0 + 10, t0 + 10);
const origWarn = console.warn; console.warn = () => {};
const rotto = squadre.leggi();
console.warn = origWarn;
ok(JSON.stringify(rotto) === '{}', '(c) file rotto → {} (mai un crash)');
fs.writeFileSync(FILE, JSON.stringify({ teams: { 'NO KEY!': {}, ok: 'stringa' }, super: [1, 2], spawnModels: { x: 'rm -rf /' } }));
fs.utimesSync(FILE, t0 + 15, t0 + 15);
ok(JSON.stringify(squadre.leggi()) === '{}', '(c) forme sbagliate si scartano');

// Il dettato (Python) legge lo stesso file, fail-open.
const py = rd('whisper-service/server.py');
ok(/os\.environ\.get\("MACHINE_SQUADRE"\)/.test(py) && /d\.get\("dictationWords"\)/.test(py) && /except Exception:\s*return ""/.test(py),
  'il dettato legge «dictationWords» dallo stesso file, fail-open');

// ---------- il client: la lista Sessions ----------
const src = rd('public/js/sessions.js');
function estrai(da, a) {
  const i = src.indexOf(da);
  if (i < 0) return '';
  const j = src.indexOf(a, i);
  return j < 0 ? '' : src.slice(i, j + a.length);
}
const pezzi = [
  estrai('function getTeamIcon', '// Model id → short human label'),
  estrai('function prettifyModelId', '\n}\n'),
  estrai('// ── LAVORI IN SOTTOFONDO (inizio)', '// ── LAVORI IN SOTTOFONDO (fine) ──'),
  estrai('function buildSessionItemHtml', '\n}\n'),
  estrai('window.renderSessionList = function renderSessionList()', '\n};\n'),
  (src.match(/\/\/ --- Team Launcher v2 ---[\s\S]*?function detectSuperSession\(k\) \{[\s\S]*?\n\}\n/) || [''])[0],
];
ok(pezzi.every(Boolean), 'sessions.js ha i pezzi da provare');

function sandbox() {
  const store = {};
  const lista = { innerHTML: '', querySelectorAll() { return []; } };
  const ctx = {
    console, Date, JSON, Math, String, Number, Array, Object, Set, parseInt, isFinite,
    setTimeout() { return 0; }, clearTimeout() {},
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    document: { documentElement: { style: { setProperty() {} } }, getElementById() { return null; } },
    escapeHtml(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; },
    sessionList: lista,
    persistAwaiting() {}, persistOpened() {}, renderRecentStrip() {},
    WebSocket: { OPEN: 1 },
  };
  ctx.window = ctx;
  ctx.sessions = [];
  ctx.awaitingSessions = new Set();
  ctx.openedSessions = new Set();
  vm.createContext(ctx);
  vm.runInContext(rd('public/js/core.js').match(/window\.IC = \(function\(\) \{[\s\S]*?\n\}\)\(\);/)[0], ctx);
  vm.runInContext('var IC = window.IC;\n' + pezzi.join('\n').replace('const TEAMS', 'var TEAMS') +
    '\nwindow.TEAMS = TEAMS; window.tipi = function () { return FLEET_TYPE_BY_KEY; };', ctx);
  return { ctx, lista, disegna() { ctx.renderSessionList(); return lista.innerHTML; } };
}

// (a) senza file
const a = sandbox();
a.ctx.applySquadre(squadre.normalizza(null));
let h = a.disegna();
ok(JSON.stringify(Object.keys(a.ctx.TEAMS)) === '["overseer","blank"]' && a.ctx.TEAMS.overseer.title === 'New Session' && a.ctx.TEAMS.overseer.command === null,
  '(a) senza file: nel codice solo New Session (e la sessione vuota)');
ok(!/fleet-group/.test(h) && !/special-placeholder/.test(h) && !/agent-placeholder/.test(h), '(a) senza file: nessuna scheda speciale, nessun super agente');
ok(/No other sessions/.test(h), '(a) la lista c\'è lo stesso («Other»)');
ok(a.ctx.superSpeciale() === null && Object.keys(a.ctx.tipi()).length === 0, '(a) nessun tipo numerato nel client');

// (b) col file d'esempio
const b = sandbox();
b.ctx.applySquadre(squadre.normalizza(JSON.parse(esempio)));
h = b.disegna();
ok(b.ctx.TEAMS.notes && b.ctx.TEAMS.notes.title === 'Notes' && b.ctx.TEAMS.notes.command === '/notes' && b.ctx.TEAMS.notes.icon === b.ctx.IC.fileText,
  '(b) la squadra del file c\'è, con titolo, comando e icona');
ok(/class="special-placeholder"/.test(h) && /<span class="dp-title">LEAD<\/span>/.test(h) && /Run \/lead/.test(h), '(b) la scheda speciale c\'è col suo nome («LEAD», Run /lead)');
ok(/data-agent="writer"/.test(h) && !/data-agent="reviewer"/.test(h), '(b) Writer in alto, Reviewer (spento) no');
ok(b.ctx.SPAWN_MODEL_DEFAULTS.writer === 'opus', '(b) i modelli di nascita vengono dal file');
b.ctx.sessions = [{ id: 'L1', title: 'LEAD 3', status: 'idle', agentType: 'Lead', agentNumber: 3, created: Date.now() }];
h = b.disegna();
ok(/class="session-item[^"]*\bspecial\b/.test(h) && /LEAD 3/.test(h) && !/special-placeholder/.test(h), '(b) la sessione viva del tipo speciale prende la scheda speciale');

// (c) file rotto = come senza file
const c = sandbox();
c.ctx.applySquadre(rotto);
h = c.disegna();
ok(JSON.stringify(Object.keys(c.ctx.TEAMS)) === '["overseer","blank"]' && !/fleet-group/.test(h), '(c) file rotto: solo New Session, nessuna scheda speciale');
c.ctx.applySquadre('spazzatura'); c.ctx.applySquadre([1, 2]); c.ctx.applySquadre({ super: 'x', teams: 3 });
ok(!/fleet-group/.test(c.disegna()), '(c) dati strani dal server: niente crash, niente schede');

// Nessun nome di squadra scritto nel codice del client.
ok(/const TEAMS = \{\s*'overseer':[^\n]*\n\s*'blank':[^\n]*\n\};/.test(src) && /window\.SUPER_DEFAULT = \{\};/.test(src), 'nel codice: TEAMS = New Session + vuota, SUPER_DEFAULT vuoto');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nsquadre: ${pass} verdi, ${fail} rossi`);
process.exit(fail ? 1 : 0);
