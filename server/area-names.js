'use strict';
// [03/11/2026] I nomi delle sessioni: «Sessions should get the name of
// their team and if the team has subprojects take the name of the subproject,
// that is it.» (Prima, dal 17/10: il nome era l'«area» scelta da un elenco
// unico, e sbagliava fra aree vicine — «Personal Cloud» per un'APK di giochi,
// «151 TV» per la musica — o finiva in «Other» per /upgrade.)
// Niente scritto qui a mano: si legge ogni volta dalle fonti che esistono già.
//   - ~/.151machine/fleet/colori.json (opzionale, fail-open): le squadre e il
//     loro nome (`prefisso`, scelto): { "squadre": { "writer": { "prefisso": "Writer" } } }.
//   - projects/index.md: i progetti della sola sezione «## Attivi», ognuno con
//     «Team: /<squadra>». Congelati, Completati e Archiviati non danno nomi
//     d'area: nessun controllo li vede. Una squadra con DUE o più
//     progetti ha sottoprogetti; con uno solo, il nome è quello della squadra.
//     I satelliti («Shop — invoices») stanno sotto il loro progetto.
//   - «Other» (index.md) è il nome di chi non ha una squadra.
// Prova: tests/nomi-area.test.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Optional: a folder with an index.md listing projects («- [Name](file.md) -- … Team: /team»).
// Unset = no project names, sessions are named by team only (or «Other»).
const PROJECTS_DIR = process.env.MACHINE_PROJECTS_DIR || '';
const COLORI = path.join(os.homedir(), '.151machine', 'fleet', 'colori.json');
const SEZIONI_VIVE = /^##\s+Attivi\b/i;
const OTHER = 'Other';
// Progetti che NON hanno un nome loro (decisioni di progetto, una riga ciascuna).
// Forma: { '<progetto>': '<progetto che lo contiene>' }. Vuoto di base.
const DENTRO = {};
// Schede che SONO la squadra, non un suo sottoprogetto: lavoro lì = nome della squadra.
// Other = la casella di chi non ha una squadra.
const CASA_DELLA_SQUADRA = new Set([OTHER]);

function semplice(nome) {
  return String(nome || '').replace(/^The\s+/i, '').replace(/\s+/g, ' ').trim();
}

// [Nome](file.md) -- descrizione … Team: /squadra  →  { name, file, hint, team }
function daIndice(testo) {
  const out = [];
  let viva = false;
  for (const riga of String(testo || '').split('\n')) {
    if (/^##\s/.test(riga)) { viva = SEZIONI_VIVE.test(riga); continue; }
    if (!viva) continue;
    const m = riga.match(/^-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:--\s*(.*))?$/);
    if (!m) continue;
    const t = (m[3] || '').match(/Team:\s*\**\/([a-z0-9-]+)/i);
    const hint = (m[3] || '').replace(/Team:.*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    out.push({ name: semplice(m[1]), file: m[2], hint, team: t ? t[1].toLowerCase() : null });
  }
  // Satellite = «<progetto> — qualcosa» dove <progetto> è già nella lista.
  const nomi = new Set(out.map((x) => x.name.toLowerCase()));
  return out.filter((x) => {
    const i = x.name.indexOf(' — ');
    return !(i > 0 && nomi.has(x.name.slice(0, i).toLowerCase()));
  });
}

function leggi(p, cosa) {
  if (!p || p === 'index.md') return '';
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { console.warn(`[AREA-NAMES] ${cosa} non leggibile:`, e.message); return ''; }
}

// Le squadre, lette ora: [{ id, name, subprojects: [{ name, hint }] }].
function loadTeams(dir = PROJECTS_DIR, coloriPath = COLORI) {
  let squadre = {};
  try { squadre = JSON.parse(leggi(coloriPath, 'colori.json') || '{}').squadre || {}; } catch { squadre = {}; }
  const progetti = dir ? daIndice(leggi(path.join(dir, 'index.md'), 'index.md')) : [];

  const teams = new Map();
  const squadra = (id) => {
    if (!teams.has(id)) {
      const nome = (squadre[id] && squadre[id].prefisso) || (id.charAt(0).toUpperCase() + id.slice(1));
      teams.set(id, { id, name: nome, subprojects: [] });
    }
    return teams.get(id);
  };
  for (const id of Object.keys(squadre)) squadra(id);

  const dentro = [];
  for (const p of progetti) {
    if (!p.team) continue;
    if (DENTRO[p.name]) { dentro.push(p); continue; }
    const t = squadra(p.team);
    if (CASA_DELLA_SQUADRA.has(p.name)) continue;
    t.subprojects.push({ name: p.name, hint: p.hint });
  }
  for (const p of dentro) {
    const casa = [...teams.values()].flatMap((t) => t.subprojects).find((x) => x.name === DENTRO[p.name]);
    if (casa) casa.hint = (casa.hint ? casa.hint + '; ' : '') + 'also ' + p.name + ': ' + p.hint.slice(0, 80);
  }
  for (const t of teams.values()) {
    const visti = new Set();
    t.subprojects = t.subprojects.filter((s) => s.name && !visti.has(s.name.toLowerCase()) && visti.add(s.name.toLowerCase()));
    // Un progetto solo non è un sottoprogetto: il nome resta quello della squadra,
    // ma la sua descrizione dice di cosa si occupa.
    if (t.subprojects.length === 1) t.hint = t.subprojects[0].name + ': ' + t.subprojects[0].hint;
    if (t.subprojects.length < 2) t.subprojects = [];
  }
  return [...teams.values()];
}

// «/apps …», «read X /writer», «AGENT: /review …» → la squadra. Il primo comando che
// è una squadra vera; un percorso (/home/…) non lo è.
function teamDaComando(testo, teams) {
  const ids = new Set((teams || []).map((t) => t.id));
  // Una squadra fra virgolette («the "/apps" sections») è citata, non è il comando.
  const re = /(^|[\s(*])\/([a-z0-9-]+)(?=$|[\s.,:;!?)*—–-])/gi;
  let m;
  while ((m = re.exec(String(testo || '')))) {
    const id = m[2].toLowerCase();
    if (ids.has(id)) return (teams || []).find((t) => t.id === id);
  }
  return null;
}

// La risposta del modello → uno dei nomi permessi, scritto come nella lista, o null.
function matchName(raw, nomi) {
  const pulisci = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[`"'«»*.]/g, '').replace(/\s+/g, ' ').trim();
  const r = pulisci(String(raw || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean));
  if (!r) return null;
  const n = (nomi || []).find((x) => pulisci(x) === r);
  if (n) return n;
  const alias = Object.keys(DENTRO).find((k) => pulisci(k) === r);
  return alias && (nomi || []).includes(DENTRO[alias]) ? DENTRO[alias] : null;
}

// Tutti i nomi che una sessione può avere (squadre e sottoprogetti), per il caso
// senza comando: il modello sceglie fra questi.
function tuttiINomi(teams) {
  const out = [];
  for (const t of teams || []) { out.push(t.name); for (const s of t.subprojects) out.push(s.name); }
  return [...new Set(out)];
}

module.exports = { loadTeams, teamDaComando, matchName, tuttiINomi, daIndice, OTHER, DENTRO, PROJECTS_DIR };
