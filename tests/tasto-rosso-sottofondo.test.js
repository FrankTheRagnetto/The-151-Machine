'use strict';
// [17/10/2026] il proprietario: «se voglio fermarla la apro e premo il tasto rosso di
// interruzione». Il tasto della card è stato tolto: il tasto rosso della chat
// deve fermare ANCHE i lavori in sottofondo che tengono la sessione in WAITING
// (turno in attesa, o turno già chiuso). Scrivere un messaggio durante il
// lavoro manda lo stesso `stop` ma NON deve fermarli (regola del 01/10:
// «il proprietario che scrive non ha fermato niente»): la differenza è source:'button'.
// Prova pura: SessionManager vero su un file temporaneo, motore SDK con una
// sessione calda finta (nessun CLI), ws-handler su un wss finto.
process.env.USE_SDK_ENGINE = '1';
delete process.env.DETACHED_RUNS; // niente session-host vero nelle prove
process.env.SDK_BG_GRACE_MS = '40';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let ok = 0, failed = 0;
const check = (c, l) => { if (c) { ok++; console.log('  ok   ' + l); } else { failed++; console.log('  FAIL ' + l); } };

const eng = require('../server/sdk-engine');
const { SdkSession, SdkTurnProc } = eng;
const { SessionManager } = require('../server/session-manager');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasto-rosso-'));
const mgr = new SessionManager(path.join(tmp, 'sessions.json'));

function warm(sid, stopped) {
  const s = Object.create(SdkSession.prototype);
  Object.assign(s, { sessionId: sid, dead: false, _evicting: false, activeTurn: null, bgTasks: [],
    lastActivity: Date.now(), _respawnAfterTurn: false, _idleTimer: null, _freezeTimer: null });
  s._armIdleTimer = () => {}; s.interrupt = () => {}; s.onTurnEnd = () => {};
  s._query = { stopTask: (id) => { stopped.push(id); return Promise.resolve(); } };
  eng._registry.set(sid, s);
  return s;
}
const bg = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: '' })) });
const result = { type: 'result', subtype: 'success', result: 'Fatto.', duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } };
const route = (s, m) => SdkSession.prototype._route.call(s, m);

(async () => {
  eng.setUnsolicitedTurnHandler(null);
  eng.setBackgroundTasksHandler(null);
  try {
    // (1) Turno già chiuso, lavoro vivo (WAITING a turno chiuso): tasto rosso.
    {
      const sess = mgr.create({ title: 'chiuso', workingDirectory: tmp });
      const stopped = [];
      const w = warm(sess.id, stopped);
      w.bgTasks = [{ id: 'bvecchio1', type: 'local_bash', description: '' }];
      const r = mgr.stopMessage(sess.id, { stopBackground: true });
      check(stopped.join(',') === 'bvecchio1', '(1) turno chiuso + tasto rosso → il lavoro in sottofondo viene fermato');
      check(r === true, '(1) e il server dice «fermato» (niente «Nothing to stop»)');
    }
    // (2) Stesso caso, ma è un messaggio scritto (stop semplice): i lavori continuano.
    {
      const sess = mgr.create({ title: 'scrive', workingDirectory: tmp });
      const stopped = [];
      const w = warm(sess.id, stopped);
      w.bgTasks = [{ id: 'bvivo0001', type: 'local_bash', description: '' }];
      mgr.stopMessage(sess.id);
      check(stopped.length === 0, '(2) stop senza tasto rosso (messaggio scritto) → il lavoro continua');
    }
    // (3) Turno in attesa del sottofondo (WAITING col turno aperto): tasto rosso.
    {
      const sess = mgr.create({ title: 'attesa', workingDirectory: tmp });
      const stopped = [];
      const w = warm(sess.id, stopped);
      const t = new SdkTurnProc(w); w.activeTurn = t; t.stdout.on('data', () => {});
      route(w, bg('bturno001'));
      route(w, result);
      check(t.isIdleHold(), '(3) turno in attesa del lavoro nato in lui');
      const vera = mgr.sessions.get(sess.id); // l'oggetto vivo del manager
      vera.process = t; vera.status = 'busy';
      const r = mgr.stopMessage(sess.id, { stopBackground: true });
      check(stopped.join(',') === 'bturno001', '(3) tasto rosso in attesa → il lavoro viene fermato');
      check(r === true && t._closed && vera.status === 'idle', '(3) il turno si chiude e la sessione torna libera');
    }
    // (4) ws-handler: il tasto rosso porta source:'button' fino al manager.
    {
      const setupWsHandler = require('../server/ws-handler.js');
      const calls = [];
      const deps = {
        manager: { isSessionBusy: () => false, get: () => ({ id: 'w1', history: [] }), getStreamState: () => null,
          consumeDeployMarker: () => null, sessions: new Map(), markRead: () => {},
          stopMessage: (id, opts) => { calls.push([id, opts]); return true; } },
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
      wss.emit('connection', ws, { url: '/?token=x', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } });
      ws.emit('message', JSON.stringify({ type: 'join', sessionId: 'w1' }), false);
      ws.emit('message', JSON.stringify({ type: 'stop', source: 'button' }), false);
      ws.emit('message', JSON.stringify({ type: 'stop' }), false);
      check(calls.length === 2, '(4) due stop arrivano al manager');
      check(calls[0] && calls[0][1] && calls[0][1].stopBackground === true, '(4) tasto rosso → stopBackground: true');
      check(calls[1] && !(calls[1][1] && calls[1][1].stopBackground), '(4) stop semplice (messaggio scritto) → senza stopBackground');
    }
  } finally {
    for (const k of [...eng._registry.keys()]) eng._registry.delete(k);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`tasto-rosso-sottofondo: ${ok} verdi, ${failed} rossi`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
