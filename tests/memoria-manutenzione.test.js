#!/usr/bin/env node
'use strict';

// =============================================================================
// Memoria automatica: manutenzione da sola (12/10/2026).
//
// Il guasto misurato: ~/.151machine/memory/memory.json fermo dal 16/08 a
// 1994/2000t; il motore saltava l'estrazione a budget pieno («extraction
// SKIPPED», 28 volte dal 03/10) e scartava ogni chiave nuova. La memoria non
// imparava più niente. Ora fa spazio da sola: le voci più vecchie escono dalla
// memoria attiva e finiscono, intatte, in memory-archive.jsonl.
//
// Prova PURA: nessun server, nessuna rete, nessun modello. Il `claude` chiamato
// dal motore è un finto script messo in testa al PATH che restituisce le
// operazioni scritte dalla prova. Tutto vive in una cartella usa-e-getta in /tmp
// (MEMORY_DIR): la memoria vera del proprietario non viene mai letta né scritta — la
// prova si rifiuta di partire se lo STORE del motore non è dentro quella cartella.
//
// Per mostrarla ROSSA sul codice di prima:
//   MEMORY_ENGINE_UNDER_TEST=/percorso/memory-engine.js node tests/memoria-manutenzione.test.js
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = process.env.MEMORY_ENGINE_UNDER_TEST || path.join(ROOT, 'server', 'memory-engine.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-manutenzione-'));
const MEMDIR = path.join(TMP, 'memory');
const BIN = path.join(TMP, 'bin');
const OPS = path.join(TMP, 'ops.json');
fs.mkdirSync(MEMDIR, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });

// Finto `claude`: stampa le operazioni che la prova ha preparato.
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\ncat "${OPS}"\n`, { mode: 0o755 });

// Ambiente del motore: TUTTO prima del require (le costanti si leggono al caricamento).
process.env.MEMORY_DIR = MEMDIR;
process.env.MEMORY_AUTO = '1';
process.env.MEMORY_EXTRACT_EVERY = '1';
process.env.MEMORY_TOKEN_LIMIT = '2000';
delete process.env.MEMORY_KEYED;
delete process.env.MEMORY_MIN_HEADROOM;
process.env.PATH = BIN + path.delimiter + process.env.PATH;

const STORE = path.join(MEMDIR, 'memory.json');
const ARCHIVE = path.join(MEMDIR, 'memory-archive.jsonl');

let fail = 0, pass = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- memoria finta piena: 79 voci da 25t + 1 da 19t = 1994/2000t (come quella vera)
const WORDS = ['amber', 'birch', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper'];
function filler(i) {
  // 100 caratteri esatti = 25 token; parole diverse dalla voce nuova (niente fusione Jaccard)
  const v = `Filler record ${String(i).padStart(2, '0')} ${WORDS[i % 10]} ${WORDS[(i * 3) % 10]} ${WORDS[(i * 7) % 10]} placeholder`;
  return v.padEnd(100, '.').slice(0, 100);
}
const BASE_TS = 1780400000000;
const memories = [];
for (let i = 0; i < 80; i++) {
  const value = i === 79 ? filler(i).slice(0, 76) : filler(i); // 76 car. = 19t
  memories.push({
    key: `filler_${String(i).padStart(2, '0')}`,
    value, category: 'fact',
    tokenCount: Math.ceil(value.length / 4),
    // in ordine sparso, così "il più vecchio" non coincide con "il primo della lista"
    updated_at: BASE_TS + ((i * 37) % 80) * 1000,
    sessionId: 'orig',
  });
}
const startTokens = memories.reduce((t, m) => t + m.tokenCount, 0);
fs.writeFileSync(STORE, JSON.stringify({ version: 2, memories }, null, 2));
const oldest = memories.slice().sort((a, b) => a.updated_at - b.updated_at)[0];

function readStore() { return JSON.parse(fs.readFileSync(STORE, 'utf-8')); }
function readArchive() {
  if (!fs.existsSync(ARCHIVE) || !fs.statSync(ARCHIVE).isFile()) return [];
  return fs.readFileSync(ARCHIVE, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function tokens(store) { return store.memories.reduce((t, m) => t + (m.tokenCount || 0), 0); }
function setOps(ops) { fs.writeFileSync(OPS, JSON.stringify(ops)); }
const HISTORY = [{ role: 'user', content: 'I play bass guitar on Sundays.' }, { role: 'assistant', content: 'Nice.' }];

async function main() {
  console.log(`memoria-manutenzione — motore: ${ENGINE}`);
  console.log(`cartella finta: ${MEMDIR}  (memoria di partenza ${startTokens}/2000t, ${memories.length} voci)`);
  const eng = require(ENGINE);

  // Muro: la prova non tocca MAI la memoria vera.
  if (path.resolve(eng.STORE) !== path.resolve(STORE)) {
    console.log(`  FAIL il motore punta a ${eng.STORE}, non alla cartella finta — prova FERMATA`);
    process.exit(1);
  }

  // (1) voce nuova a memoria piena: entra, la più vecchia va nell'archivio intatta
  const NEW_VALUE = 'Anna plays bass guitar every Sunday evening with old friends.';
  setOps({ set: [{ key: 'hobby_bass_guitar', value: NEW_VALUE, category: 'preference' }], delete: [] });
  await eng.maybeExtract('sessione-uno', HISTORY);
  let st = readStore();
  let arc = readArchive();
  const nuovo = st.memories.find(m => m.key === 'hobby_bass_guitar');
  check('(1) la voce nuova è entrata nella memoria a budget pieno', !!nuovo && nuovo.value === NEW_VALUE,
    nuovo ? '' : `chiavi: ${st.memories.length}, nessuna hobby_bass_guitar`);
  check('(1) la voce più vecchia è uscita dalla memoria attiva', !st.memories.some(m => m.key === oldest.key),
    `la più vecchia è ${oldest.key}`);
  const rigaVecchia = arc.find(r => r.memory && r.memory.key === oldest.key);
  check('(1) la più vecchia è nell\'archivio con i suoi dati intatti',
    !!rigaVecchia && JSON.stringify(rigaVecchia.memory) === JSON.stringify(oldest),
    rigaVecchia ? JSON.stringify(rigaVecchia.memory) : `archivio: ${arc.length} righe`);
  check('(1) la riga d\'archivio porta data di uscita e motivo',
    !!rigaVecchia && typeof rigaVecchia.archived_at === 'number' && rigaVecchia.reason === 'budget');
  check('(1) archiviate solo le voci necessarie (la nuova vale 16t → esce 1 voce da 25t)', arc.length === 1,
    `righe: ${arc.length}`);
  const tutte = new Set([...st.memories.map(m => m.key), ...arc.map(r => r.memory.key)]);
  check('(1) nessuna voce persa: attiva + archivio = le 80 di prima + la nuova', tutte.size === 81, `${tutte.size}`);

  // (2) il totale resta sotto il budget
  check('(2) il totale sta nel budget', tokens(st) <= 2000, `${tokens(st)}/2000t`);

  // (3) aggiornare una chiave esistente non archivia niente
  const prima = arc.length;
  const target = st.memories.find(m => m.key === 'filler_40');
  const UPD = 'Updated record forty: Anna now prefers short updates, plain words, no jargon at all.'; // < 100 car.
  setOps({ set: [{ key: 'filler_40', value: UPD, category: 'preference' }], delete: [] });
  await eng.maybeExtract('sessione-due', HISTORY);
  st = readStore(); arc = readArchive();
  const agg = st.memories.find(m => m.key === 'filler_40');
  check('(3) la chiave esistente è aggiornata', !!target && !!agg && agg.value === UPD);
  check('(3) l\'aggiornamento non ha archiviato niente', arc.length === prima, `righe: ${prima} → ${arc.length}`);
  check('(3) totale ancora nel budget', tokens(st) <= 2000, `${tokens(st)}/2000t`);

  // (4) archivio prima di memory.json: se l'archivio non si scrive, memory.json non cambia
  const archivioSalvato = ARCHIVE + '.salvato';
  if (fs.existsSync(ARCHIVE)) fs.renameSync(ARCHIVE, archivioSalvato);
  fs.mkdirSync(ARCHIVE); // una cartella al posto del file: l'append fallisce
  const bytesPrima = fs.readFileSync(STORE, 'utf-8');
  setOps({ set: [{ key: 'pet_cat_named_miso', value: 'Anna has a grey cat called Miso who sleeps on the warm keyboard every single afternoon while he works.', category: 'fact' }], delete: [] });
  const errori = [];
  const origErr = console.error;
  console.error = (...a) => { errori.push(a.join(' ')); };
  try { await eng.maybeExtract('sessione-tre', HISTORY); } finally { console.error = origErr; }
  check('(4) archivio non scrivibile ⇒ memory.json NON riscritto (nessuna voce persa)',
    fs.readFileSync(STORE, 'utf-8') === bytesPrima);
  check('(4) e lo dice nel log', errori.some(l => /archive write FAILED/.test(l)), errori.join(' | ') || 'nessun errore');
  fs.rmdirSync(ARCHIVE);
  if (fs.existsSync(archivioSalvato)) fs.renameSync(archivioSalvato, ARCHIVE);

  // (4b) archivio di nuovo scrivibile: lo stesso giro ora passa, dal disco e non dalla RAM sporca
  await eng.maybeExtract('sessione-tre', HISTORY);
  st = readStore(); arc = readArchive();
  check('(4b) archivio tornato ⇒ la voce entra e si archivia di nuovo',
    st.memories.some(m => m.key === 'pet_cat_named_miso') && arc.length === prima + 1 && tokens(st) <= 2000,
    `righe ${arc.length}, ${tokens(st)}t`);
  const tutteOra = new Set([...st.memories.map(m => m.key), ...arc.map(r => r.memory.key)]);
  check('(4b) nessuna voce persa: 80 + 2 nuove', tutteOra.size === 82, `${tutteOra.size}`);

  const tmpOrfani = fs.readdirSync(MEMDIR).filter(f => f.endsWith('.tmp'));
  check('nessun file temporaneo orfano', tmpOrfani.length === 0, tmpOrfani.join(', '));

  console.log(`\nmemoria-manutenzione: ${pass} ok, ${fail} FAIL`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.log('  FAIL eccezione:', e && e.stack || e); process.exit(1); });
