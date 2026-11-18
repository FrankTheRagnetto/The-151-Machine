#!/usr/bin/env node
'use strict';
// [12/11/2026 ] «Messaggi del proprietario persi in silenzio.» Trovato in lettura:
//   1. core.js redeliverPending: a window.streaming vero cancellava TUTTO l'outbox
//      («il server l'ha ricevuto» — falso se il server faceva un altro turno);
//      rimandava solo il primo e cancellava gli altri; oltre 1 h buttava senza traccia.
//   2. ws.js: 'ack', stato 'busy', turno in corso, 'done' cancellavano l'outbox
//      dell'intera sessione: l'ack di A cancellava anche B mai arrivato.
//   3. ws-handler.js: il nonce entrava fra i «visti» PRIMA del limite di 10/min:
//      un messaggio rifiutato dal limite, rimandato, era scartato come doppione.
// LE LEGGI:
//   A. Due messaggi nell'outbox, ack del primo → il secondo resta e viene rimandato.
//   B. Server occupato → l'outbox non si svuota; si rimanda tutto, ognuno col suo nonce.
//   C. Limite superato → il rifiuto è nel log e porta il nonce; il rinvio dello
//      stesso nonce passa (non è un doppione). L'ack porta il nonce (anche i doppioni).
//   D. Oltre 1 h: non rimandati, contati con PENDING-STALE prima di toglierli.
//   E. Un doppione a server fermo non lascia la chat appesa in «busy».
// Prova pura: core.js e ws.js veri eseguiti in un contesto finto (vm), ws-handler
// vero su un socket finto. Nessun server, nessuna rete.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let ok = 0, failed = 0;
const check = (c, l) => { if (c) { ok++; console.log('  ok   ' + l); } else { failed++; console.log('  FAIL ' + l); } };
const leggi = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Blocco bilanciato a graffe che parte dalla prima «{» dopo `marker`.
function blocco(src, marker, from) {
  const at = src.indexOf(marker, from || 0);
  if (at < 0) return null;
  const open = src.indexOf('{', at + marker.length - 1);
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(at, j + 1); }
  }
  return null;
}
const funzione = (src, nome) => blocco(src, 'function ' + nome + '(');

const core = leggi('public/js/core.js');
const wsSrc = leggi('public/js/ws.js');

// ── Contesto finto del telefono ─────────────────────────────────────────────
function telefono() {
  const store = {};
  const inviati = [];
  const beacon = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Math, setTimeout: () => 0, clearTimeout() {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    WebSocket: { OPEN: 1 },
    streaming: false, streamingText: '', thinkingText: '', streamingEl: null,
    activeSessionId: 'sessione-1',
    ws: { readyState: 1, send: (x) => inviati.push(JSON.parse(x)) },
    syncBeacon: (tag, data) => beacon.push({ tag, data }),
    markNonceRendered() { return true; },
    updateStatusDot() {}, hideActivity() {}, showThinkingState() {},
    clearLiveStreamState() {}, markLastUserStatus() {}, _resolveSyncWaiters() {},
    showToast() {}, humanizeError: (m) => m, appendMessage() {}, finalizeStreamingMessage() {},
  };
  ctx.window = ctx;
  ctx.setStreamingState = (b) => { ctx.streaming = b; if (!b) { ctx.streamingText = ''; ctx.thinkingText = ''; } };
  ctx.updateStatusDot = () => {};
  vm.createContext(ctx);
  const nomi = ['generateNonce', 'getPendingMessages', 'savePendingMessage', 'clearPendingMessages',
    'getPendingForSession', '_writePending', 'removePendingByNonce', 'forgetPendingInHistory',
    'ackPending', 'redeliverPending'];
  let codice = '';
  for (const n of nomi) { const f = funzione(core, n); if (f) codice += f + '\n'; }
  for (const n of nomi) codice += `if (typeof ${n} === 'function') window.${n} = ${n};\n`;
  vm.runInContext(codice, ctx);
  // I rami veri di ws.js, eseguiti come gestore di un messaggio.
  const rami = ['ack', 'sync', 'error'].map((t) => blocco(wsSrc, `if (msg.type === '${t}') {`)).join('\n');
  vm.runInContext('var knownServerBoot = null, knownBuildHash = null, inRestartMode = false, _recentRestart = false;\n'
    + 'window.__arriva = function (msg) {\n' + rami + '\n};', ctx);
  const outbox = () => JSON.parse(store['claude-pending-messages'] || '[]');
  return { ctx, inviati, beacon, outbox, arriva: (m) => ctx.__arriva(m) };
}

// ── A. ack del primo: il secondo resta e viene rimandato ──────────────────────
{
  const t = telefono();
  t.ctx.savePendingMessage('sessione-1', 'primo', [], 'nonce-A');
  t.ctx.savePendingMessage('sessione-1', 'secondo', [], 'nonce-B');
  t.arriva({ type: 'ack', nonce: 'nonce-A' });
  const resto = t.outbox();
  check(resto.length === 1 && resto[0].nonce === 'nonce-B', 'A ack di A: nell\'outbox resta B (' + resto.map((m) => m.nonce).join(',') + ')');
  t.arriva({ type: 'sync', status: 'idle' });
  check(t.inviati.some((m) => m.type === 'message' && m.nonce === 'nonce-B' && m.content === 'secondo'), 'A al riaggancio B viene rimandato col suo nonce');
}
// ── A2. due messaggi persi: si rimandano TUTTI, in ordine ────────────────────
{
  const t = telefono();
  t.ctx.savePendingMessage('sessione-1', 'uno', [], 'n-1');
  t.ctx.savePendingMessage('sessione-1', 'due', [], 'n-2');
  t.ctx.savePendingMessage('sessione-1', 'tre', [], 'n-3');
  t.arriva({ type: 'sync', status: 'idle' });
  const n = t.inviati.filter((m) => m.type === 'message').map((m) => m.nonce).join(',');
  check(n === 'n-1,n-2,n-3', 'A2 rimandati tutti, in ordine, ognuno col suo nonce (' + n + ')');
  check(t.outbox().length === 3, 'A2 restano nell\'outbox finché non arriva il loro ack');
}
// ── B. server occupato: l'outbox non si svuota ───────────────────────────────
{
  const t = telefono();
  t.ctx.savePendingMessage('sessione-1', 'durante un altro turno', [], 'n-busy');
  t.arriva({ type: 'sync', status: 'busy' });
  check(t.outbox().length === 1, 'B stato «busy»: l\'outbox NON si svuota');
  check(t.inviati.some((m) => m.type === 'message' && m.nonce === 'n-busy'), 'B e il messaggio si rimanda anche a server occupato');
  const t2 = telefono();
  t2.ctx.streaming = true; t2.ctx.streamingText = 'il turno di prima…';
  t2.ctx.savePendingMessage('sessione-1', 'x', [], 'n-x');
  t2.ctx.redeliverPending('sessione-1');
  check(t2.outbox().length === 1 && t2.inviati.some((m) => m.nonce === 'n-x'), 'B redeliverPending con un turno in corso: rimanda e tiene');
  check(t2.ctx.streamingText === 'il turno di prima…', 'B e non tocca il testo del turno che sta scorrendo');
}
// ── D. oltre 1 h: contati, non rimandati ─────────────────────────────────────
{
  const t = telefono();
  t.ctx.localStorage.setItem('claude-pending-messages', JSON.stringify([
    { sessionId: 'sessione-1', content: 'vecchio', attachments: [], ts: Date.now() - 2 * 3600000, nonce: 'n-old' },
    { sessionId: 'sessione-1', content: 'fresco', attachments: [], ts: Date.now(), nonce: 'n-new' },
  ]));
  t.ctx.redeliverPending('sessione-1');
  const b = t.beacon.find((x) => x.tag === 'PENDING-STALE');
  check(!!b && b.data.nonce === 'n-old' && b.data.sid === 'sessione-1' && b.data.ageMs >= 2 * 3600000 - 1000, 'D il vecchio è contato (PENDING-STALE con sid, nonce, ageMs)');
  check(!t.inviati.some((m) => m.nonce === 'n-old') && t.inviati.some((m) => m.nonce === 'n-new'), 'D il vecchio non si rimanda, il fresco sì');
  check(t.outbox().map((m) => m.nonce).join() === 'n-new', 'D il vecchio esce dall\'outbox, il fresco resta');
}
// ── E. doppione a server fermo: la chat torna idle ───────────────────────────
{
  const t = telefono();
  t.ctx.savePendingMessage('sessione-1', 'già arrivato', [], 'n-dup');
  t.arriva({ type: 'sync', status: 'idle' });
  check(t.ctx.streaming === true, 'E il rinvio accende «busy»');
  t.arriva({ type: 'ack', nonce: 'n-dup', duplicate: true, busy: false });
  check(t.ctx.streaming === false && t.outbox().length === 0, 'E doppione a server fermo: outbox vuoto e chat non più appesa');
}
// ── Storia del server: conferma per nonce ────────────────────────────────────
{
  const t = telefono();
  t.ctx.savePendingMessage('sessione-1', 'a', [], 'h-1');
  t.ctx.savePendingMessage('sessione-1', 'b', [], 'h-2');
  if (typeof t.ctx.forgetPendingInHistory === 'function') t.ctx.forgetPendingInHistory([{ role: 'user', content: 'a', nonce: 'h-1' }]);
  check(t.outbox().map((m) => m.nonce).join() === 'h-2', 'la storia del server col nonce toglie solo QUEL messaggio');
}
// ── Nessuna cancellazione «per indovinare» rimasta in ws.js ──────────────────
{
  const senzaCommenti = wsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const n = (senzaCommenti.match(/clearPendingMessages\(/g) || []).length;
  check(n === 0, 'ws.js non svuota più l\'outbox dell\'intera sessione (' + n + ' chiamate)');
}

// ── C. server: limite, nonce, ack ────────────────────────────────────────────
{
  const setupWsHandler = require('../server/ws-handler.js');
  const consegnati = [];
  let occupato = false;
  let rottoGia = false;
  const deps = {
    manager: {
      isSessionBusy: () => occupato, get: () => null, getStreamState: () => null,
      consumeDeployMarker: () => null, sessions: new Map(), markRead: () => {},
      sendMessage: (sid, content, att, opts) => {
        if (opts && opts.nonce === 'rotto-12345678' && !rottoGia) { rottoGia = true; throw new Error('CLI non partito'); }
        consegnati.push(opts && opts.nonce); return { process: new EventEmitter() };
      },
    },
    isTokenValid: () => true, sendToSession: () => {}, broadcastSessionStatus: () => {},
    addSessionSocket: () => {}, removeSessionSocket: () => {}, spawnStreamHandler: () => {},
    generateAutoTitleStage1: async () => {}, generateAutoTitleStage2: async () => {},
    sessionMessageQueue: new Map(), sessionLastJoin: new Map(), globalProcessedNonces: new Set(),
    globalReplayedSet: new Set(), serverState: { BUILD_HASH: 'b', CODE_HASH: 'c', DEPLOY_HASH: 'd' }, SERVER_BOOT: 1,
  };
  const wss = new EventEmitter(); wss.clients = new Set();
  setupWsHandler(wss, deps);
  const ws = new EventEmitter(); const sent = [];
  ws.send = (x) => sent.push(JSON.parse(x)); ws.close = () => {}; ws.ping = () => {}; ws.terminate = () => {};
  wss.emit('connection', ws, { url: '/ws?token=x', headers: { host: 'localhost' } });
  const manda = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  const log = [];
  const ow = console.warn, ol = console.log, oe = console.error;
  console.warn = (...a) => log.push(a.join(' ')); console.log = (...a) => log.push(a.join(' ')); console.error = () => {};
  const realNow = Date.now;
  try {
    manda({ type: 'join', sessionId: 'abcdef0123456789' });
    for (let i = 0; i < 10; i++) manda({ type: 'message', content: 'm' + i, nonce: 'nonce-' + i + '-xxxxxxxx' });
    const ack0 = sent.find((m) => m.type === 'ack');
    sent.length = 0;
    manda({ type: 'message', content: 'l\'undicesimo', nonce: 'oltre-limite-1234' });
    const err = sent.find((m) => m.type === 'error');
    const riga = log.find((l) => /rate limit/i.test(l) && l.includes('abcdef01') && l.includes('oltre-li'));
    sent.length = 0;
    Date.now = () => realNow() + 61000; // passato il minuto, il telefono rimanda lo stesso nonce
    manda({ type: 'message', content: 'l\'undicesimo', nonce: 'oltre-limite-1234' });
    const ack11 = sent.find((m) => m.type === 'ack');
    const rinvioPassato = consegnati.includes('oltre-limite-1234');
    sent.length = 0;
    occupato = false;
    manda({ type: 'message', content: 'm0', nonce: 'nonce-0-xxxxxxxx' });
    const dup = sent.find((m) => m.type === 'ack');
    // [12/11] consegna fallita (sendMessage lancia): il nonce non resta fra i «visti», il rinvio parte
    Date.now = () => realNow() + 122000;
    sent.length = 0;
    manda({ type: 'message', content: 'rotto', nonce: 'rotto-12345678' });
    const errRotto = sent.find((m) => m.type === 'error');
    sent.length = 0;
    manda({ type: 'message', content: 'rotto', nonce: 'rotto-12345678' });
    const ackRotto = sent.find((m) => m.type === 'ack');
    console.warn = ow; console.log = ol; console.error = oe;
    check(!!ack0 && ack0.nonce === 'nonce-0-xxxxxxxx', 'C l\'ack porta il nonce del messaggio');
    check(!!err && err.nonce === 'oltre-limite-1234', 'C il rifiuto per limite porta il nonce');
    check(!!riga, 'C il rifiuto per limite è nel log (sessione e nonce brevi)');
    check(rinvioPassato && !!ack11 && !ack11.duplicate, 'C il rinvio dello stesso nonce dopo il limite PASSA (non scartato come doppione)');
    check(!!dup && dup.nonce === 'nonce-0-xxxxxxxx' && dup.duplicate === true && dup.busy === false, 'C il doppione riceve l\'ack col suo nonce, duplicate e busy');
    check(consegnati.filter((n) => n === 'nonce-0-xxxxxxxx').length === 1, 'C il doppione non riparte');
    check(!!errRotto && !!ackRotto && !ackRotto.duplicate && consegnati.includes('rotto-12345678'), 'C consegna fallita: il rinvio dello stesso nonce PARTE (non scartato come doppione)');
  } finally {
    Date.now = realNow;
    console.warn = ow; console.log = ol; console.error = oe;
    ws.emit('close');
  }
}

console.log(`\noutbox-per-nonce: ${ok} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
