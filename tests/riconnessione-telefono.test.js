#!/usr/bin/env node
'use strict';

/**
 * riconnessione-telefono.test.js — sentinella della riparazione del 2026-09-22.
 *
 * SORELLA di tests/riconnessione-mobile.test.js (15/09, il cronometro della
 * prova tarato per la LAN). Quella cura era giusta ma aveva un pezzo mancante:
 * il ripiego che doveva salvarci quando l'indirizzo e' morto NON ESISTEVA, e
 * il socket vecchio poteva spegnere il battito di quello nuovo.
 *
 * LE QUATTRO LEGGI CHE SORVEGLIA, ognuna nata da un guasto misurato:
 *
 *   A. NESSUNA CHIAVE FANTASMA. core.js leggeva '151-tailscale-url' e
 *      '151-lan-url' per costruire una lista di indirizzi di ripiego che
 *      NESSUNO in tutto il progetto ha mai scritto. La lista aveva sempre un
 *      elemento solo e la protezione promessa nei commenti non esisteva.
 *      La legge e' generale, non su quei due nomi: una chiave letta e mai
 *      scritta e' una finzione, e una finzione in un codice di rete fa
 *      smettere di cercare il guasto vero.
 *
 *   B. OGNI GESTORE PARLA SOLO DEL SUO SOCKET. `onclose` azzerava battito e
 *      stato «collegato» senza guardare QUALE socket si stesse chiudendo. Il
 *      guardiano dello zombie chiama connectWebSocket proprio quando il socket
 *      e' mezzo morto — e un socket mezzo morto si chiude TARDI, mentre quello
 *      nuovo si apre subito: la chiusura in ritardo del vecchio spegneva il
 *      battito del nuovo e lo marcava offline. La bandiera globale
 *      `intentionalClose` non bastava perche' l'onopen del socket nuovo la
 *      rimetteva a false prima che il vecchio la leggesse.
 *
 *   C. UN ERRORE NON E' «NESSUN DATO». api() non aveva tetto di tempo e non
 *      guardava res.ok: una pagina HTML 502/504 del relay diventava `null`,
 *      identico a «il server ha risposto, non c'e' niente». E una fetch appesa
 *      congelava loadSessions() per sempre (la Promise in volo viene
 *      restituita a tutti i chiamanti successivi).
 *      ⚠ Il rovescio della legge conta quanto la legge: un esito non-ok con
 *      corpo JSON DEVE continuare a tornare il corpo — sessions.js ci legge il
 *      409 «gia' in corso» di /ecosystem-restart.
 *
 *   D. IL CRONOMETRO DELL'AVVIO NON MISURA DUE COSE DIVERSE. Un solo abort a
 *      6s copriva connessione, intestazioni E il corpo di /api/sessions, che
 *      porta la storia intera di ogni sessione (313 KB misurati il 27/08) e
 *      non ha tetto. Tagliarlo non fa risparmiare: butta i byte gia' scesi e
 *      costringe loadSessions() a riscaricare tutto.
 *
 * Run: node tests/riconnessione-telefono.test.js   (raccolto da `npm test`).
 * Analisi statica + ESECUZIONE VERA delle funzioni estratte dal sorgente:
 * nessun server, nessun DOM, nessuna rete.
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
// CODICE, non la prosa che lo racconta. La storia di un guasto VA scritta nei
// commenti (e infatti i nomi delle chiavi fantasma sono citati li' dentro): se
// leggessimo anche quelli, raccontare il guasto lo farebbe sembrare vivo.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Estrae una funzione INTERA (dichiarazione compresa) per bilanciamento di
// graffe. Serve a rieseguirla davvero, non a fidarsi di come e' scritta.
function funcSource(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
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
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

const coreRaw = read('core.js');
const wsRaw = read('ws.js');
const initRaw = read('init.js');
const core = stripComments(coreRaw);
const ws = stripComments(wsRaw);
const init = stripComments(initRaw);

// ── A. NESSUNA CHIAVE FANTASMA ───────────────────────────────────────────────
// Legge generale: ogni chiave di localStorage LETTA da public/js dev'essere
// anche SCRITTA da public/js. Le chiavi composte (prefisso + id) si
// riconoscono dal `+` che segue e non contano.
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
const letteDa = new Map();
const scritte = new Set();
for (const f of jsFiles) {
  const src = stripComments(read(f));
  let m;
  const rg = /localStorage\.getItem\(\s*'([^']+)'\s*(\+?)/g;
  while ((m = rg.exec(src))) {
    if (m[2] === '+') continue; // chiave composta: il nome vero non e' questo
    if (!letteDa.has(m[1])) letteDa.set(m[1], new Set());
    letteDa.get(m[1]).add(f);
  }
  const wg = /localStorage\.(?:setItem|removeItem)\(\s*'([^']+)'\s*(\+?)/g;
  while ((m = wg.exec(src))) {
    if (m[2] === '+') continue;
    scritte.add(m[1]);
  }
}
const fantasma = [...letteDa.keys()].filter((k) => !scritte.has(k));
check(
  'nessuna chiave di localStorage viene letta senza che qualcuno la scriva',
  fantasma.length === 0,
  'fantasmi: ' + fantasma.map((k) => `${k} (letta da ${[...letteDa.get(k)].join(', ')})`).join(' · ') +
  ' — una chiave che nessuno scrive vale sempre null: il ramo che ne dipende e ' +
  'la protezione che promette NON ESISTONO'
);

for (const k of ['151-tailscale-url', '151-lan-url']) {
  check(
    `la chiave fantasma '${k}' non e tornata in core.js`,
    !core.includes(k),
    'era il finto ripiego su un secondo indirizzo. Il telefono ha UNA strada ' +
    'sola (Pi via Tailscale, col PC DIETRO il Pi via relay): se si rimette una ' +
    'lista di candidati, prima la deve scrivere qualcuno e deve portare a un ' +
    'indirizzo che dal telefono risponde davvero'
  );
}
check(
  'l\'indirizzo del server ha una fonte sola e nominata',
  /function\s+getServerAddress\s*\(/.test(core) &&
  /localStorage\.getItem\('151-server-url'\)/.test(core),
  'senza un posto unico la prossima lista di candidati nasce di nuovo per sbaglio'
);
check(
  'findBestServer rilegge l\'indirizzo dalla configurazione a ogni giro',
  /function\s+findBestServer[^]*?getServerAddress\s*\(\s*\)/.test(core),
  'fissarlo al caricamento della pagina significa ignorare un indirizzo cambiato ' +
  'nelle impostazioni finche non si ricarica tutto'
);
check(
  'window.connectionType (etichetta letta da nessuno) non e tornata',
  !/window\.connectionType/.test(core),
  'un\'etichetta \'tailscale\'/\'lan\' scritta e mai letta e la decorazione della finzione'
);

// ── B. OGNI GESTORE PARLA SOLO DEL SUO SOCKET ────────────────────────────────
check(
  'connectWebSocket cattura il proprio socket in una variabile',
  /var\s+sock\s*=\s*window\.ws\s*;/.test(ws),
  'senza un riferimento al SUO socket, un gestore non puo sapere se e ancora quello attuale'
);
check(
  'onclose e agganciato al socket catturato, non a window.ws',
  /\bsock\.onclose\s*=\s*function/.test(ws) && !/window\.ws\.onclose\s*=/.test(ws),
  'window.ws.onclose = ... aggancia il gestore giusto ma lo fa ragionare su ' +
  '«quello attuale», che al momento della chiusura puo essere un ALTRO socket'
);
check(
  'la chiusura voluta si segna SUL SOCKET, prima di chiuderlo',
  /_intentional\s*=\s*true[^]*?window\.ws\.close\(\)/.test(ws),
  'il cartellino deve viaggiare col socket: una bandiera globale non sa dire QUALE'
);
check(
  'onclose non decide piu in base alla bandiera globale intentionalClose',
  !/if\s*\(\s*window\.intentionalClose\s*\)/.test(ws),
  'l\'onopen del socket NUOVO azzera quella bandiera prima che l\'onclose del ' +
  'VECCHIO la legga: si proteggeva solo finche gli eventi arrivavano nell\'ordine sperato'
);

// L'ORDINE E LA CURA: le due domande PRIMA di smontare qualunque cosa.
const oncloseIdx = ws.indexOf('sock.onclose');
const oncloseSrc = oncloseIdx === -1 ? '' : ws.slice(oncloseIdx);
const idxIntentional = oncloseSrc.indexOf('sock._intentional');
const idxIdentita = oncloseSrc.indexOf('window.ws !== sock');
const idxTeardown = oncloseSrc.indexOf('window.wsConnected = false');
const idxBattito = oncloseSrc.indexOf('clearInterval(wsPingTimer)');
check(
  'onclese: le due guardie stanno PRIMA di spegnere lo stato collegato',
  idxIntentional !== -1 && idxIdentita !== -1 && idxTeardown !== -1 &&
  idxIntentional < idxTeardown && idxIdentita < idxTeardown,
  'azzerare wsConnected e poi chiedersi di chi era il socket significa aver gia ' +
  'marcato offline una connessione viva'
);
check(
  'onclose: le due guardie stanno PRIMA di spegnere il battito',
  idxBattito !== -1 && idxIntentional < idxBattito && idxIdentita < idxBattito,
  'wsPingTimer e UNO SOLO per tutta l\'app: spegnerlo dall\'onclose di un socket ' +
  'vecchio uccide il battito (e il guardiano dello zombie) del socket NUOVO'
);

// ESECUZIONE VERA del guardiano, ritagliato dal sorgente e non ricopiato qui.
let guardia = null;
try {
  const apre = wsRaw.indexOf('{', wsRaw.indexOf('sock.onclose'));
  const fino = wsRaw.indexOf('window.wsConnected = false', apre);
  const frammento = stripComments(wsRaw.slice(apre + 1, fino));
  guardia = new Function('sock', 'window', 'evt', frammento + "\nreturn 'PROCEDE';");
} catch (e) { guardia = null; }
check(
  'il guardiano di onclose si estrae ed esegue dal sorgente vero',
  typeof guardia === 'function',
  'se non si puo eseguire, questa sentinella sta solo leggendo delle parole'
);
if (typeof guardia === 'function') {
  const vivo = { nome: 'nuovo' };
  const vecchio = { nome: 'vecchio' };

  check(
    'socket ATTUALE e chiusura non voluta ⇒ si procede (riconnessione programmata)',
    guardia(vivo, { ws: vivo }, { code: 1006 }) === 'PROCEDE',
    'se anche il socket giusto venisse fermato, una caduta vera non riconnetterebbe piu'
  );

  // IL GUASTO DI il proprietario, riprodotto: il socket zombie si chiude in ritardo mentre
  // il nuovo e gia aperto e vivo.
  check(
    'socket VECCHIO che si chiude tardi ⇒ non tocca niente',
    guardia(vecchio, { ws: vivo }, { code: 1006 }) === undefined,
    'e la chiusura in ritardo dello zombie che spegneva il battito del socket ' +
    'nuovo e marcava offline una connessione viva: il sintomo quotidiano'
  );

  check(
    'socket chiuso da noi per sostituirlo ⇒ non programma una seconda riconnessione',
    guardia(Object.assign({}, vecchio, { _intentional: true }), { ws: vivo }, { code: 1000 }) === undefined
  );

  // Il caso che la bandiera globale sbagliava: chiudiamo il vecchio, il nuovo
  // NON riesce ad aprirsi. Il nuovo e ancora window.ws e non porta cartellino,
  // quindi DEVE procedere e riprogrammare. Con la vecchia bandiera globale
  // (rimasta true perche nessun onopen l'ha azzerata) qui si tornava indietro
  // in silenzio e l'app restava scollegata per sempre.
  const nuovoMaiAperto = { nome: 'nuovo-fallito' };
  check(
    'il socket nuovo che non riesce ad aprirsi riconnette comunque',
    guardia(nuovoMaiAperto, { ws: nuovoMaiAperto, intentionalClose: true }, { code: 1006 }) === 'PROCEDE',
    'la bandiera globale restava alzata e faceva saltare la riconnessione del ' +
    'socket che non si era mai aperto: app muta finche chi usa l\'app non tocca lo schermo'
  );

  // Nessun successore (chiusura senza sostituzione): si procede.
  check(
    'senza un socket successore la chiusura viene gestita normalmente',
    guardia(vecchio, { ws: null }, { code: 1006 }) === 'PROCEDE'
  );
}

// ── C. UN ERRORE NON E' «NESSUN DATO» ────────────────────────────────────────
const apiSrc = funcSource(core, 'api');
check('core.js: api() esiste', !!apiSrc);
check(
  'api() ha un tetto di tempo (AbortController)',
  !!apiSrc && /AbortController/.test(apiSrc) && /\.abort\(\)/.test(apiSrc),
  'senza tetto una fetch appesa NON si conclude mai, e loadSessions() restituisce ' +
  'quella stessa Promise a ogni chiamata successiva: elenco congelato per sempre'
);
check(
  'api() guarda res.ok',
  !!apiSrc && /res\.ok/.test(apiSrc),
  'senza questo, una pagina d\'errore HTML del relay e indistinguibile da «nessun dato»'
);

// Esecuzione vera di api() su una rete finta.
function costruisciApi() {
  const src = funcSource(coreRaw, 'api');
  if (!src) return null;
  const mTimeout = core.match(/var\s+API_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
  if (!mTimeout) return null;
  return {
    timeoutMs: Number(mTimeout[1]),
    fabbrica: new Function(
      'window', 'fetch', 'getServerUrl', 'localStorage', 'document',
      'setTimeout', 'clearTimeout', 'AbortController', 'API_TIMEOUT_MS',
      src + '\nreturn api;'
    )
  };
}
const estratta = costruisciApi();
check(
  'api() si estrae ed esegue dal sorgente vero',
  !!estratta,
  'API_TIMEOUT_MS dev\'essere una costante nominata, non un numero sparso'
);

if (estratta) {
  check(
    'il tetto di api() e largo abbastanza per gli endpoint che lanciano script',
    estratta.timeoutMs >= 60000,
    `trovato ${estratta.timeoutMs}ms: sotto questa soglia si tagliano aggiornamenti ` +
    'e pulizie, che rispondono dopo minuti di lavoro vero. Non e un timeout ' +
    'd\'esperienza d\'uso, e una rete contro una fetch che non finirebbe MAI'
  );

  function banco(risposta, opzioni) {
    const o = opzioni || {};
    const stato = { abortita: false, timers: [], puliti: [], fetchOpts: null };
    const AC = function () {
      this.signal = { aborted: false };
      this.abort = function () { stato.abortita = true; this.signal.aborted = true; };
    };
    const st = function (fn, ms) { stato.timers.push({ fn, ms }); return stato.timers.length; };
    const ct = function (id) { stato.puliti.push(id); };
    const fakeFetch = function (_url, opts) {
      stato.fetchOpts = opts;
      if (o.appesa) return new Promise(function () {});
      return Promise.resolve(risposta);
    };
    const api = estratta.fabbrica(
      { authToken: 'T' },
      fakeFetch,
      function () { return 'http://finto'; },
      { removeItem: function () {} },
      { getElementById: function () { return { classList: { remove: function () {}, add: function () {} } }; } },
      st, ct, AC, estratta.timeoutMs
    );
    return { api, stato };
  }
  const rispostaJson = (status, corpo) => ({
    status, ok: status >= 200 && status < 300,
    json: () => Promise.resolve(corpo)
  });
  const rispostaHtml = (status) => ({
    status, ok: status >= 200 && status < 300,
    json: () => Promise.reject(new SyntaxError('Unexpected token <'))
  });

  const esiti = [];
  const prove = (async function () {
    // 1. 502 con pagina HTML del relay: DEVE gridare, non tornare null.
    let b = banco(rispostaHtml(502));
    let esito;
    try { esito = { valore: await b.api('GET', '/sessions') }; }
    catch (e) { esito = { errore: e }; }
    esiti.push(['relay 502 con pagina HTML', esito]);

    // 2. 504 idem.
    b = banco(rispostaHtml(504));
    try { esito = { valore: await b.api('GET', '/sessions') }; }
    catch (e) { esito = { errore: e }; }
    esiti.push(['relay 504 con pagina HTML', esito]);

    // 3. IL ROVESCIO: 409 con corpo JSON. sessions.js ci legge il «gia in corso»
    //    di /ecosystem-restart e si aspetta il CORPO, non un'eccezione.
    b = banco(rispostaJson(409, { ok: false, error: 'gia in corso' }));
    try { esito = { valore: await b.api('POST', '/ecosystem-restart') }; }
    catch (e) { esito = { errore: e }; }
    esiti.push(['409 con corpo JSON', esito]);

    // 4. 200 normale.
    b = banco(rispostaJson(200, [{ id: 'a' }]));
    try { esito = { valore: await b.api('GET', '/sessions') }; }
    catch (e) { esito = { errore: e }; }
    esiti.push(['200 con corpo JSON', esito]);

    // 5. 204 senza corpo.
    b = banco(rispostaJson(204, null));
    try { esito = { valore: await b.api('DELETE', '/sessions/x') }; }
    catch (e) { esito = { errore: e }; }
    esiti.push(['204 senza corpo', esito]);

    // 6. 200 con corpo illeggibile: resta null, come sempre (non e un errore).
    b = banco(rispostaHtml(200));
    try { esito = { valore: await b.api('GET', '/qualcosa') }; }
    catch (e) { esito = { errore: e }; }
    esiti.push(['200 con corpo non-JSON', esito]);

    // 7. La fetch che non si conclude MAI: il cronometro dev'essere armato e,
    //    quando scatta, deve chiudere davvero.
    b = banco(null, { appesa: true });
    b.api('GET', '/sessions').catch(function () {});
    await Promise.resolve();
    esiti.push(['fetch appesa', { stato: b.stato }]);

    // 8. Il cronometro si ferma appena arrivano le INTESTAZIONI, non dopo il
    //    corpo: un elenco sessioni pesante su rete lenta non va mai troncato.
    let risolviCorpo;
    const corpoLento = {
      status: 200, ok: true,
      json: function () { return new Promise(function (r) { risolviCorpo = r; }); }
    };
    b = banco(corpoLento);
    const inVolo = b.api('GET', '/sessions');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    esiti.push(['corpo lento: cronometro gia spento', { stato: b.stato }]);
    if (risolviCorpo) risolviCorpo([{ id: 'z' }]);
    esiti.push(['corpo lento: valore', { valore: await inVolo }]);
  })();

  prove.then(function () {
    const trova = (n) => (esiti.find((e) => e[0] === n) || [])[1] || {};

    for (const n of ['relay 502 con pagina HTML', 'relay 504 con pagina HTML']) {
      const r = trova(n);
      check(
        `${n} ⇒ eccezione, non null`,
        !!r.errore && /HTTP \d+/.test(String(r.errore.message || '')),
        `visto: ${r.errore ? r.errore.message : JSON.stringify(r.valore)} — tornare ` +
        'null lascia credere a chi chiama che il server abbia risposto «niente»'
      );
    }
    const r409 = trova('409 con corpo JSON');
    check(
      '409 con corpo JSON ⇒ il corpo torna a chi chiama (contratto di sessions.js)',
      !r409.errore && r409.valore && r409.valore.error === 'gia in corso',
      'sessions.js legge il 409 «gia in corso» di /ecosystem-restart dal VALORE di ' +
      'ritorno: trasformare ogni non-ok in throw romperebbe quel ramo in silenzio'
    );
    const r200 = trova('200 con corpo JSON');
    check('200 con corpo JSON ⇒ il corpo', !r200.errore && Array.isArray(r200.valore) && r200.valore[0].id === 'a');
    const r204 = trova('204 senza corpo');
    check('204 ⇒ null', !r204.errore && r204.valore === null);
    const rNonJson = trova('200 con corpo non-JSON');
    check(
      '200 con corpo non-JSON ⇒ null (non e un errore, e un corpo vuoto)',
      !rNonJson.errore && rNonJson.valore === null
    );

    const appesa = trova('fetch appesa').stato || {};
    check(
      'una fetch che non si conclude mai arma il cronometro',
      (appesa.timers || []).length === 1 && appesa.timers[0].ms === estratta.timeoutMs,
      'visto: ' + JSON.stringify((appesa.timers || []).map((t) => t.ms))
    );
    if ((appesa.timers || []).length === 1) {
      appesa.timers[0].fn();
      check(
        'quando il cronometro scatta la richiesta viene davvero chiusa',
        appesa.abortita === true,
        'rigettare la Promise lasciando la fetch aperta tiene sveglia la radio del telefono'
      );
    }
    const lento = trova('corpo lento: cronometro gia spento').stato || {};
    check(
      'il cronometro si ferma alle INTESTAZIONI, non dopo il corpo',
      (lento.puliti || []).length === 1 && lento.abortita === false,
      'altrimenti un elenco sessioni pesante su rete mobile viene troncato a meta ' +
      'proprio quando sta arrivando'
    );
    const valoreLento = trova('corpo lento: valore');
    check(
      'un corpo lento arriva intero',
      valoreLento.valore && valoreLento.valore[0] && valoreLento.valore[0].id === 'z'
    );

    verificaProbe();
    verificaAvvio();
    referto();
  }).catch(function (e) {
    check('le prove eseguite di api() sono arrivate in fondo', false, String(e && e.stack || e));
    verificaProbe();
    verificaAvvio();
    referto();
  });
} else {
  verificaProbe();
  verificaAvvio();
  referto();
}

// ── D-bis. LA PROVA DI RAGGIUNGIBILITA' NON SI FIDA DELLA CACHE ──────────────
function verificaProbe() {
  const probeSrc = funcSource(coreRaw, 'probeServer');
  const mProbe = core.match(/var\s+PROBE_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
  check('core.js: probeServer esiste e PROBE_TIMEOUT_MS e nominata', !!probeSrc && !!mProbe);
  if (!probeSrc || !mProbe) return;

  let registro = null;
  try {
    const AC = function () {
      const self = this;
      this.signal = { aborted: false };
      this.abort = function () { self.signal.aborted = true; registro.abortita = true; };
    };
    registro = { opts: null, timers: [], abortita: false };
    const fakeFetch = function (_u, opts) { registro.opts = opts; return new Promise(function () {}); };
    const fabbrica = new Function(
      'fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'PROBE_TIMEOUT_MS',
      probeSrc + '\nreturn probeServer;'
    );
    const probeServer = fabbrica(
      fakeFetch,
      function (fn, ms) { registro.timers.push({ fn, ms }); return registro.timers.length; },
      function () {},
      AC,
      Number(mProbe[1])
    );
    probeServer('http://finto').catch(function () {});
  } catch (e) {
    registro = null;
  }

  check('probeServer si estrae ed esegue dal sorgente vero', !!registro && !!registro.opts);
  if (!registro || !registro.opts) return;
  check(
    'probeServer non si fida della cache (cache: no-store)',
    registro.opts.cache === 'no-store',
    'era l\'UNICA fetch della casa senza. Un 200 ripescato dalla cache del WebView ' +
    'fa sembrare VIVO un indirizzo morto: e il verdetto di questa funzione, dato alla rovescia'
  );
  check(
    'probeServer puo chiudere davvero la richiesta scaduta',
    !!registro.opts.signal,
    'senza signal, allo scadere del cronometro la fetch resta aperta a consumare ' +
    'radio: con un giro di riconnessione ogni pochi secondi si accumulano zombie'
  );
  if (registro.timers.length === 1) {
    registro.timers[0].fn();
    check(
      'il cronometro scaduto di probeServer chiude la richiesta',
      registro.abortita === true
    );
  } else {
    check('probeServer arma un solo cronometro', false, `trovati ${registro.timers.length}`);
  }
}

// ── D. IL CRONOMETRO DELL'AVVIO: DUE COSE DIVERSE, DUE TEMPI ─────────────────
function verificaAvvio() {
  const mHead = init.match(/var\s+BOOT_HEADERS_MS\s*=\s*(\d+)\s*;/);
  const mBody = init.match(/var\s+BOOT_BODY_MS\s*=\s*(\d+)\s*;/);
  check('init.js dichiara il tempo per le intestazioni', !!mHead);
  check('init.js dichiara il tempo per il corpo', !!mBody);
  const head = mHead ? Number(mHead[1]) : null;
  const body = mBody ? Number(mBody[1]) : null;

  const mProbe = core.match(/var\s+PROBE_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
  const probeMs = mProbe ? Number(mProbe[1]) : null;
  check(
    'il tempo per le intestazioni supera quello della prova di raggiungibilita',
    head !== null && probeMs !== null && head > probeMs,
    `intestazioni ${head}ms vs prova ${probeMs}ms — questa richiesta fa la STESSA ` +
    'strada della prova (radio da Doze, MagicDNS, TCP) e in piu si autentica: ' +
    'darle meno tempo significa tagliare proprio i risvegli lenti'
  );
  check(
    'il corpo ha piu tempo delle intestazioni',
    head !== null && body !== null && body > head,
    `intestazioni ${head}ms / corpo ${body}ms — sono due cose di peso diverso: lo ` +
    'stato (401 si/no) arriva con le intestazioni, il corpo porta la storia INTERA ' +
    'di ogni sessione (313 KB misurati il 27/08, senza tetto)'
  );
  check(
    'il corpo ha un tempo degno di una rete mobile lenta',
    body !== null && body >= 20000,
    `trovato ${body}ms: tagliare il corpo non fa risparmiare niente, butta i byte ` +
    'gia scaricati e costringe loadSessions() a riscaricare tutto da capo'
  );
  check(
    'l\'avvio non ha piu un unico abort a 6s su tutta la richiesta',
    !/setTimeout\(\s*function\s*\(\s*\)\s*\{\s*bootAbort\.abort\(\)\s*;?\s*\}\s*,\s*6000\s*\)/.test(init),
    'era il tempo che uccideva lo scaricamento dell\'elenco su rete mobile'
  );
  const armati = (init.match(/bootAbort\.abort\(\)/g) || []).length;
  check(
    'i cronometri dell\'avvio sono due, non uno e non tre',
    armati === 2,
    `trovati ${armati}: uno sorveglia «c\'e qualcuno?», l\'altro «scarica con calma»`
  );
  check(
    'la richiesta d\'avvio non si fida della cache',
    /\/api\/sessions'[^]*?cache:\s*'no-store'/.test(init),
    'un elenco sessioni ripescato dalla cache al risveglio mostra al proprietario uno stato vecchio'
  );
}

// ── Referto ──────────────────────────────────────────────────────────────────
function referto() {
  console.log('');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (failures.length) {
    console.error(`\n✗ sentinella riconnessione-telefono FALLITA (${failures.length}):`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`\n✓ sentinella riconnessione-telefono passata (${checks.length} controlli)`);
}
