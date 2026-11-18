#!/usr/bin/env node
'use strict';

// [12/10/2026] Un frame WebSocket storto non deve mai far cadere il processo.
// server/logs/crash.log: 11 volte «Cannot read properties of null (reading
// 'slice')» — un `join` senza sessionId stringa, o un frame JSON `null`,
// arrivavano dritti in handleJoin / nel dispatcher e lanciavano dentro il
// listener 'message' del socket → uncaughtException → riavvio.
//
// Prova pura: nessun server. Si accende setupWsHandler su un wss finto, si
// apre una connessione finta e le si mandano i frame cattivi. Sul codice di
// prima `ws.emit('message', ...)` lancia; adesso non deve lanciare, e un join
// buono deve ancora funzionare.

const { EventEmitter } = require('events');
const path = require('path');

const setupWsHandler = require(path.join(__dirname, '..', 'server', 'ws-handler.js'));

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}

const joined = [];
const deps = {
  manager: {
    isSessionBusy: () => false,
    get: () => null,
    getStreamState: () => null,
    consumeDeployMarker: () => null,
    sessions: new Map(),
    markRead: () => {},
  },
  isTokenValid: () => true,
  sendToSession: () => {},
  broadcastSessionStatus: () => {},
  addSessionSocket: (sid) => joined.push(sid),
  removeSessionSocket: () => {},
  spawnStreamHandler: () => {},
  generateAutoTitleStage1: async () => {},
  generateAutoTitleStage2: async () => {},
  sessionMessageQueue: new Map(),
  sessionLastJoin: new Map(),
  globalProcessedNonces: new Set(),
  globalReplayedSet: new Set(),
  serverState: { BUILD_HASH: 'b', CODE_HASH: 'c', DEPLOY_HASH: 'd' },
  SERVER_BOOT: 1,
};

const wss = new EventEmitter();
wss.clients = new Set();
setupWsHandler(wss, deps);

const ws = new EventEmitter();
const sent = [];
ws.send = (s) => sent.push(JSON.parse(s));
ws.close = () => {};
ws.ping = () => {};
ws.terminate = () => {};
wss.emit('connection', ws, { url: '/ws?token=x', headers: { host: 'localhost' } });

// Il listener tace i console.error attesi, per non sporcare l'uscita.
const origErr = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};

const send = (raw) => ws.emit('message', Buffer.from(raw), false);

try {
  check('frame JSON null non lancia', () => send('null'));
  check('frame JSON numero non lancia', () => send('42'));
  check('frame JSON array non lancia', () => send('[1,2]'));
  check('join senza sessionId non lancia', () => send(JSON.stringify({ type: 'join' })));
  check('join con sessionId null non lancia', () => send(JSON.stringify({ type: 'join', sessionId: null })));
  check('join con sessionId numero non lancia', () => send(JSON.stringify({ type: 'join', sessionId: 12345 })));
  check('join con sessionId vuoto non lancia', () => send(JSON.stringify({ type: 'join', sessionId: '' })));
  check('nessun join cattivo è stato registrato', () => {
    if (joined.length) throw new Error('registrati: ' + JSON.stringify(joined));
  });
  check('un gestore che lancia non fa cadere il processo', () => {
    // markRead esplode → il gestore ha già il suo try; forziamo un errore vero
    // facendo esplodere wss.clients.forEach.
    const old = wss.clients;
    wss.clients = { forEach() { throw new Error('boom'); } };
    try { send(JSON.stringify({ type: 'session_read', sessionId: 'abc' })); }
    finally { wss.clients = old; }
  });
  check('un join buono funziona ancora', () => {
    send(JSON.stringify({ type: 'join', sessionId: 'abcdef0123456789' }));
    if (joined[joined.length - 1] !== 'abcdef0123456789') throw new Error('join non registrato');
    if (!sent.some((m) => m.type === 'sync')) throw new Error('nessun sync inviato');
  });
} finally {
  console.error = origErr;
  console.warn = origWarn;
  ws.emit('close');
}

console.log(`\nws-frame-guard: ${passed} ok, ${failed} falliti`);
process.exit(failed ? 1 : 0);
