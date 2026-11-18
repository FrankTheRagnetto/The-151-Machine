#!/usr/bin/env node
'use strict';
// [10/11/2026 ] Dettatura, «Invia mentre registri»: Invia durante
// la presa = l'audio si trascrive e parte da solo nella sessione dove la presa
// è cominciata, anche se il proprietario esce o chiude l'app; il microfono resta com'era.
// Il caso da non perdere: app chiusa prima che il testo arrivi → il messaggio
// arriva lo stesso, UNA volta, nella sessione giusta.
// Prova pura: dictation.js vero in una sandbox vm (telefono finto, IndexedDB
// finto), server/dettatura-invio.js e il ws-handler vero con dipendenze finte.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DICT = fs.readFileSync(path.join(ROOT, 'public/js/dictation.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const blocco = (n, fn) => Promise.resolve().then(fn).catch((e) => { fail++; console.log('  FAIL ' + n + ' — lancia: ' + (e && e.stack || e)); });
const pausa = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ---------- IndexedDB finto (sopravvive alla «pagina», come quello vero) ----------
function nuovoIdb() {
  const dati = new Map();
  return {
    dati,
    open() {
      const r = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setImmediate(() => {
        r.result = {
          createObjectStore() {},
          close() {},
          transaction() {
            const tx = { oncomplete: null, onerror: null, onabort: null };
            const st = {
              put(v) { dati.set(v.clipId, Object.assign({}, v)); return { result: v.clipId }; },
              delete(k) { dati.delete(k); return { result: undefined }; },
              getAll() { return { result: [...dati.values()].map((v) => Object.assign({}, v)) }; },
            };
            tx.objectStore = () => st;
            setImmediate(() => tx.oncomplete && tx.oncomplete());
            return tx;
          },
        };
        if (r.onupgradeneeded) r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      });
      return r;
    },
  };
}

function el(id) {
  const cls = new Set();
  return { id, style: {}, value: '', title: '', selectionStart: 0, onclick: null,
    contains(x) { return x === this; },
    classList: { add: (...a) => a.forEach((x) => cls.add(x)), remove: (...a) => a.forEach((x) => cls.delete(x)),
      toggle() {}, contains: (x) => cls.has(x) } };
}

class FormDataFinto { constructor() { this.campi = {}; } append(k, v) { this.campi[k] = v; } }

// Una pagina della Machine col dictation.js vero. `rispondi(url, opts)` → { status, json }.
function apri({ idb, sessione = 'S1', token = 'T', rispondi }) {
  const fatto = { fetch: [], inputJsInvia: 0, toast: [] };
  const els = { 'mic-btn': el('mic'), 'message-input': el('input'), 'send-btn-new': el('send'), 'input-row': el('row') };
  els['send-btn-new'].onclick = () => { fatto.inputJsInvia++; };   // il gestore di input.js
  const timers = [];
  const ascoltatori = [];
  const win = {
    activeSessionId: sessione, authToken: token,
    showToast: (m) => fatto.toast.push(m),
    Battito: { ogni() {} },
    AndroidMic: { start() {}, stop() {} },
    indexedDB: idb,
    Capacitor: { isNativePlatform: () => true, Plugins: { VoiceRecorder: {
      getCurrentStatus: () => Promise.resolve({ status: 'NONE' }),
      requestAudioRecordingPermission: () => Promise.resolve({ value: true }),
      startRecording: () => Promise.resolve({ value: true }),
      stopRecording: () => Promise.resolve({ value: { recordDataBase64: 'AAAA', mimeType: 'audio/aac', msDuration: 4000 } }),
    } } },
  };
  win.fetch = (url, opts) => {
    fatto.fetch.push({ url, opts: opts || {} });
    const r = rispondi(url, opts || {}) || { status: 404, json: {} };
    if (r.rete) return Promise.reject(new Error('rete giù'));
    return Promise.resolve({ status: r.status, ok: r.status >= 200 && r.status < 300,
      json: () => Promise.resolve(r.json || {}), text: () => Promise.resolve(JSON.stringify(r.json || {})) });
  };
  const documento = {
    visibilityState: 'visible',
    getElementById: (id) => els[id] || null,
    body: { appendChild() {}, removeChild() {} }, createElement: () => el('a'),
    addEventListener: (tipo, fn, cattura) => ascoltatori.push({ tipo, fn, cattura }),
  };
  const ctx = {
    window: win, document: documento,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    Promise, JSON, Date, Math, Uint8Array, ArrayBuffer, Blob, FormData: FormDataFinto,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    fetch: (u, o) => win.fetch(u, o), indexedDB: idb,
  };
  win.window = win;
  Object.assign(ctx, { showToast: win.showToast, getServerUrl: undefined });
  vm.createContext(ctx);
  vm.runInContext(DICT, ctx);
  // Un tocco vero: prima la cattura sul documento, poi il gestore del tasto.
  function tocca(bersaglio) {
    let fermato = false;
    const ev = { type: 'click', target: bersaglio, preventDefault() {}, stopPropagation() { fermato = true; }, stopImmediatePropagation() { fermato = true; } };
    for (const a of ascoltatori) if (a.tipo === 'click' && a.cattura) a.fn(ev);
    if (!fermato && bersaglio.onclick) bersaglio.onclick(ev);
  }
  // Fa scattare i timer in coda (una passata).
  function scorri() { const t = timers.splice(0); t.forEach((x) => x.f()); }
  return { fatto, win, els, tocca, scorri, timers };
}

const post = (f) => f.fetch.filter((x) => x.opts.method === 'POST');
const parametro = (url, k) => new URL('http://x' + url).searchParams.get(k);

(async () => {
  // ---- A: registra in S1, va in S2, preme Invia → parte per S1, da solo ----
  await blocco('A', async () => {
    const idb = nuovoIdb();
    const p = apri({ idb, rispondi: (url, o) => (o.method === 'POST' ? { status: 202, json: { accepted: true } } : { status: 404 }) });
    await pausa();
    p.tocca(p.els['mic-btn']);
    await pausa();
    ok(p.win.Dictation.state() === 'recording', 'A. il microfono registra');
    p.win.activeSessionId = 'S2';                 // il proprietario passa a un'altra sessione
    p.tocca(p.els['send-btn-new']);
    await pausa(12);
    const P = post(p.fatto);
    ok(P.length === 1, 'A. un solo caricamento dell\'audio');
    ok(P[0] && parametro(P[0].url, 'sendTo') === 'S1', 'A. va alla sessione dove la presa è cominciata (S1), non a quella aperta (S2)');
    ok(P[0] && /^c[0-9a-z]{6,}$/.test(parametro(P[0].url, 'clipId') || ''), 'A. con un id della clip (contro i doppioni)');
    ok(p.fatto.inputJsInvia === 0, 'A. il normale «invia» di input.js NON parte');
    ok(p.win.Dictation.state() === 'idle', 'A. il microfono torna libero subito');
    ok(idb.dati.size === 1, 'A. la clip resta salvata sul telefono finché il server non dice «fatta»');
    // il server finisce: il ritiro vede «done» e la copia si cancella
    p.win.fetch = ((orig) => (url, o) => (/\/result\//.test(url)
      ? Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ status: 'done', text: 'ciao', sent: true }) })
      : orig(url, o)))(p.win.fetch);
    p.scorri(); await pausa(12);
    ok(idb.dati.size === 0, 'A. testo consegnato → copia sul telefono cancellata');
  });

  // ---- B: il microfono resta com'era ----
  await blocco('B', async () => {
    const p = apri({ idb: nuovoIdb(), rispondi: (url, o) => (o.method === 'POST' ? { status: 200, json: { text: 'detto' } } : { status: 404 }) });
    await pausa();
    p.tocca(p.els['mic-btn']); await pausa();
    p.win.activeSessionId = 'S2';
    p.tocca(p.els['mic-btn']); await pausa(12);
    const P = post(p.fatto);
    ok(P.length === 1 && parametro(P[0].url, 'sendTo') === null, 'B. tocco sul microfono: nessun invio automatico');
    ok(p.els['message-input'].value === 'detto', 'B. il testo va nel campo della sessione aperta, come prima');
  });

  // ---- C: il testo già scritto nella stessa sessione parte insieme ----
  await blocco('C', async () => {
    const p = apri({ idb: nuovoIdb(), rispondi: (u, o) => (o.method === 'POST' ? { status: 202, json: {} } : { status: 404 }) });
    await pausa();
    p.els['message-input'].value = 'Nota:';
    p.tocca(p.els['mic-btn']); await pausa();
    p.tocca(p.els['send-btn-new']); await pausa(12);
    const P = post(p.fatto);
    ok(P[0] && P[0].opts.body.campi.prefix === 'Nota:', 'C. il testo nel campo viaggia col vocale');
    ok(p.els['message-input'].value === '', 'C. e il campo si svuota (niente doppio invio a mano)');
  });

  // ---- D: Invia senza registrazione = l'invio di sempre ----
  await blocco('D', async () => {
    const p = apri({ idb: nuovoIdb(), rispondi: () => ({ status: 404 }) });
    await pausa();
    p.tocca(p.els['send-btn-new']);
    ok(p.fatto.inputJsInvia === 1 && post(p.fatto).length === 0, 'D. non registra → Invia manda il campo come sempre');
  });

  // ---- E: app chiusa prima che il server accetti → alla riapertura riparte, stesso id ----
  await blocco('E', async () => {
    const idb = nuovoIdb();
    const p1 = apri({ idb, rispondi: () => ({ rete: true }) });   // PC irraggiungibile
    await pausa();
    p1.tocca(p1.els['mic-btn']); await pausa();
    p1.tocca(p1.els['send-btn-new']); await pausa(12);
    const id1 = parametro(post(p1.fatto)[0].url, 'clipId');
    ok(idb.dati.size === 1, 'E. caricamento fallito: la clip è salvata sul telefono');
    // l'app muore; si riapre in un'altra sessione
    const p2 = apri({ idb, sessione: 'S9', rispondi: (u, o) => (o.method === 'POST' ? { status: 202, json: {} } : { status: 404 }) });
    await pausa(12);
    const P = post(p2.fatto);
    ok(P.length === 1, 'E. alla riapertura la clip riparte da sola');
    ok(P[0] && parametro(P[0].url, 'clipId') === id1 && parametro(P[0].url, 'sendTo') === 'S1',
      'E. stesso id, stessa sessione (S1), anche se l\'app si riapre in S9');
    // terza apertura: il server l'aveva già fatta → niente nuovo caricamento
    const p3 = apri({ idb, rispondi: (u) => (/\/result\//.test(u) ? { status: 200, json: { status: 'done', text: 'x', sent: true } } : { status: 202 }) });
    await pausa(12);
    ok(post(p3.fatto).length === 0 && idb.dati.size === 0, 'E. già consegnata → nessun nuovo caricamento, copia cancellata');
  });

  // ---- F: il server — accetta, trascrive, manda una volta ----
  const { createInvioDettatura, nonceDi } = require(path.join(ROOT, 'server/dettatura-invio.js'));
  function server() {
    const s = { trascritte: 0, consegne: [], risultati: new Map(), visti: new Set(), tolti: [], tenuti: [], begin: 0, end: 0, whisper: null };
    s.mod = createInvioDettatura({
      trascrivi: () => { s.trascritte++; return new Promise((r) => { s.whisper = r; }); },
      leggiRisultato: (id) => s.risultati.get(id) || null,
      scriviRisultato: (id, text, extra) => { s.risultati.set(id, Object.assign({}, extra, { text })); return true; },
      consegna: (sid, testo, nonce) => {
        if (s.visti.has(sid + ':' + nonce)) return 'doppione';
        s.visti.add(sid + ':' + nonce); s.consegne.push({ sid, testo, nonce }); return 'mandato';
      },
      conservaClip: (f) => { s.tenuti.push(f); return '/salvata'; },
      rimuovi: (f) => s.tolti.push(f),
      prontezza: { beginTranscribe: () => s.begin++, endTranscribe: () => s.end++ },
      log: () => {},
    });
    return s;
  }
  await blocco('F', async () => {
    const s = server();
    const r1 = s.mod.accetta({ clipId: 'cabc123', sessionId: 'S1', prefisso: 'Nota:', file: '/t/1' });
    ok(r1.stato === 'accettata', 'F. prima volta: accettata (il telefono può andarsene)');
    const r2 = s.mod.accetta({ clipId: 'cabc123', sessionId: 'S1', prefisso: 'Nota:', file: '/t/2' });
    ok(r2.stato === 'in-volo' && s.trascritte === 1, 'F. ricarica mentre whisper lavora: nessuna seconda trascrizione');
    ok(s.tolti.includes('/t/2'), 'F. il doppione caricato si butta');
    s.whisper({ ok: true, text: 'compra il latte' });
    await r1.fine;
    ok(s.consegne.length === 1 && s.consegne[0].sid === 'S1', 'F. un messaggio, nella sessione S1');
    ok(s.consegne[0].testo === 'Nota: compra il latte', 'F. testo del campo + dettato');
    ok(s.consegne[0].nonce === nonceDi('cabc123'), 'F. col nonce della clip');
    ok(s.risultati.get('cabc123').esito === 'mandato', 'F. il risultato dice «mandato» (il telefono cancella la copia)');
    const r3 = s.mod.accetta({ clipId: 'cabc123', sessionId: 'S1', prefisso: 'Nota:', file: '/t/3' });
    ok(r3.stato === 'fatta' && s.consegne.length === 1 && s.trascritte === 1, 'F. ricarica dopo la fine: niente whisper, niente secondo messaggio');
    ok(s.begin === 1 && s.end === 1, 'F. un riavvio aspettava la trascrizione, poi è libero');
  });

  await blocco('G', async () => {
    const s = server();
    const r = s.mod.accetta({ clipId: 'cfail99', sessionId: 'S1', prefisso: '', file: '/t/f' });
    s.whisper({ ok: false, error: 'boom' });
    await r.fine;
    ok(s.consegne.length === 0 && !s.risultati.has('cfail99'), 'G. whisper fallito: nessun messaggio, nessun «fatta» (il telefono riprova)');
    ok(s.tenuti.includes('/t/f') && s.end === 1, 'G. l\'audio resta sul PC');
  });

  // ---- H: il ws-handler vero — consegna dal server, una volta per nonce ----
  await blocco('H', async () => {
    const setup = require(path.join(ROOT, 'server/ws-handler.js'));
    const mandati = [], eco = [];
    const manager = {
      sessions: new Map([['S1', { history: [], manuallyRenamed: true }]]),
      isSessionBusy: () => false,
      sendMessage: (sid, c, a, o) => { mandati.push({ sid, c, nonce: o && o.nonce }); return { process: {} }; },
    };
    const h = setup({ on() {} }, {
      manager, isTokenValid: () => true,
      sendToSession: (sid, data, opz) => eco.push({ sid, data, opz }),
      broadcastSessionStatus() {}, addSessionSocket() {}, removeSessionSocket() {},
      spawnStreamHandler() {}, generateAutoTitleStage1: async () => {}, generateAutoTitleStage2: async () => {},
      sessionMessageQueue: new Map(), sessionLastJoin: new Map(), globalProcessedNonces: new Set(), globalReplayedSet: new Set(),
      serverState: {}, SERVER_BOOT: Date.now(),
    });
    ok(h && typeof h.consegnaDalServer === 'function', 'H. il gestore dei socket offre la consegna dal server');
    ok(h.consegnaDalServer('S1', 'ciao', 'dict-c1') === 'mandato', 'H. prima consegna: mandato');
    ok(h.consegnaDalServer('S1', 'ciao', 'dict-c1') === 'doppione', 'H. stesso nonce: fermato');
    ok(mandati.length === 1 && mandati[0].nonce === 'dict-c1', 'H. Claude riceve UN messaggio, col nonce scritto nella storia');
    ok(eco.some((e) => e.data.type === 'user_message' && e.sid === 'S1' && !(e.opz && e.opz.exclude)),
      'H. la bolla arriva a ogni telefono aperto su S1');
    ok(h.consegnaDalServer('S7', 'x', 'dict-c2') === 'sessione-sparita' && mandati.length === 1, 'H. sessione sparita: nessun messaggio');
  });

  console.log(`\n${pass} ok, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
