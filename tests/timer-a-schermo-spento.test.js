#!/usr/bin/env node
'use strict';

/**
 * timer-a-schermo-spento.test.js — la sentinella che rende PERMANENTE il lavoro
 * batteria del 2026-09-22.
 *
 * IL CICLO CHE DEVE CHIUDERE (è successo davvero, non è un'ipotesi):
 *   16/08/2026 — si toglie il ping del WebSocket a schermo spento, perché
 *                svegliare la radio ogni 15s tutta la notte con l'audiolibro
 *                acceso è ciò che scaldava il telefono. La riparazione tocca
 *                `ws.js` e basta.
 *   22/09/2026 — si scopre che `topbar.js` non era mai stato guardato: due
 *                `setInterval` nudi, quattro rotte ogni 5 secondi (~48
 *                richieste al minuto) per sempre, anche di notte.
 * Stessa malattia, file diverso, un mese dopo. È esattamente il ciclo che il proprietario
 * non vuole più: «la batteria l'avevamo risolta e poi l'abbiamo rotta di nuovo».
 *
 * QUINDI QUESTA PROVA NON GUARDA topbar.js. Guarda TUTTO `public/js/`, oggi e
 * fra sei mesi, e va ROSSA se qualcuno aggiunge un timer periodico che bussa al
 * server senza passare da `window.Battito` (public/js/battito.js).
 * Chi ha un motivo vero per bussare a schermo spento non viene bloccato: lo
 * DICHIARA qui sotto, col motivo. Una lista dichiarata è una decisione che si
 * legge nel diff; uno skip silenzioso no.
 *
 * Run: node tests/timer-a-schermo-spento.test.js   (raccolto da `npm test`).
 * Analisi puramente statica: nessun server, nessun DOM, nessun effetto.
 */

const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const failures = [];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// IL MODULO CHE FA DA POSTO SOLO
// ─────────────────────────────────────────────────────────────────────────────
const HELPER_FILE = 'battito.js';
const HELPER_GLOBALE = 'Battito';

// ─────────────────────────────────────────────────────────────────────────────
// LE ECCEZIONI — DICHIARATE, COL MOTIVO
//
// Regole della lista, per non farla marcire:
//   · `file` + `riconoscimento` (regex) devono combaciare con UN timer vero. Una
//     voce che non trova più il suo timer fa ROSSO da sola: quando il codice che
//     giustificava l'eccezione sparisce, sparisce anche l'eccezione. Una lista
//     che non si può svuotare è una lista che nessuno ripulisce.
//   · il `motivo` risponde a UNA domanda sola: perché questo giro deve bussare
//     al server anche col telefono in tasca e lo schermo spento?
//   · «non ho voglia di convertirlo» non è un motivo. Se non sai rispondere,
//     convertilo.
// ─────────────────────────────────────────────────────────────────────────────
// Nota sulle regex: `riconoscimento` si confronta col testo del timer DOPO che
// commenti e stringhe sono stati tolti. Quindi NON si può riconoscere un timer
// da una sua stringa (`'dictation_state'` a quel punto non esiste più): si usa
// un IDENTIFICATORE, o il nome della forma che lo scanner gli dà.
const ECCEZIONI = [
  // ── Gruppo 1: giri a CADENZA che bussano davvero anche a schermo spento ──
  // Sono due, e sono le uniche due. Ogni voce nuova qui dentro è una richiesta
  // di svegliare la radio di notte: si giustifica o non entra.
  {
    file: 'ws.js',
    riconoscimento: /^setInterval[\s\S]*_wsLastRecv/,
    dal: '2026-08-16',
    motivo:
      'IL PING DEL WEBSOCKET È GIÀ CURATO, ED È IL MODELLO DI QUESTO LAVORO, ' +
      'non il bersaglio. Il suo setInterval resta acceso di proposito (è ' +
      'agganciato alla vita del socket, non della pagina) ma la prima riga del ' +
      'giro è `if (document.hidden) return`: a schermo spento non parte nessun ' +
      'frame — è la riparazione del 16/08/2026. Non è fiducia: la sezione D ' +
      'verifica a ogni giro che quella guardia sia ancora lì e ancora PRIMA ' +
      'della send. Se sparisce, l\'eccezione non vale più e la sentinella è rossa.',
  },
  {
    file: 'dictation.js',
    riconoscimento: /^setInterval[\s\S]*guardBeatTimer/,
    dal: '2026-08-16',
    motivo:
      'IL BATTITO DELLA DETTATURA DEVE GIRARE A SCHERMO SPENTO, ed è il suo ' +
      'unico scopo. Dice al server «sto dettando, non riavviare»; le voci ' +
      'scadono dopo 90s (server/restart-readiness.js), quindi se tacesse mentre ' +
      'il proprietario detta e lo schermo si spegne a metà presa, un deploy ucciderebbe la ' +
      'dettatura in corso — il guasto che quel codice esiste per impedire. ' +
      'Costo vero: 2 messaggi al minuto SOLO durante una dettatura, e si spegne ' +
      'da solo tornando in idle. Non è un giro perpetuo.',
  },

  // ── Gruppo 2: consegne e ritentativi, non giri perpetui ─────────────────
  // Forma «setTimeout che si riarma»: partono da un GESTO del proprietario (ha premuto
  // invio, ha finito di dettare, ha chiesto un riavvio) e finiscono quando la
  // cosa è consegnata. Addormentarli sarebbe il contrario di una riparazione:
  // perderebbero proprio il lavoro che devono portare a casa mentre lui si mette
  // il telefono in tasca. Hanno tutti una fine — ed è scritta qui sotto.
  {
    file: 'dictation.js',
    riconoscimento: /^setTimeout che si riarma \(tick\)/,
    dal: '2026-09-22',
    motivo:
      'RITIRO DELLA CLIP PER ID (startClipPolling). È la rete di salvataggio ' +
      'che fa atterrare il testo quando la POST muore in silenzio. il proprietario smette ' +
      'di dettare e si mette il telefono in tasca: se questo dormisse, la presa ' +
      'resterebbe appesa fino al prossimo sblocco. FINE: `deadlineTs`, controllata ' +
      'a ogni giro, e `clipSettled` appena il testo arriva.',
  },
  {
    file: 'dictation.js',
    riconoscimento: /^setTimeout che si riarma \(postClipHttp\)/,
    dal: '2026-09-22',
    motivo:
      'RITENTATIVO DELLA TRASCRIZIONE. FINE: MAX_ATTEMPTS = 3, con attesa che ' +
      'raddoppia (0,8s, 1,6s). Tre bussate in totale, non una cadenza.',
  },
  {
    file: 'dictation.js',
    riconoscimento: /^setTimeout che si riarma \(caricaInvio\)/,
    dal: '2026-11-10',
    motivo:
      'CARICAMENTO DEL VOCALE «INVIA MENTRE REGISTRI». il proprietario preme Invia ' +
      'e si mette il telefono in tasca: il caricamento deve finire anche a ' +
      'schermo spento, o il messaggio parte solo al prossimo sblocco. FINE: ' +
      'MAX = 3 tentativi (0,8s, 1,6s), poi la clip aspetta la riapertura.',
  },
  {
    file: 'dictation.js',
    riconoscimento: /^setTimeout che si riarma \(ritiroInvio\)/,
    dal: '2026-11-10',
    motivo:
      'RITIRO DELL\'ESITO DEL VOCALE INVIATO: serve solo a cancellare la ' +
      'copia sul telefono. FINE: `document.hidden` (a schermo spento smette ' +
      'al primo giro) e `scade` (10 minuti o 6x la durata).',
  },
  {
    file: 'dictation.js',
    riconoscimento: /^setTimeout che si riarma \(attempt\)/,
    dal: '2026-09-22',
    motivo:
      'ATTESA DEL GETTONE D\'ACCESSO all\'avvio, per chiedere UNA volta sola se ' +
      'c\'è una dettatura rimasta appesa. FINE: `tries < 20` (20 secondi al ' +
      'massimo, poi tace per sempre).',
  },
  {
    file: 'input.js',
    riconoscimento: /^setTimeout che si riarma \(processQueue\)/,
    dal: '2026-09-22',
    motivo:
      'CONSEGNA DEL MESSAGGIO GIÀ MANDATO. Riprova ogni 500ms finché ' +
      'il socket è aperto. Parte solo con la coda piena, cioè subito dopo un ' +
      'invio, e si ferma quando la coda è vuota. Addormentarlo vorrebbe dire ' +
      'lasciare un messaggio non spedito in tasca al proprietario.' +
      '  ⚠ DA RIPORTARE, non riparato qui: a differenza degli altri di questo ' +
      'gruppo NON ha un tetto di tentativi — a server spento ribussa ogni 500ms ' +
      'finché la pagina vive. Non è il guasto di oggi e non è stato toccato.',
  },
  {
    file: 'ws.js',
    riconoscimento: /^setTimeout che si riarma \(connectWebSocket\)/,
    dal: '2026-09-22',
    motivo:
      'LA RICONNESSIONE. Ha già la sua cura e la sua sentinella: l\'attesa cresce ' +
      'con un tetto (tests/riconnessione-mobile.test.js, sezione D) proprio ' +
      'perché «un telefono in tasca che ribussa ogni 5s all\'infinito è una ' +
      'batteria morta a metà giornata». E comunque ws.js non si tocca.',
  },
  {
    file: 'ws.js',
    riconoscimento: /^setTimeout che si riarma \(poll\)/,
    dal: '2026-09-22',
    motivo:
      'IL GIRO DEL MODO RIAVVIO (startRestartPolling): aspetta che la Machine ' +
      'torni su dopo un riavvio chiesto dal proprietario, e deve continuare mentre lui ' +
      'guarda altrove. Vive solo dentro il modo riavvio, non è perpetuo.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// LETTORE: si toglie di mezzo prosa e letterali PRIMA di guardare.
// Questa sentinella deve leggere il CODICE. Se leggesse anche i commenti,
// basterebbe scrivere «fetch(» in una spiegazione per farla suonare a vuoto, o
// citare `Battito.ogni` in un commento per farla tacere su un setInterval nudo.
// I newline si conservano uno per uno, così i numeri di riga restano veri.
// ─────────────────────────────────────────────────────────────────────────────
function aCapo(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return '\n'.repeat(n);
}

// Un `/` apre una regex solo se ciò che lo precede non può essere un operando.
const PRIMA_DI_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);

function pulisci(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prec = ''; // ultimo carattere significativo emesso
  while (i < n) {
    const c = src[i];
    // commento di riga
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // commento a blocco
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      out += aCapo(src.slice(start, i));
      continue;
    }
    // stringhe e template. I template si inghiottono interi, interpolazioni
    // comprese: la guardia della sezione F vieta chiamate di rete lì dentro,
    // così l'unico punto cieco dello scanner è chiuso a chiave invece che
    // lasciato al caso.
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += '""' + aCapo(src.slice(start, i));
      prec = '"';
      continue;
    }
    // letterale regex (ne esistono di veri con dentro graffe e virgolette:
    // core.js:266 `/"/g`, input.js:670 `/[*_~]{1,3}/g`). Senza questo ramo il
    // bilanciamento salterebbe e lo scanner leggerebbe spazzatura.
    if (c === '/' && PRIMA_DI_REGEX.has(prec)) {
      const start = i;
      i++;
      let inClasse = false;
      let chiusa = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break; // non era una regex: si torna indietro
        if (d === '[') inClasse = true;
        else if (d === ']') inClasse = false;
        else if (d === '/' && !inClasse) { i++; chiusa = true; break; }
        i++;
      }
      if (chiusa) {
        while (i < n && /[gimsuyd]/.test(src[i])) i++;
        out += '/RE/';
        prec = '/';
        continue;
      }
      i = start; // ripiego: era una divisione
    }
    out += c;
    if (!/\s/.test(c)) prec = c;
    i++;
  }
  return out;
}

function rigaDi(src, idx) {
  let r = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') r++;
  return r;
}

// Testo della lista argomenti di una chiamata, partendo dall'indice della `(`.
function spanChiamata(src, aperta) {
  let d = 0;
  for (let i = aperta; i < src.length; i++) {
    if (src[i] === '(') d++;
    else if (src[i] === ')') {
      d--;
      if (d === 0) return src.slice(aperta, i + 1);
    }
  }
  return src.slice(aperta);
}

// Corpo di una funzione a partire dall'indice della `{` d'apertura.
function corpoDa(src, apertaGraffa) {
  let d = 0;
  for (let i = apertaGraffa; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(apertaGraffa, i + 1);
    }
  }
  return src.slice(apertaGraffa);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAPPA DELLE FUNZIONI — serve a seguire un timer che non bussa di persona ma
// chiama qualcuno che bussa (è il caso di topbar: `setInterval(pollAll)`, e
// `pollAll` chiama `pollServer` che chiama `apiGet` che chiama `fetch`).
// Senza questo passaggio la sentinella sarebbe cieca proprio sul guasto che l'ha
// fatta nascere.
// ─────────────────────────────────────────────────────────────────────────────
function mappaFunzioni(pulito) {
  const mappa = new Map();
  const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\()|(?:(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*|)\()|(?:window\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b[^(]*\()/g;
  let m;
  while ((m = re.exec(pulito))) {
    const nome = m[1] || m[2] || m[3];
    if (!nome) continue;
    const aperta = pulito.indexOf('(', m.index + (m[0].length - 1));
    const args = spanChiamata(pulito, pulito.lastIndexOf('(', re.lastIndex - 1));
    const dopoArgs = pulito.lastIndexOf('(', re.lastIndex - 1) + args.length;
    const graffa = pulito.indexOf('{', dopoArgs);
    const freccia = pulito.slice(dopoArgs, graffa === -1 ? dopoArgs : graffa);
    if (graffa === -1) continue;
    // Solo se fra la chiusura dei parametri e la graffa non c'è altro che
    // spazi o `=>`: altrimenti quella graffa appartiene a qualcos'altro.
    if (!/^[\s)]*(=>)?[\s]*$/.test(freccia)) continue;
    if (!mappa.has(nome)) mappa.set(nome, corpoDa(pulito, graffa));
    void aperta;
  }
  return mappa;
}

// ─────────────────────────────────────────────────────────────────────────────
// COSA VUOL DIRE «BUSSA AL SERVER»
// ─────────────────────────────────────────────────────────────────────────────
const SEGNI_DI_RETE = [
  { re: /\bfetch\s*\(/, nome: 'fetch()' },
  { re: /\bXMLHttpRequest\b/, nome: 'XMLHttpRequest' },
  { re: /\bsendBeacon\s*\(/, nome: 'sendBeacon()' },
  { re: /\bEventSource\b/, nome: 'EventSource' },
  { re: /\bapi(?:Get|Post|Patch|Put|Delete)\s*\(/, nome: 'apiGet/apiPatch/...' },
  { re: /\bsendJson\s*\(/, nome: 'sendJson()' },
  { re: /\.send\s*\(/, nome: '.send() (websocket)' },
  { re: /\bprobeServer\s*\(|\bfindBestServer\s*\(/, nome: 'sonda di raggiungibilità' },
];

function segnoDiRete(testo) {
  for (const s of SEGNI_DI_RETE) if (s.re.test(testo)) return s.nome;
  return null;
}

const PROFONDITA = 3;

// Risolve le chiamate: prima nel file stesso, poi fra le funzioni globali
// dichiarate negli altri file di public/js (un timer che chiama
// `window.loadSessions()` bussa eccome, anche se il fetch è altrove).
//
// ATTENZIONE AL DETTAGLIO CHE QUI SOTTO SEMBRA UNA PIGNOLERIA E NON LO È: si
// risolvono anche i nomi NUDI, non solo quelli seguiti da `(`. Il guasto del
// 22/09 era scritto `setInterval(pollAll, 5000)` — `pollAll` passato come
// RIFERIMENTO, mai chiamato lì dentro. Una prima stesura di questa sentinella
// cercava solo `nome(` e sul guasto originale sarebbe stata VERDE. L'ha
// smascherata la sezione G, che le rimette in mano il codice di prima della cura
// e pretende che lo becchi. È il motivo per cui la sezione G esiste.
function bussa(testo, mappaLocale, mappaGlobale, visti, profondita) {
  const diretto = segnoDiRete(testo);
  if (diretto) return diretto;
  if (profondita <= 0) return null;
  const re = /\b([A-Za-z_$][\w$]*)\b/g;
  let m;
  while ((m = re.exec(testo))) {
    const nome = m[1];
    if (visti.has(nome)) continue;
    visti.add(nome);
    const corpo = mappaLocale.get(nome) || mappaGlobale.get(nome);
    if (!corpo) continue;
    const dentro = bussa(corpo, mappaLocale, mappaGlobale, visti, profondita - 1);
    if (dentro) return `${dentro} (via ${nome}())`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TROVA I TIMER PERIODICI
// Due forme, perché chiuderne una sola sarebbe un invito a usare l'altra:
//   1. setInterval(...)
//   2. setTimeout che si riarma da solo — `function tick(){ …; setTimeout(tick, 5000) }`
//      è un poll periodico identico, scritto in un altro modo.
// ─────────────────────────────────────────────────────────────────────────────
function trovaTimer(pulito, mappa) {
  const trovati = [];

  let idx = -1;
  while ((idx = pulito.indexOf('setInterval', idx + 1)) !== -1) {
    const prima = pulito[idx - 1] || '';
    if (/[\w$.]/.test(prima)) continue; // clearInterval, obj.setInterval…
    const aperta = pulito.indexOf('(', idx);
    if (aperta === -1) continue;
    trovati.push({ forma: 'setInterval', riga: rigaDi(pulito, idx), testo: spanChiamata(pulito, aperta) });
  }

  for (const [nome, corpo] of mappa) {
    let j = -1;
    while ((j = corpo.indexOf('setTimeout', j + 1)) !== -1) {
      const prima = corpo[j - 1] || '';
      if (/[\w$.]/.test(prima)) continue;
      const aperta = corpo.indexOf('(', j);
      if (aperta === -1) continue;
      const args = spanChiamata(corpo, aperta);
      const siRiarma = new RegExp('\\b' + nome.replace(/\$/g, '\\$') + '\\b').test(args);
      if (siRiarma) {
        trovati.push({ forma: `setTimeout che si riarma (${nome})`, riga: rigaDi(pulito, pulito.indexOf(corpo)), testo: corpo });
        break;
      }
    }
  }

  return trovati;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCANSIONE
// ─────────────────────────────────────────────────────────────────────────────
const fileJs = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();
const grezzi = new Map();
const puliti = new Map();
for (const f of fileJs) {
  const raw = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  grezzi.set(f, raw);
  puliti.set(f, pulisci(raw));
}

// ── A. Il lettore capisce quel che legge ────────────────────────────────────
// Se lo scanner sbaglia a togliere stringhe o regex, il bilanciamento salta e
// da lì in poi legge spazzatura — e una sentinella che legge spazzatura passa
// per caso. Meglio rossa e rumorosa che verde e cieca.
for (const f of fileJs) {
  const p = puliti.get(f);
  let graffe = 0, tonde = 0, quadre = 0, minimo = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '{') graffe++; else if (c === '}') graffe--;
    else if (c === '(') tonde++; else if (c === ')') tonde--;
    else if (c === '[') quadre++; else if (c === ']') quadre--;
    if (graffe < minimo) minimo = graffe;
  }
  check(
    `[A] lo scanner legge ${f} senza perdersi (parentesi bilanciate)`,
    graffe === 0 && tonde === 0 && quadre === 0 && minimo === 0,
    `graffe=${graffe} tonde=${tonde} quadre=${quadre}`
  );
}

// ── B. Il posto solo esiste ed è cablato ────────────────────────────────────
check(`[B] esiste public/js/${HELPER_FILE}`, fileJs.includes(HELPER_FILE));

const helperPulito = puliti.get(HELPER_FILE) || '';
check(
  `[B] ${HELPER_FILE} espone window.${HELPER_GLOBALE}.ogni()`,
  /window\.Battito\s*=/.test(helperPulito) && /\bogni\s*:/.test(helperPulito)
);
check(
  '[B] il battito NON bussa a schermo spento (guardia document.hidden dentro il giro)',
  /document\.hidden/.test(helperPulito) && /nascosto\s*\(\s*\)/.test(helperPulito)
);
// I nomi degli eventi sono STRINGHE, e il lettore le toglie: qui si guarda il
// sorgente senza i soli commenti. Il confronto con ws.js è il punto di tutto il
// lavoro — due moduli che si svegliano su eventi diversi sarebbero di nuovo due
// meccaniche, cioè il guasto che questa prova esiste per impedire.
const helperSenzaProsa = (grezzi.get(HELPER_FILE) || '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const wsSenzaProsa = (grezzi.get('ws.js') || '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const RISVEGLI = ['visibilitychange', 'pageshow', 'focus', 'online', 'appStateChange', 'resume'];
for (const ev of RISVEGLI) {
  check(
    `[B] il battito si risveglia su '${ev}', come ws.js`,
    helperSenzaProsa.includes(ev),
    `ws.js lo usa (${wsSenzaProsa.includes(ev) ? 'confermato nel sorgente' : 'NON più: allinea entrambi'})`
  );
}
check(
  '[B] al ritorno fa subito un giro (niente numeri stantii mentre si aspetta il tick)',
  /subitoAlRitorno/.test(helperPulito)
);

const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const posBattito = indexHtml.indexOf('js/' + HELPER_FILE);
const posTopbar = indexHtml.indexOf('js/topbar.js');
const posDict = indexHtml.indexOf('js/dictation.js');
check('[B] index.html carica battito.js', posBattito !== -1);
check(
  '[B] battito.js carica PRIMA di chi lo usa (topbar.js, dictation.js)',
  posBattito !== -1 && posBattito < posTopbar && posBattito < posDict,
  `battito@${posBattito} topbar@${posTopbar} dictation@${posDict}`
);
const sw = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
check(
  '[B] battito.js sta nel guscio del service worker (o offline la barra resta ferma)',
  sw.includes("'/js/" + HELPER_FILE + "'"),
  'topbar.js è in SHELL_ASSETS: il suo prerequisito deve esserci anche lui'
);

// ── C. LA LEGGE — nessun timer periodico che bussa, fuori dal battito ───────
// SOLO i veri globali (`window.NOME = function`). Tentazione scartata: mettere
// qui dentro OGNI funzione di OGNI file. Provato, e fa danni — `start`, `poll`,
// `tick`, `install` esistono in mezzo file diversi, e la guardia biometrica
// (biometric.js, tolta il 12/11/2026) finiva accusata di bussare «via start() via ensureBar()» prendendo lo `start`
// di topbar.js. Una sentinella che accusa a caso viene ammorbidita entro un
// mese, e allora tanto vale non averla.
const mappaGlobale = new Map();
for (const f of fileJs) {
  if (f === HELPER_FILE) continue;
  const p = puliti.get(f);
  const re = /window\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g;
  let m;
  while ((m = re.exec(p))) {
    const graffa = p.indexOf('{', re.lastIndex);
    if (graffa === -1) continue;
    if (!mappaGlobale.has(m[1])) mappaGlobale.set(m[1], corpoDa(p, graffa));
  }
}

const eccezioniUsate = new Set();
const colpevoli = [];
const censimento = [];

for (const f of fileJs) {
  // Il battito È la meccanica: il suo setInterval è il posto solo, non una
  // violazione. È l'unico file autorizzato a scriverne uno per mestiere.
  if (f === HELPER_FILE) continue;
  const p = puliti.get(f);
  const mappaLocale = mappaFunzioni(p);
  for (const t of trovaTimer(p, mappaLocale)) {
    const motivoRete = bussa(t.testo, mappaLocale, mappaGlobale, new Set(), PROFONDITA);
    if (!motivoRete) {
      censimento.push({ f, t, esito: 'non bussa' });
      continue;
    }
    // Si riconosce su forma + corpo: la «forma» porta il nome della funzione che
    // si riarma, l'unico appiglio stabile per quella famiglia di timer.
    const impronta = t.forma + '\n' + t.testo;
    const ecc = ECCEZIONI.find((e) => e.file === f && e.riconoscimento.test(impronta));
    if (ecc) {
      eccezioniUsate.add(ecc);
      censimento.push({ f, t, esito: 'ECCEZIONE dichiarata' });
      continue;
    }
    colpevoli.push({ f, t, motivoRete });
  }
}

check(
  '[C] NESSUN timer periodico bussa al server fuori da window.Battito',
  colpevoli.length === 0,
  colpevoli.length
    ? colpevoli
        .map((c) => `${c.f}${c.t.riga ? ':' + c.t.riga : ''} (${c.t.forma}) → ${c.motivoRete}`)
        .join(' | ') +
      `  ⇒ convertilo: window.${HELPER_GLOBALE}.ogni('nome', ms, fn). Se DEVE bussare ` +
      'a schermo spento, dichiaralo in ECCEZIONI qui sopra col motivo.'
    : ''
);

// Una lista di eccezioni che non si può svuotare non la ripulisce nessuno: una
// voce che non trova più il suo timer è essa stessa un rosso.
for (const e of ECCEZIONI) {
  check(
    `[C] l'eccezione dichiarata per ${e.file} (dal ${e.dal}) trova ancora il suo timer`,
    eccezioniUsate.has(e),
    'il codice che la giustificava non c\'è più, o è cambiato: togli la voce da ECCEZIONI'
  );
}

// ── D. L'eccezione di ws.js vale SOLO finché il suo ping dorme davvero ──────
// È l'unico modo onesto di esentarlo: non «ci fidiamo», ma «lo verifichiamo».
{
  const p = puliti.get('ws.js') || '';
  const i = p.indexOf('setInterval');
  const corpo = i === -1 ? '' : spanChiamata(p, p.indexOf('(', i));
  const iHidden = corpo.indexOf('document.hidden');
  const iSend = corpo.indexOf('.send(');
  check(
    '[D] il ping di ws.js ha ancora la guardia document.hidden PRIMA di spedire',
    iHidden !== -1 && iSend !== -1 && iHidden < iSend,
    'se la guardia sparisce, la riparazione batteria del 16/08/2026 è di nuovo rotta'
  );
}

// ── E. Sentinella puntuale sul guasto del 22/09: topbar.js ─────────────────
{
  const p = puliti.get('topbar.js') || '';
  const nudi = (p.match(/(?<![\w$.])setInterval\s*\(/g) || []).length;
  check('[E] topbar.js non ha più nessun setInterval nudo', nudi === 0, `trovati ${nudi}`);
  const usi = (p.match(/Battito\.ogni\s*\(/g) || []).length;
  check('[E] topbar.js registra i suoi DUE giri sul battito', usi === 2, `trovati ${usi}`);
  check(
    '[E] topbar.js non ripiega su setInterval se il battito manca (sarebbe la seconda meccanica)',
    !/setInterval/.test(p)
  );
}

// ── F. L'unico punto cieco dello scanner, chiuso a chiave ──────────────────
// I template literal si inghiottono interi (interpolazioni comprese), quindi una
// chiamata di rete scritta dentro `${…}` non si vedrebbe. Invece di sperare che
// nessuno lo faccia, lo si vieta e lo si dice.
for (const f of fileJs) {
  const raw = grezzi.get(f);
  const senzaCommenti = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const cieco = /\$\{[^}]*\b(?:fetch|apiGet|apiPatch|apiPost|sendJson)\s*\(/.test(senzaCommenti);
  check(
    `[F] ${f}: nessuna chiamata di rete dentro un template literal (lo scanner non la vedrebbe)`,
    !cieco,
    'portala fuori da ${…}: dentro, questa sentinella è cieca'
  );
}

// ── G. LA PROVA CHE LA PROVA NON È VUOTA ───────────────────────────────────
// Una sentinella verde non dimostra niente finché non si è visto che sa andare
// rossa. Qui le si dà in pasto il codice ESATTO che c'era in topbar.js prima
// della cura, e si pretende che lo becchi; poi la versione curata, e si pretende
// che la lasci passare.
{
  const primaDellaCura = `
    (function(){
      function apiGet(p){ return fetch(base()+p); }
      function pollServer(){ apiGet('/api/status/server'); }
      function pollAll(){ pollServer(); }
      var pollTimer = setInterval(pollAll, 5000);
    })();
  `;
  const p1 = pulisci(primaDellaCura);
  const m1 = mappaFunzioni(p1);
  const t1 = trovaTimer(p1, m1);
  const beccato = t1.some((t) => bussa(t.testo, m1, new Map(), new Set(), PROFONDITA));
  check('[G] la sentinella BECCA il topbar.js di prima della cura (setInterval → pollAll → fetch)', beccato);

  const dopoLaCura = `
    (function(){
      function apiGet(p){ return fetch(base()+p); }
      function pollAll(){ apiGet('/api/status/server'); }
      window.Battito.ogni('topbar-poll', 5000, pollAll);
    })();
  `;
  const p2 = pulisci(dopoLaCura);
  const m2 = mappaFunzioni(p2);
  check('[G] la sentinella LASCIA PASSARE la versione curata', trovaTimer(p2, m2).length === 0);

  const furbata = `
    (function(){
      function tick(){ fetch('/api/status/server'); setTimeout(tick, 5000); }
      tick();
    })();
  `;
  const p3 = pulisci(furbata);
  const m3 = mappaFunzioni(p3);
  const t3 = trovaTimer(p3, m3);
  check(
    '[G] la sentinella becca anche il poll scritto come setTimeout che si riarma',
    t3.length > 0 && t3.some((t) => bussa(t.testo, m3, new Map(), new Set(), PROFONDITA))
  );

  const prosa = `
    (function(){
      // qui una volta c'era setInterval(pollAll, 5000) con dentro fetch()
      var s = "setInterval(function(){ fetch('/api/x'); }, 1000)";
      window.Battito.ogni('x', 5000, function(){ fetch('/api/x'); });
    })();
  `;
  const p4 = pulisci(prosa);
  check(
    '[G] commenti e stringhe non possono far suonare (né zittire) la sentinella',
    trovaTimer(p4, mappaFunzioni(p4)).length === 0
  );
}

// ── H. IL BATTITO FA DAVVERO QUEL CHE PROMETTE ─────────────────────────────
// Le sezioni sopra leggono il codice. Questa lo ACCENDE: battito.js viene
// eseguito in una stanza finta (vm) con un finto `document`, un finto `window` e
// timer a manovella, e gli si fa vivere una notte del proprietario. Leggere «c'è scritto
// document.hidden» non è la stessa cosa che vedere il contatore non salire.
{
  const vm = require('vm');

  function stanza() {
    const timer = new Map();
    let seq = 0;
    const ascolto = { doc: {}, win: {} };
    const documentoFinto = {
      hidden: false,
      addEventListener: (ev, fn) => { (ascolto.doc[ev] = ascolto.doc[ev] || []).push(fn); },
    };
    const finestraFinta = {
      addEventListener: (ev, fn) => { (ascolto.win[ev] = ascolto.win[ev] || []).push(fn); },
    };
    const ctx = {
      window: finestraFinta,
      document: documentoFinto,
      console: { warn() {}, log() {}, error() {} },
      setInterval: (fn) => { const id = ++seq; timer.set(id, fn); return id; },
      clearInterval: (id) => { timer.delete(id); },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(JS_DIR, HELPER_FILE), 'utf8'), ctx);
    return {
      doc: documentoFinto,
      Battito: finestraFinta.Battito,
      accesi: () => timer.size,
      scatta: () => { for (const fn of Array.from(timer.values())) fn(); },
      evento: (dove, ev) => { for (const fn of (ascolto[dove][ev] || [])) fn({}); },
    };
  }

  // 1) Una notte intera, dal vivo.
  {
    const s = stanza();
    check('[H] battito.js si accende e pubblica window.Battito', !!(s.Battito && s.Battito.ogni));
    let bussate = 0;
    s.Battito.ogni('prova', 5000, function () { bussate++; });
    check('[H] a schermo acceso fa subito un giro', bussate === 1, `bussate=${bussate}`);
    s.scatta();
    check('[H] e poi bussa a ogni tick', bussate === 2, `bussate=${bussate}`);

    // Schermo spento: è il momento che conta.
    s.doc.hidden = true;
    s.evento('doc', 'visibilitychange');
    check('[H] a schermo spento il timer è proprio SPENTO, non solo silenzioso', s.accesi() === 0);
    for (let i = 0; i < 1000; i++) s.scatta();
    check(
      '[H] mille tick a schermo spento = ZERO bussate (la notte del proprietario)',
      bussate === 2,
      `bussate=${bussate}`
    );

    // Ritorno.
    s.doc.hidden = false;
    s.evento('doc', 'visibilitychange');
    check('[H] al ritorno fa SUBITO un giro (niente numeri stantii)', bussate === 3, `bussate=${bussate}`);
    check('[H] al ritorno il timer è di nuovo acceso', s.accesi() === 1);
    s.scatta();
    check('[H] e la cadenza riparte', bussate === 4, `bussate=${bussate}`);

    // `focus` su PC scatta di continuo: non deve diventare un poll a raffica.
    s.evento('win', 'focus');
    s.evento('win', 'focus');
    s.evento('win', 'focus');
    check('[H] un focus su chi è già sveglio non fa bussate in più', bussate === 4, `bussate=${bussate}`);
  }

  // 2) Registrarsi mentre lo schermo è già spento non deve bussare.
  {
    const s = stanza();
    s.doc.hidden = true;
    let bussate = 0;
    s.Battito.ogni('nato-al-buio', 5000, function () { bussate++; });
    check('[H] un battito registrato a schermo spento non bussa e non si arma', bussate === 0 && s.accesi() === 0);
    s.doc.hidden = false;
    s.evento('win', 'pageshow');
    check('[H] …e parte da solo al primo risveglio', bussate === 1 && s.accesi() === 1, `bussate=${bussate}`);
  }

  // 3) BRETELLE: se l'evento di sonno non arriva mai (WebView strane, Capacitor
  //    che non registra i listener) il primo tick al buio si spegne da solo.
  //    Senza questa rete, un evento perso varrebbe una notte di bussate.
  {
    const s = stanza();
    let bussate = 0;
    s.Battito.ogni('senza-eventi', 5000, function () { bussate++; });
    s.doc.hidden = true; // schermo spento, ma NESSUN evento emesso
    s.scatta();
    check('[H] schermo spento senza evento: il tick non bussa', bussate === 1, `bussate=${bussate}`);
    check('[H] …e il timer si spegne da solo lo stesso', s.accesi() === 0);
  }

  // 4) Un giro che esplode non si porta via la cadenza.
  {
    const s = stanza();
    let giri = 0;
    s.Battito.ogni('rompe', 5000, function () { giri++; throw new Error('bum'); });
    s.scatta();
    s.scatta();
    check('[H] un giro che solleva un errore non spegne il battito', giri === 3 && s.accesi() === 1, `giri=${giri}`);
  }

  // 5) ferma() ferma per sempre, anche attraverso un risveglio.
  {
    const s = stanza();
    let bussate = 0;
    const m = s.Battito.ogni('da-fermare', 5000, function () { bussate++; });
    m.ferma();
    s.scatta();
    s.doc.hidden = false;
    s.evento('doc', 'visibilitychange');
    check('[H] ferma() è definitivo: nemmeno un risveglio lo resuscita', bussate === 1, `bussate=${bussate}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
console.log('');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);

console.log('\n   [censimento] timer periodici in public/js/:');
for (const r of censimento) {
  console.log(`     ${r.f}${r.t.riga ? ':' + r.t.riga : ''}  ${r.t.forma}  → ${r.esito}`);
}
console.log(`     ${HELPER_FILE}  → È il posto solo (window.${HELPER_GLOBALE})`);
for (const e of ECCEZIONI) console.log(`     ECCEZIONE dichiarata: ${e.file} (dal ${e.dal})`);

// La misura, perché il punto non era il codice ma la batteria del proprietario.
{
  const oreNotte = 8;
  const primaAlMinuto = (60 / 5) * 4 + (60 / 1) * 0; // 4 rotte ogni 5s
  console.log(
    `\n   [misura] topbar a schermo spento: prima ~${primaAlMinuto} richieste/minuto ` +
    `(~${primaAlMinuto * 60 * oreNotte} in una notte di ${oreNotte}h, audiolibro acceso), adesso 0.`
  );
}

if (failures.length) {
  console.error(`\n✗ sentinella timer-a-schermo-spento FALLITA (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`\n✓ sentinella timer-a-schermo-spento passata (${checks.length} controlli)`);
