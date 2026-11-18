#!/usr/bin/env node
'use strict';

// =============================================================================
// LA PROVA CHE LA QUARANTENA SCADE DA SOLA
// (P5 del 12/09/2026.)
//
// IL GUASTO: «La quarantena ha una data, non una scadenza.» race-test.js era in
// quarantena dal 28/08 e il 12/09 era ancora rossa: una quarantena senza
// scadenza è una cancellazione con un nome più gentile. Ora la quarantena ha
// una scadenza e alla scadenza si richiude da sola, senza nessun umano nel ciclo.
//
// Questa prova non giudica SE un test sia rotto. Giudica la MECCANICA: che la
// scadenza esista, che sia rispettata, e che una voce senza data valida non
// valga «per sempre».
//
// Dal 12/10/2026 la quarantena vera è VUOTA (race-test.js è uscito: riscritto
// il 22/09 come prova pura, verde). La prova quindi NON pretende più nessuna
// voce viva: la meccanica la prova su una VOCE FINTA costruita qui dentro, in
// un runner gemello in /tmp (parte E). Le voci vere, se ce ne sono, devono
// solo rispettare lo schema (parti A e D).
//
// Uso:  node tests/quarantena.test.js      (puro — entra da solo in npm test)
// =============================================================================

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNALL = path.join(ROOT, 'tests', 'run-all.js');
const src = fs.readFileSync(RUNALL, 'utf8');

let ok = 0;
const rotti = [];
function prova(nome, cond, dettaglio) {
  if (cond) { ok++; console.log(`  ✓ ${nome}`); }
  else { rotti.push(nome + (dettaglio ? ` — ${dettaglio}` : '')); console.log(`  ✗ ${nome}${dettaglio ? ` — ${dettaglio}` : ''}`); }
}

console.log('── PROVA DELLA QUARANTENA A SCADENZA ──');

// ── A) lo SCHEMA: ogni voce porta motivo, dal, scadenza ──────────────────────
// Si legge il registro davvero, eseguendo --list e chiedendo al runner stesso
// cosa ha in pancia: una copia a mano della lista invecchierebbe subito.
console.log('\nA) lo schema di ogni voce');
const censimento = spawnSync(process.execPath, [RUNALL, '--list'], {
  cwd: ROOT, encoding: 'utf8', timeout: 30000,
});
prova('il censimento gira', censimento.status === 0, censimento.stderr);

// Le voci si estraggono dal sorgente (è l'unica fonte: la costante non è
// esportata, e esportarla vorrebbe dire cambiare il runner canonico).
const blocco = src.match(/const QUARANTINE = \{([\s\S]*?)\n\};/);
prova('la costante QUARANTINE si trova nel sorgente', Boolean(blocco));
// I commenti dentro la costante non sono voci: si tolgono prima di cercare.
const corpoQ = blocco ? blocco[1].replace(/^\s*\/\/.*$/gm, '') : '';
const voci = [...corpoQ.matchAll(/'([^']+\.(?:js|sh))':\s*\{/g)].map((m) => m[1]);
console.log(`    (voci vere in quarantena oggi: ${voci.length ? voci.join(', ') : 'nessuna'})`);
// Il censimento del runner e il sorgente devono dire la stessa cosa: ogni file
// che il runner chiama QUARANTENA o QUAR-SCADUTA è una voce trovata qui.
const delCensimento = [...(censimento.stdout || '').matchAll(/^\s+(?:QUARANTENA|QUAR-SCADUTA)\s+(\S+)/gm)].map((m) => m[1]);
prova('il censimento e il sorgente concordano sulle voci',
  delCensimento.every((f) => voci.includes(f)), `censimento: ${delCensimento.join(', ') || '—'}`);

for (const v of voci) {
  const corpo = corpoQ.split(`'${v}':`)[1].split(/\n  \}/)[0];
  prova(`«${v}» dichiara \`dal\``, /\bdal:\s*'/.test(corpo));
  prova(`«${v}» dichiara \`scadenza\` in forma AAAA-MM-GG`, /\bscadenza:\s*'\d{4}-\d{2}-\d{2}'/.test(corpo));
  prova(`«${v}» dichiara \`motivo\``, /\bmotivo:\s*\n?\s*'/.test(corpo));
}

// ── B) la MECCANICA della scadenza ───────────────────────────────────────────
// Si provano le due funzioni nello stesso modo in cui le usa il runner, senza
// toccare il runner: si rilegge il sorgente e si valutano le due funzioni pure.
console.log('\nB) la meccanica: scaduta ⇒ il riparo non vale più');
const fn = src.match(/function quarantenaScaduta\([\s\S]*?\n\}/);
prova('quarantenaScaduta() esiste', Boolean(fn));
let quarantenaScaduta = null;
if (fn) {
  // eslint-disable-next-line no-new-func
  quarantenaScaduta = new Function(`${fn[0]}; return quarantenaScaduta;`)();
}
if (quarantenaScaduta) {
  prova('una data nel passato è SCADUTA', quarantenaScaduta({ scadenza: '2020-01-01' }) === true);
  prova('una data nel futuro NON è scaduta', quarantenaScaduta({ scadenza: '2099-12-31' }) === false);
  prova('scadenza ASSENTE vale SCADUTA (un riparo senza data non è un riparo)',
    quarantenaScaduta({}) === true);
  prova('scadenza ILLEGGIBILE vale SCADUTA (non si tira a indovinare)',
    quarantenaScaduta({ scadenza: 'quando-capita' }) === true);
  prova('si scade alla FINE del giorno dichiarato, non all\'alba',
    // la data di OGGI in ora locale, come fa quarantenaScaduta() (Date.parse senza fuso = locale):
    // con toISOString() (UTC) fra mezzanotte e le 2 il «oggi» era ieri e il test andava rosso da solo.
    quarantenaScaduta({ scadenza: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) }) === false);
}

// ── C) il riparo è LEGATO alla scadenza, non alla sola presenza ──────────────
// È il punto che chiude il guasto: prima `Boolean(QUARANTINE[f])` bastava, e
// quindi una voce del 28/08 riparava ancora il 12/09 e avrebbe riparato nel 2030.
console.log('\nC) il riparo dipende dalla scadenza, non dall\'esistenza della voce');
prova('inQuarantena() esiste e pesa la scadenza',
  /function inQuarantena\(file\)[\s\S]*?!quarantenaScaduta\(v\)/.test(src));
prova('il runner NON ripara più con il solo `Boolean(QUARANTINE[f])`',
  !/const quarantined = Boolean\(QUARANTINE\[f\]\)/.test(src));
prova('il verdetto del giro usa inQuarantena()', /const quarantined = inQuarantena\(f\)/.test(src));
prova('una voce scaduta si vede nel censimento come QUAR-SCADUTA', /QUAR-SCADUTA/.test(src));
prova('a giro finito la scadenza viene STAMPATA con i giorni che restano',
  /ancora \$\{gg\} giorn/.test(src) && /SCADUTA: il riparo non vale più/.test(src));

// ── D) le voci vive (se ce ne sono) hanno una scadenza vera ──────────────────
// Nessuna voce è pretesa: una quarantena vuota è lo stato sano. Ma ogni voce
// che c'è non può nascondersi dietro una scadenza lontanissima.
console.log('\nD) le voci vive');
if (!voci.length) console.log('    (nessuna voce viva: niente da controllare qui)');
if (quarantenaScaduta) {
  for (const v of voci) {
    const corpo = corpoQ.split(`'${v}':`)[1].split(/\n  \}/)[0];
    const m = corpo.match(/scadenza:\s*'(\d{4}-\d{2}-\d{2})'/);
    prova(`«${v}»: la scadenza è leggibile`, Boolean(m));
    if (m) {
      const scaduta = quarantenaScaduta({ scadenza: m[1] });
      console.log(`    (${v}: scadenza ${m[1]} — ${scaduta ? 'GIÀ SCADUTA: ora blocca' : 'ancora in corso'})`);
      prova(`«${v}»: non è una scadenza finta lontana (entro un anno da oggi)`,
        Date.parse(m[1]) - Date.now() <= 366 * 86400000, `scadenza: ${m[1]}`);
    }
  }
}

// ── E) LA RICHIUSURA AUTOMATICA, PROVATA DAVVERO ─────────────────────────────
// Le parti B e C provano la funzione e il cablaggio leggendo il sorgente. Non
// basta: «richiusura automatica» è un COMPORTAMENTO, e un comportamento si
// prova facendolo. Qui si costruisce in /tmp un runner gemello — copia byte per
// byte di tests/run-all.js, con un solo test dentro, rosso per costruzione — e
// si guarda cosa fa lo STESSO codice con la scadenza nel futuro e con la
// scadenza nel passato. Costa millisecondi: nessun server, nessun login, un
// solo `process.exit(1)`.
console.log('\nE) la richiusura automatica, provata per davvero');
const sandbox = fs.mkdtempSync(path.join(require('os').tmpdir(), 'prova-quarantena-'));
try {
  const dirTest = path.join(sandbox, 'tests');
  fs.mkdirSync(dirTest);
  // Un test rosso per costruzione, col nome della VOCE FINTA. La quarantena
  // vera del gemello viene sostituita per intero da quella sola voce: la prova
  // non dipende da cosa c'è (o non c'è) oggi nella quarantena vera.
  const FINTO = 'finto-rosso.js';
  fs.writeFileSync(path.join(dirTest, FINTO),
    '#!/usr/bin/env node\nconsole.log("rosso per costruzione");\nprocess.exit(1);\n');
  const QUAR_RE = /const QUARANTINE = \{[\s\S]*?\n\};/;
  const conVoceFinta = (scadenza) => src.replace(QUAR_RE,
    `const QUARANTINE = {\n  '${FINTO}': {\n    dal: '2020-01-01',\n    scadenza: '${scadenza}',\n` +
    `    motivo: 'voce finta della prova tests/quarantena.test.js',\n  },\n};`);

  const giraCon = (scadenza) => {
    const gemello = conVoceFinta(scadenza);
    fs.writeFileSync(path.join(dirTest, 'run-all.js'), gemello);
    const r = spawnSync(process.execPath, [path.join(dirTest, 'run-all.js'), '--pure'], {
      cwd: sandbox, encoding: 'utf8', timeout: 60000,
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  // sanità del banco di prova: la voce finta deve essere entrata nel gemello
  const controllo = conVoceFinta('2099-12-31');
  prova('il banco di prova sa scrivere la voce finta',
    controllo !== src && controllo.includes(`'${FINTO}'`) && controllo.includes("'2099-12-31'"));

  const viva = giraCon('2099-12-31');
  prova('quarantena IN CORSO + test rosso → il runner esce 0 (il riparo funziona)',
    viva.code === 0, `uscita=${viva.code}\n${viva.out}`);
  prova('…e lo dice: «riparato dalla quarantena»', /riparato dalla quarantena/.test(viva.out), viva.out);

  const morta = giraCon('2020-01-01');
  prova('quarantena SCADUTA + test rosso → il runner esce 1 (RICHIUSO DA SOLO)',
    morta.code === 1, `uscita=${morta.code}\n${morta.out}`);
  prova('…e lo dice: «QUARANTENA SCADUTA → ora BLOCCA»',
    /QUARANTENA SCADUTA/.test(morta.out), morta.out);
  prova('…e il rosso entra nel conteggio dei ROSSI, non in quello dei QUARANTENA-ROSSI',
    /ROSSI 1\b/.test(morta.out) && /QUARANTENA-ROSSI 0/.test(morta.out), morta.out);
  prova('nessun umano nel ciclo: la stessa riga di codice, due date, due verdetti',
    viva.code === 0 && morta.code === 1);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('\n════════════════════════════════════════════');
console.log(`VERDI ${ok}   ROSSI ${rotti.length}`);
if (rotti.length) {
  console.log('\nROTTI:');
  for (const r of rotti) console.log('  · ' + r);
}
console.log('════════════════════════════════════════════');
process.exit(rotti.length ? 1 : 0);
