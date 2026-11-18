#!/usr/bin/env node
'use strict';

/**
 * riconnessione-mobile.test.js — sentinella della riparazione del 2026-09-15.
 *
 * IL GUASTO CHE SORVEGLIA (misurato il 15/09, non ipotizzato):
 * il telefono del proprietario non sta sul Wi-Fi di casa, sta su rete mobile (endpoint
 * 37.161.63.197 = l'operatore). Su quella strada una prova di raggiungibilità
 * paga IN SERIE la radio che si sveglia da Doze, la risoluzione MagicDNS e poi
 * TCP. `probeServer` aveva 1500ms: un collegamento soltanto LENTO sforava su
 * OGNI candidato, `findBestServer` concludeva «No candidates reachable» e
 * l'app restava attaccata a un indirizzo che non aveva mai davvero smentito.
 * Quello è il «riprende da sola solo dopo un po'» che il proprietario sente ogni giorno,
 * ed è codice nostro.
 *
 * DUE ROSSE RICHIESTE ESPLICITAMENTE DA il proprietario, e provate rimettendo il codice
 * sbagliato prima di consegnare:
 *   1. timeout rimesso a 1,5s            ⇒ ROSSA (sezione A)
 *   2. il ramo «keeping» che torna senza
 *      riferire l'esito, così chi
 *      riconnette non può ritentare
 *      diversamente                      ⇒ ROSSA (sezione B)
 *
 * E una terza legge che vale quanto le altre: l'attesa che cresce DEVE avere
 * un tetto (sezione D). Un telefono in tasca che ribussa ogni 5s all'infinito
 * è una batteria morta a metà giornata — il contrario di una riparazione.
 *
 * Run: node tests/riconnessione-mobile.test.js   (raccolto da `npm test`).
 * Analisi statica + esecuzione della sola funzione pura: nessun server, nessun
 * DOM, nessun effetto collaterale.
 */

const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const read = (f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8');

const failures = [];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// I commenti si tolgono PRIMA di guardare: questa sentinella deve leggere il
// CODICE, non la prosa che lo racconta. Altrimenti basterebbe scrivere «1500»
// dentro una spiegazione per farla suonare a vuoto — o, peggio, per farla
// tacere citando il valore giusto in un commento e sbagliandolo nel codice.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Estrae il corpo di una funzione per bilanciamento di graffe, saltando prima
// la lista dei parametri.
function funcBody(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) start = src.indexOf('function ' + name + ' (');
  if (start === -1) return null;
  let i = src.indexOf('(', start);
  let pdepth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { i++; break; } }
  }
  const open = src.indexOf('{', i);
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return null;
}

const coreRaw = read('core.js');
const wsRaw = read('ws.js');
const core = stripComments(coreRaw);
const ws = stripComments(wsRaw);

// ── A. IL CRONOMETRO — rosso se qualcuno rimette 1,5s ────────────────────────
const mProbe = core.match(/var\s+PROBE_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
check(
  'core.js dichiara PROBE_TIMEOUT_MS in un posto solo',
  !!mProbe,
  'la durata della prova deve essere una costante nominata, non un numero sparso nel corpo'
);
const probeMs = mProbe ? Number(mProbe[1]) : null;
check(
  'PROBE_TIMEOUT_MS regge la rete mobile (>= 3000ms)',
  probeMs !== null && probeMs >= 3000,
  `trovato ${probeMs}ms — con 1500ms un collegamento solo LENTO viene dichiarato morto ` +
  'e l\'app resta attaccata a un URL che non ha mai smentito'
);

const probeBody = funcBody(core, 'probeServer');
check('core.js: probeServer esiste', !!probeBody);
check(
  'probeServer usa la costante, non un numero scritto a mano',
  !!probeBody && /setTimeout\([^]*?,\s*PROBE_TIMEOUT_MS\s*\)/.test(probeBody),
  'un letterale qui rimette in piedi il guasto senza far scattare il controllo qui sopra'
);
check(
  'probeServer non contiene piu alcun timeout letterale',
  !!probeBody && !/setTimeout\([^]*?,\s*\d+\s*\)/.test(probeBody),
  'nessun numero nudo come scadenza della prova'
);

// ── B. L'ESITO — rosso se «keeping» torna senza riferire ─────────────────────
const bestBody = funcBody(core, 'findBestServer');
check('core.js: findBestServer esiste', !!bestBody);
check(
  'findBestServer riferisce il successo (return true)',
  !!bestBody && /\breturn\s+true\s*;/.test(bestBody)
);
check(
  'findBestServer riferisce il fallimento (return false)',
  !!bestBody && /\breturn\s+false\s*;/.test(bestBody)
);

// Il cuore della seconda rossa: il ramo che scrive «keeping» DEVE finire con un
// verdetto. Se torna muto, chi riconnette non puo distinguere «ho trovato la
// scatola» da «sto tenendo un indirizzo forse morto» — ed e esattamente quello
// che teneva il telefono appeso al nulla.
const catchIdx = bestBody ? bestBody.indexOf('catch') : -1;
const codaCatch = catchIdx !== -1 ? bestBody.slice(catchIdx) : '';
check(
  'il ramo «No candidates reachable / keeping» riferisce false a chi lo ha chiamato',
  /No candidates reachable/.test(coreRaw) &&
  /No candidates reachable[^]*?\breturn\s+false\s*;/.test(bestBody || ''),
  'il catch scriveva in console e finiva li: un fallimento va riportato con un ' +
  'VALORE, non lasciato indovinare'
);
check(
  'il fallimento non svuota serverUrl (si tiene l\'ultimo indirizzo noto)',
  !!codaCatch && !/window\.serverUrl\s*=\s*(null|''|"")/.test(codaCatch),
  'tenere l\'ultimo indirizzo e giusto: quello che mancava era DIRLO'
);

// findBestServer non deve MAI rigettare: tre chiamanti (init.js, ws.js
// _reconnectNow, ws.js) si appoggiano a questa proprieta per proseguire comunque.
check(
  'findBestServer non rigetta mai di proposito (nessun throw nel corpo)',
  !!bestBody && !/\bthrow\b/.test(bestBody),
  'un throw qui romperebbe i chiamanti che si fidano del fatto che non rigetti'
);

// ── C. UN SOLO MECCANISMO — l'esito va CONSUMATO, non affiancato ─────────────
// Ordine del proprietario: «Non inventare un secondo meccanismo di riconnessione: ce n'e
// gia uno». Il booleano serve a NULLA se ws.js lo butta via.
check(
  'ws.js consuma l\'esito della prova per decidere l\'attesa',
  /window\.wsNextReconnectDelay\s*\(\s*window\.reconnectDelay\s*,/.test(ws),
  'findBestServer riferisce ma nessuno ascolta'
);
check(
  'ws.js: il ramo di fallimento della prova riferisce false',
  /catch\s*\([^)]*\)\s*\{\s*_reconnectAfterProbe\s*\(\s*false\s*\)/.test(ws),
  'una prova andata male deve valere come «non ho trovato nessuno», non come successo'
);
check(
  'l\'attesa si calcola DOPO la prova, non prima',
  !/window\.reconnectDelay\s*=\s*Math\.min\(\s*window\.reconnectDelay\s*\*\s*2\s*,\s*5000\s*\)/.test(ws),
  'il vecchio raddoppio cieco prima di findBestServer ignora l\'esito: e il guasto'
);
// Un secondo temporizzatore di riconnessione accanto a quello esistente sarebbe
// peggio del guasto. Ce ne deve restare UNO.
const schedulers = (ws.match(/wsReconnectTimer\s*=\s*setTimeout\(/g) || []).length;
check(
  'resta UN SOLO temporizzatore di riconnessione',
  schedulers === 1,
  `trovati ${schedulers}: due meccanismi che non si conoscono sono peggio di uno fatto male`
);

// ── D. IL TETTO — la batteria ────────────────────────────────────────────────
const mBrisk = ws.match(/var\s+WS_RECONNECT_CAP_BRISK\s*=\s*(\d+)\s*;/);
const mDark = ws.match(/var\s+WS_RECONNECT_CAP_DARK\s*=\s*(\d+)\s*;/);
check('ws.js dichiara il tetto brioso', !!mBrisk);
check('ws.js dichiara il tetto buio', !!mDark);
const brisk = mBrisk ? Number(mBrisk[1]) : null;
const dark = mDark ? Number(mDark[1]) : null;
check(
  'il tetto buio e piu lento di quello brioso',
  brisk !== null && dark !== null && dark > brisk,
  `brioso ${brisk} / buio ${dark} — se sono uguali la distinzione non esiste e ` +
  'il telefono in tasca ribussa alla cadenza da schermo acceso'
);
check(
  'il tetto buio esiste davvero (non infinito, non assurdo)',
  dark !== null && dark >= 30000 && dark <= 300000,
  `trovato ${dark}ms: un tetto c'e, e non e ne finto ne una resa`
);
check(
  'la prova entra dentro un ciclo brioso (PROBE_TIMEOUT_MS < tetto brioso)',
  probeMs !== null && brisk !== null && probeMs < brisk,
  `prova ${probeMs}ms vs ciclo ${brisk}ms: se la prova dura piu del ciclo, i giri ` +
  'si accavallano l\'uno sull\'altro'
);

// Il tetto buio e sicuro SOLO perche il ritorno non passa dal temporizzatore:
// online / visibilitychange / pageshow / focus / resume Capacitor chiamano
// _reconnectNow(), che riporta l'attesa a 500ms e riconnette subito. Se questa
// scorciatoia sparisce, 60s diventano 60s di attesa vera davanti al proprietario.
check(
  'esiste la scorciatoia _reconnectNow che azzera l\'attesa al risveglio',
  /function\s+_reconnectNow\s*\(/.test(ws) &&
  /window\.reconnectDelay\s*=\s*500\s*;/.test(ws),
  'senza questo, il tetto buio ritarderebbe il ritorno invece di risparmiare batteria'
);
for (const ev of ['online', 'visibilitychange', 'pageshow', 'focus']) {
  check(
    `il risveglio via "${ev}" e ancora agganciato`,
    new RegExp(`['"]${ev}['"]`).test(ws),
    'il tetto buio si regge su questi risvegli: se cade uno, il ritorno rallenta'
  );
}

// ── E. LA FUNZIONE PURA, ESEGUITA DAVVERO ────────────────────────────────────
// Non basta che il codice sia scritto giusto: si esegue. Ritaglio le due
// costanti e l'assegnazione dal sorgente vero (niente copia incollata qui
// dentro, che invecchierebbe in silenzio) e le faccio girare su un window finto.
let nextDelay = null;
try {
  const from = wsRaw.indexOf('var WS_RECONNECT_CAP_BRISK');
  const assign = wsRaw.indexOf('window.wsNextReconnectDelay', from);
  const bodyStart = wsRaw.indexOf('{', wsRaw.indexOf('foundServer', assign));
  let depth = 0, end = -1;
  for (let j = bodyStart; j < wsRaw.length; j++) {
    if (wsRaw[j] === '{') depth++;
    else if (wsRaw[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  const frammento = wsRaw.slice(from, end) + ';';
  const fakeWindow = {};
  new Function('window', frammento)(fakeWindow);
  nextDelay = fakeWindow.wsNextReconnectDelay;
} catch (e) {
  nextDelay = null;
}
check(
  'wsNextReconnectDelay si estrae ed esegue dal sorgente vero',
  typeof nextDelay === 'function',
  'la funzione dev\'essere PURA (niente DOM, niente socket): e l\'unico modo di provarla'
);

if (typeof nextDelay === 'function') {
  // Schermo acceso, il server risponde: cadenza briosa, tetto a 5s.
  let d = 500, viste = [];
  for (let i = 0; i < 8; i++) { d = nextDelay(d, true); viste.push(d); }
  check(
    'con un server trovato l\'attesa sale e si ferma al tetto brioso',
    JSON.stringify(viste) === JSON.stringify([1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000]),
    'visto: ' + JSON.stringify(viste)
  );

  // In tasca, nessuno risponde: l'attesa continua a crescere fino al tetto buio.
  d = 500; viste = [];
  for (let i = 0; i < 9; i++) { d = nextDelay(d, false); viste.push(d); }
  check(
    'senza nessun server l\'attesa sale fino al tetto buio e li si ferma',
    JSON.stringify(viste) === JSON.stringify([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]),
    'visto: ' + JSON.stringify(viste)
  );

  // Il tetto regge per sempre: un'ora di buio non lo sfonda.
  d = 60000;
  for (let i = 0; i < 1000; i++) d = nextDelay(d, false);
  check('il tetto buio regge per sempre', d === dark, `dopo 1000 giri: ${d}`);

  // Zero e negativi non azzerano la crescita (difesa dal reset a 0).
  check('un\'attesa a 0 riparte comunque in avanti', nextDelay(0, false) > 0);
  check('un\'attesa negativa non manda l\'attesa all\'indietro', nextDelay(-5000, false) > 0);

  // Tornare in luce riabbassa subito il tetto: appena la prova trova qualcuno,
  // l'attesa non puo restare a 60s.
  check(
    'appena la prova ritrova un server l\'attesa ricade sotto il tetto brioso',
    nextDelay(60000, true) === brisk,
    `visto ${nextDelay(60000, true)}: dal buio alla luce si deve tornare briosi subito`
  );

  // IL PUNTO DI TUTTO L'ESERCIZIO: un'ora di telefono in tasca senza rete.
  // Prima: tetto 5s ⇒ 720 bussate/ora, ognuna con una prova HTTP per candidato
  // PIU l'apertura di un WebSocket, sulla stessa radio che il lavoro batteria
  // del 16/08 aveva smesso di svegliare per i ping.
  let t = 0, bussate = 0, attesa = 500;
  while (t < 3600000) { attesa = nextDelay(attesa, false); t += attesa; bussate++; }
  const prima = Math.floor(3600000 / 5000);
  check(
    'un\'ora in tasca senza rete costa molte meno bussate di prima',
    bussate < prima / 5,
    `adesso ${bussate} bussate/ora, prima ${prima}`
  );
  console.log(`\n   [misura] un'ora in tasca senza rete: ${bussate} bussate (prima: ${prima})`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
if (failures.length) {
  console.error(`\n✗ sentinella riconnessione-mobile FALLITA (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`\n✓ sentinella riconnessione-mobile passata (${checks.length} controlli)`);
