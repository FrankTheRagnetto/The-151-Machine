'use strict';
// [17/10/2026] «Perché non chiudono i turni?». Misurato quel giorno su
// due sessioni vere (pm2-out.log + transcript del CLI): un ciclo
// d'attesa scritto con `pgrep -f` trovava sé stesso e non finiva mai; il CLI,
// passati i 10 minuti, lo spostava in sottofondo; da lì OGNI turno della
// sessione restava «in attesa del background» fino al tetto di 15 minuti.
// Rimedi provati qui, puri (nessun server, nessun CLI):
//   1. il messaggio aspetta SOLO i lavori nati nel suo stesso turno;
//   2. un comando spostato in sottofondo per il limite di tempo non si aspetta,
//      e il log dice quale lavoro si sta aspettando;
//   4. (parte server) il motore dice cosa aspetta e sa fermare i lavori:
//      backgroundInfo / stopBackgroundTasks (il tasto rosso: tests/tasto-rosso-sottofondo.test.js).
process.env.SDK_BG_GRACE_MS = '40';
process.env.SDK_BG_HOLD_OTHER_MS = '400';
const assert = require('assert');
const eng = require('../server/sdk-engine');
const { SdkSession, SdkTurnProc } = eng;

let ok = 0;
let failed = 0;
const check = (c, l) => {
  if (c) { ok++; console.log('  ok   ' + l); }
  else { failed++; console.log('  FAIL ' + l); }
};

// Una SdkSession VERA (prototipo intero) senza far partire il CLI.
function fakeSession(id) {
  const s = Object.create(SdkSession.prototype);
  Object.assign(s, {
    sessionId: id || 'cccccccc-test', dead: false, _evicting: false, activeTurn: null,
    bgTasks: [], interrupts: 0, turnEnds: 0, lastActivity: Date.now(),
    _respawnAfterTurn: false, _idleTimer: null, _freezeTimer: null,
  });
  s._armIdleTimer = () => {};
  s.interrupt = function () { this.interrupts++; };
  s.onTurnEnd = function () { this.turnEnds++; };
  return s;
}
function openTurn(s) {
  const t = new SdkTurnProc(s); s.activeTurn = t;
  t.stdout.on('data', () => {});
  return t;
}
const route = (s, m) => SdkSession.prototype._route.call(s, m);
const bg = (...tasks) => ({ type: 'system', subtype: 'background_tasks_changed',
  tasks: tasks.map(([id, d]) => ({ task_id: id, task_type: 'local_bash', description: d || '' })) });
const result = { type: 'result', subtype: 'success', result: 'Fatto.', duration_ms: 1000, usage: { input_tokens: 1, output_tokens: 1 } };
const movedBack = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x',
  content: `Command did not complete within its 600s timeout and was moved to the background (ID: ${id}). Output is being written to: /tmp/x/${id}.output. You will be notified when it completes.` }] } });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  eng.setUnsolicitedTurnHandler(null);
  const notes = [];
  eng.setBackgroundTasksHandler((sid, n) => notes.push([sid, n]));

  // (1) Lavoro nato in un turno VECCHIO: il turno nuovo chiude al suo result.
  {
    const s = fakeSession();
    const t1 = openTurn(s);
    route(s, bg(['bthqnmpet', 'Wait for Spy x Family process to end']));
    t1._finish(0); s.activeTurn = null;                // turno vecchio chiuso (tetto, stop…)
    const t2 = openTurn(s);                              // il proprietario scrive «so?»
    route(s, { type: 'system', subtype: 'init' });
    route(s, result);
    check(t2._closed, '(1) lavoro di un turno vecchio: il turno nuovo chiude subito al result');
    check(s.bgTasks.length === 1, '(1) il lavoro resta contato come vivo (la card lo deve poter mostrare)');
  }
  // (1b) Lavoro nato in QUESTO turno: l'attesa del 01/10 resta com'era.
  {
    const s = fakeSession();
    const t = openTurn(s);
    route(s, bg(['b1', 'npm test']));
    route(s, result);
    check(!t._closed && t.isIdleHold(), '(1b) lavoro nato nel turno: il messaggio aspetta (regola del 01/10)');
    route(s, bg());
    await tick(80);
    check(t._closed, '(1b) finito il lavoro, dopo la grazia il messaggio si chiude');
  }
  // (2) Comando spostato in sottofondo dal CLI per i 10 minuti: non si aspetta.
  {
    const s = fakeSession();
    const t = openTurn(s);
    route(s, bg(['bdv7iwwxg', 'Block until Fronte B committed and no gate runs']));
    route(s, movedBack('bdv7iwwxg'));
    route(s, result);
    check(t._closed, '(2) comando scaduto e spostato in sottofondo: il messaggio non lo aspetta');
  }
  // (2b) Due lavori del turno, uno scaduto: si aspetta solo l'altro, e il log lo dice.
  {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    let t, s;
    try {
      s = fakeSession('dddddddd-test');
      t = openTurn(s);
      route(s, bg(['bscaduto1', 'ciclo infinito'], ['bvero0001', 'Run baseline test suite']));
      route(s, movedBack('bscaduto1'));
      route(s, result);
    } finally { console.log = orig; }
    check(!t._closed && t.isIdleHold(), '(2b) un lavoro vero del turno: il messaggio aspetta lui');
    const line = logs.find((l) => /in attesa del background/.test(l)) || '';
    check(/bvero0001/.test(line) && /Run baseline test suite/.test(line), '(2b) il log dice quale lavoro aspetta: ' + JSON.stringify(line));
    check(!/bscaduto1/.test(line), '(2b) e non nomina quello scaduto');
    route(s, bg(['bscaduto1', 'ciclo infinito']));     // finisce quello vero, lo scaduto resta vivo
    await tick(80);
    check(t._closed, '(2b) finito il lavoro vero, il messaggio si chiude anche se lo scaduto vive');
  }
  // (4) Il motore dice cosa aspetta e sa fermare i lavori.
  {
    check(typeof eng.backgroundInfo === 'function', '(4) backgroundInfo esportata');
    check(typeof eng.stopBackgroundTasks === 'function', '(4) stopBackgroundTasks esportata');
    if (typeof eng.backgroundInfo === 'function' && typeof eng.stopBackgroundTasks === 'function') {
      const sid = 'eeeeeeee-test';
      const s = fakeSession(sid);
      const stopped = [];
      s._query = { stopTask: (id) => { stopped.push(id); return Promise.resolve(); } };
      eng._registry.set(sid, s);
      try {
        const t = openTurn(s);
        notes.length = 0;
        route(s, bg(['bA', 'gate'], ['bB', '']));
        route(s, result);
        const info = eng.backgroundInfo(sid);
        check(info.count === 2 && info.waiting === true, '(4) info: 2 lavori, turno in attesa');
        check(Array.isArray(info.tasks) && info.tasks[0].id === 'bA' && info.tasks[0].description === 'gate', '(4) info: lista con id e descrizione');
        check(notes.length >= 2, '(4) il client viene avvisato anche quando l\'attesa comincia (non solo al cambio del numero)');
        const n = eng.stopBackgroundTasks(sid);
        check(n === 2 && stopped.join(',') === 'bA,bB', '(4) stop: chiede al CLI di fermare ogni lavoro vivo');
        route(s, bg());
        check(t._closed, '(4) fermati dal proprietario, il messaggio si chiude SUBITO (niente 20 s di grazia con la card ferma)');
        await tick(80);
        check(t._closed && !eng.backgroundInfo(sid).waiting, '(4) fermati i lavori, il messaggio si chiude da solo');
        check(eng.stopBackgroundTasks('nessuna-sessione') === 0, '(4) sessione non calda: 0, nessun errore');
      } finally { eng._registry.delete(sid); }
    }
  }
  eng.setBackgroundTasksHandler(null);
  console.log(`sdk-attesa-solo-del-turno: ${ok} verdi, ${failed} rossi`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
