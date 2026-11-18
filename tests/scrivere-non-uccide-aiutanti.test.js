'use strict';
// [29/10/2026] «Gli aiutanti in sottofondo non devono morire quando il proprietario scrive,
// e la scheda della sessione deve dire sempre la verità su di loro.»
//
// Il fatto (28/10 23:21:26Z, sessione Upgrade): 8 aiutanti in sottofondo, uno
// finisce, il modello riparte a scrivere; il proprietario scrive. Il telefono manda `stop`
// (senza source:'button'), il server chiama SdkTurnProc.kill() → interrupt()
// del CLI, e il CLI interrompe ANCHE gli aiutanti: 6 trascritti degli aiutanti
// finiscono con «[Request interrupted by user]» nello stesso millisecondo del
// turno principale. La card poi li fa sparire senza dire niente.
//
// LE LEGGI:
//   A. Aiutanti vivi e modello che scrive: lo stop di un messaggio scritto NON
//      interrompe (né interrupt né stopTask); il server risponde deferred.
//   B. [11/11 ] Il messaggio entra SUBITO nel turno in corso (priority «next»,
//      piegato alla prossima pausa), salvato in cronologia; gli aiutanti restano.
//      Se il motore non sa piegarlo, aspetta come prima e parte da solo (B2).
//   C. Senza aiutanti vivi lo stop di un messaggio scritto interrompe come prima.
//   D. Il tasto rosso (source:'button') ferma tutto come prima.
//   E. Un aiutante che sparisce senza «completed» = fermato: la scheda lo conta
//      (backgroundInfo.stopped) invece di farlo sparire; uno finito bene no.
//   F. La sessione che muore coi lavori vivi li conta come fermati.
//   G. Il prossimo messaggio del proprietario azzera il conto dei fermati.
// Prova pura: SessionManager vero, ws-handler vero, motore SDK con una sessione
// calda finta (nessun CLI, nessuna rete).
process.env.USE_SDK_ENGINE = '1';
delete process.env.DETACHED_RUNS;
process.env.SDK_BG_GRACE_MS = '40';
process.env.SDK_BG_DEAD_MS = '30';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let ok = 0, failed = 0;
const check = (c, l) => { if (c) { ok++; console.log('  ok   ' + l); } else { failed++; console.log('  FAIL ' + l); } };
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

const eng = require('../server/sdk-engine');
const { SdkSession, SdkTurnProc } = eng;
const { SessionManager } = require('../server/session-manager');
const setupWsHandler = require('../server/ws-handler.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrivere-aiutanti-'));
const mgr = new SessionManager(path.join(tmp, 'sessions.json'));

function warm(sid) {
  const s = Object.create(SdkSession.prototype);
  Object.assign(s, { sessionId: sid, dead: false, _evicting: false, activeTurn: null, bgTasks: [],
    lastActivity: Date.now(), _respawnAfterTurn: false, _idleTimer: null, _freezeTimer: null, model: null });
  s.interrupts = 0; s.stopped = []; s.pushed = [];
  s._armIdleTimer = () => {}; s._armFreezeWatch = () => {}; s._clearFreezeWatch = () => {};
  s.interrupt = () => { s.interrupts++; };
  s._input = { push: (m) => s.pushed.push(m), end() {} };
  s._aborter = { abort() {} };
  s._query = { stopTask: (id) => { s.stopped.push(id); return Promise.resolve(); } };
  eng._registry.set(sid, s);
  return s;
}
const agenti = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed',
  tasks: ids.map((id) => ({ task_id: id, task_type: 'local_agent', description: 'Studio ' + id })) });
const notifica = (id, status) => ({ type: 'system', subtype: 'task_notification', task_id: id, status, output_file: '', summary: '' });
const parla = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Uno ha finito, ' } } };
const result = { type: 'result', subtype: 'success', result: 'Fatto.', duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } };
const route = (s, m) => SdkSession.prototype._route.call(s, m);

// ws-handler vero sul manager vero; il tubo del flusso finto fa ciò che fa il
// vero alla chiusura (finishMessage se non ucciso dal proprietario).
function presa(sid) {
  const spawned = [];
  const deps = {
    manager: mgr, isTokenValid: () => true, sendToSession: () => {}, broadcastSessionStatus: () => {},
    addSessionSocket: () => {}, removeSessionSocket: () => {},
    spawnStreamHandler: (proc, id) => {
      spawned.push(proc);
      proc.stdout.on('data', () => {});
      proc.on('close', () => { if (!proc._userKilled) mgr.finishMessage(id, 'risposta'); });
    },
    generateAutoTitleStage1: async () => {}, generateAutoTitleStage2: async () => {},
    sessionMessageQueue: new Map(), sessionLastJoin: new Map(), globalProcessedNonces: new Set(),
    globalReplayedSet: new Set(), serverState: { BUILD_HASH: 'b', CODE_HASH: 'c', DEPLOY_HASH: 'd' }, SERVER_BOOT: 1,
  };
  const wss = new EventEmitter(); wss.clients = new Set();
  setupWsHandler(wss, deps);
  const ws = new EventEmitter(); const sent = [];
  ws.send = (x) => sent.push(JSON.parse(x)); ws.close = () => {}; ws.ping = () => {}; ws.terminate = () => {};
  wss.emit('connection', ws, { url: '/?token=x', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } });
  ws.emit('message', JSON.stringify({ type: 'join', sessionId: sid }), false);
  const emit = (o) => ws.emit('message', JSON.stringify(o), false);
  return { sent, spawned, emit };
}

// Il motore vero apre il turno nuovo sulla sessione calda finta.
eng.startTurn = ({ sessionId }) => new SdkTurnProc(eng._registry.get(sessionId));

function turnoCheParla(sid, w) {
  const t = new SdkTurnProc(w); w.activeTurn = t; t.stdout.on('data', () => {});
  const vera = mgr.sessions.get(sid);
  vera.process = t; vera.status = 'busy';
  return t;
}

(async () => {
  eng.setUnsolicitedTurnHandler(null);
  eng.setBackgroundTasksHandler(null);
  try {
    // ---- A + B: il caso del 28/10 ----
    {
      const sess = mgr.create({ title: 'upgrade', workingDirectory: tmp });
      const w = warm(sess.id);
      const t = turnoCheParla(sess.id, w);
      route(w, agenti('a1', 'a2', 'a3'));
      route(w, parla); // il modello sta scrivendo (uno ha finito, ne parla)
      check(!t.isIdleHold(), '(A) il modello sta scrivendo, 3 aiutanti vivi');
      const p = presa(sess.id);
      p.emit({ type: 'stop' });                       // il telefono, prima del messaggio
      p.emit({ type: 'message', content: 'ciao, intanto…', nonce: 'n-1' });
      await pausa(5);
      check(w.interrupts === 0, '(A) scrivere NON interrompe il CLI (gli aiutanti restano vivi)');
      check(w.stopped.length === 0, '(A) e non ferma nessun lavoro in sottofondo');
      check(!t._closed && mgr.isSessionBusy(sess.id), '(A) il turno che sta scrivendo continua');
      const st = p.sent.find((m) => m.type === 'stopped');
      check(!!st && st.stopped === false && st.deferred === true, '(A) il server dice al telefono «aspetta» (deferred), non «fermato»');
      // [11/11/2026 ] Prima il messaggio aspettava la FINE del turno (98 min l'11/11, perso al riavvio):
      // ora entra SUBITO nell'input del CLI con priority 'next' (piegato alla prossima pausa fra strumenti).
      const piegato = w.pushed.find((m) => m && m.message && /ciao, intanto/.test(String(m.message.content)));
      check(!!piegato && piegato.priority === 'next', '(A) il messaggio entra subito nel turno in corso, priority «next»');
      check(!/INTERRUPTION/.test(String(piegato && piegato.message.content)), '(A) entra com\'è, senza «sei stato interrotto»');
      check(p.sent.some((m) => m.type === 'ack' && !m.deferred), '(A) il telefono riceve l\'ack normale (non «in attesa»)');
      const voce = mgr.sessions.get(sess.id).history.find((h) => h.role === 'user' && /ciao, intanto/.test(h.content));
      check(!!voce && voce.nonce === 'n-1', '(A) il messaggio è SUBITO nella cronologia, voce sua col suo nonce');
      let suDisco = ''; try { suDisco = fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8'); } catch {}
      check(suDisco.includes('ciao, intanto'), '(A) e salvato su disco: un riavvio non lo perde');
      check(!mgr.hasWaitingMessages(sess.id), '(A) niente coda in memoria');
      check(t === w.activeTurn && !t._closed, '(A) il turno resta lo stesso (nessun turno nuovo)');
      route(w, result); // il turno finisce (col messaggio piegato dentro)
      await pausa(5);
      check(w.interrupts === 0 && w.stopped.length === 0 && w.bgTasks.length === 3, '(B) nessuna interruzione, i 3 aiutanti sono ancora vivi');
      check(w.pushed.filter((m) => /ciao, intanto/.test(String(m && m.message && m.message.content))).length === 1, '(B) il messaggio entra UNA volta sola');
      check(p.spawned.length === 0, '(B) nessun secondo invio a fine turno');
      check(eng.backgroundInfo(sess.id).count === 3, '(B) la scheda dice ancora 3');
    }
    // ---- A2 + B2: motore che non sa piegare (riserva): la coda di prima ----
    {
      const sess = mgr.create({ title: 'riserva', workingDirectory: tmp });
      const w = warm(sess.id);
      w.foldIn = () => false;
      const t = turnoCheParla(sess.id, w);
      route(w, agenti('a1', 'a2', 'a3'));
      route(w, parla);
      const p = presa(sess.id);
      p.emit({ type: 'message', content: 'ciao, intanto…', nonce: 'n-2' });
      await pausa(5);
      check(p.sent.some((m) => m.type === 'ack' && m.deferred === true), '(A2) non piegato: il messaggio è messo in attesa');
      check(w.pushed.length === 0 && w.interrupts === 0, '(A2) e non entra mentre il modello parla, senza interrompere');
      route(w, result);
      await pausa(5);
      const consegnato = w.pushed.find((m) => m && m.message && /ciao, intanto/.test(String(m.message.content)));
      check(!!consegnato, '(B2) a modello fermo parte da solo');
      check(w.bgTasks.length === 3 && w.stopped.length === 0, '(B2) i 3 aiutanti sono ancora vivi');
      check(p.spawned.length === 1 && mgr.isSessionBusy(sess.id), '(B2) il turno nuovo è attaccato al flusso');
      void t;
    }
    // ---- C: senza aiutanti, scrivere interrompe come prima ----
    {
      const sess = mgr.create({ title: 'senza', workingDirectory: tmp });
      const w = warm(sess.id);
      const t = turnoCheParla(sess.id, w);
      route(w, parla);
      const p = presa(sess.id);
      p.emit({ type: 'stop' });
      check(w.interrupts === 1 && t._closed, '(C) senza aiutanti vivi lo stop interrompe come sempre');
      const st = p.sent.find((m) => m.type === 'stopped');
      check(!!st && st.stopped === true && !st.deferred, '(C) e dice «fermato»');
    }
    // ---- D: il tasto rosso ferma tutto ----
    {
      const sess = mgr.create({ title: 'rosso', workingDirectory: tmp });
      const w = warm(sess.id);
      const t = turnoCheParla(sess.id, w);
      route(w, agenti('r1', 'r2'));
      route(w, parla);
      const p = presa(sess.id);
      p.emit({ type: 'stop', source: 'button' });
      check(w.stopped.join(',') === 'r1,r2' && t._closed, '(D) tasto rosso → ferma gli aiutanti e il turno, come prima');
    }
    // ---- E + F + G: la scheda conta i fermati ----
    {
      const sess = mgr.create({ title: 'scheda', workingDirectory: tmp });
      const w = warm(sess.id);
      turnoCheParla(sess.id, w);
      route(w, agenti('e1', 'e2', 'e3'));
      route(w, notifica('e1', 'completed'));
      route(w, agenti('e2', 'e3'));            // e1 finito bene
      route(w, agenti('e3'));                  // e2 sparito senza «completed»
      await pausa(60);
      let i = eng.backgroundInfo(sess.id);
      check(i.count === 1 && i.stopped === 1, '(E) 1 vivo, 1 fermato (quello finito bene non conta)');
      route(w, { type: 'system', subtype: 'task_updated', task_id: 'e3', patch: { status: 'killed' } });
      route(w, agenti());
      await pausa(5);
      i = eng.backgroundInfo(sess.id);
      check(i.count === 0 && i.stopped === 2, '(E) «killed» del CLI → contato subito come fermato');
      const w2 = warm(sess.id); // la sessione rinasce e riparte con 2 lavori, poi muore
      turnoCheParla(sess.id, w2);
      route(w2, agenti('f1', 'f2'));
      SdkSession.prototype._teardown.call(w2);
      i = eng.backgroundInfo(sess.id);
      check(i.count === 0 && i.stopped === 4, '(F) la sessione muore coi lavori vivi → contati come fermati');
      const vera = mgr.sessions.get(sess.id); vera.process = null; vera.status = 'idle';
      eng.startTurn = () => { const e = new EventEmitter(); e.stdin = { write() {}, end() {} }; e.stdout = new EventEmitter(); e.stderr = new EventEmitter(); e.kill = () => {}; return e; };
      try { mgr.sendMessage(sess.id, 'nuovo messaggio'); } catch (e) { console.log('    (sendMessage: ' + e.message + ')'); }
      check(eng.backgroundInfo(sess.id).stopped === 0, '(G) il prossimo messaggio del proprietario azzera il conto');
    }
    // ---- fili: index.js e la lista sessioni portano «stopped» al telefono ----
    {
      const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
      check(/backgroundStopped|stopped:\s*info\.stopped/.test(idx), '(fili) index.js manda il conto dei fermati nel session_background');
      const sm = fs.readFileSync(path.join(__dirname, '..', 'server', 'session-manager.js'), 'utf8');
      check(/backgroundStopped/.test(sm), '(fili) la lista delle sessioni porta backgroundStopped');
      const inp = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'input.js'), 'utf8');
      const wsc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ws.js'), 'utf8');
      check(/_stopResolve\(msg\)/.test(wsc), '(fili) il telefono passa la risposta dello stop (deferred) a chi scrive');
      const i0 = inp.indexOf('stopAck.deferred'), i1 = inp.indexOf('*[Stopped]*');
      check(i0 > 0 && i1 > i0 && /content: text,/.test(inp.slice(i0, i1)), '(fili) deferred → niente «[Stopped]», il testo parte senza «INTERRUPTION»');
    }
  } finally {
    for (const k of [...eng._registry.keys()]) eng._registry.delete(k);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`scrivere-non-uccide-aiutanti: ${ok} verdi, ${failed} rossi`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
