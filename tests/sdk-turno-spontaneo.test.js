'use strict';
// [2026-09-30] Ordine del proprietario: «chiudono il turno dicendo "ti avviso quando
// finisce" e poi non avvisano mai». Causa misurata: quando un lavoro in
// background finisce il CLI riaccende il modello DA SOLO, ma
// SdkSession._consume inoltrava un messaggio solo se c'era un turno aperto da
// il proprietario — la risposta finiva nel vuoto. Prova PURA (niente SDK, niente disco):
// si guida SdkSession.prototype._route su un `this` fatto a mano con la
// sequenza VERA registrata dalla sonda del 30/09 (SDK 0.3.283).
const assert = require('assert');
const eng = require('../server/sdk-engine');
const { SdkSession } = eng;
const route = SdkSession.prototype._route;

let ok = 0;
function check(cond, label) { assert.ok(cond, label); ok++; }

function fakeSession() {
  return {
    sessionId: 'aaaaaaaa-test', dead: false, _evicting: false, activeTurn: null,
    lastActivity: 0, bgTasks: [], idleArms: 0,
    _armIdleTimer() { this.idleArms++; },
    onTurnEnd() {},
  };
}

// Sequenza dopo il primo `result`, come l'ha scritta il CLI vero.
const bgDone = { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
const afterResult = [
  bgDone,
  { type: 'system', subtype: 'task_updated' },
  { type: 'system', subtype: 'task_notification', status: 'completed' },
  { type: 'system', subtype: 'init', session_id: 'x', model: 'm' },
  { type: 'system', subtype: 'status', status: 'requesting' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'PROBE_DONE' }] } },
  { type: 'result', subtype: 'success' },
];

// (A) Col gestore registrato il turno spontaneo NASCE e porta la risposta ----
{
  const s = fakeSession();
  s.bgTasks = [{ id: 't1' }];
  const adopted = []; const bg = [];
  eng.setUnsolicitedTurnHandler((sid, proc) => { adopted.push({ sid, proc }); return true; });
  eng.setBackgroundTasksHandler((sid, n) => bg.push(n));
  const lines = [];
  for (const m of afterResult) {
    route.call(s, m);
    if (adopted.length === 1 && !adopted[0].hooked) {
      adopted[0].hooked = true;
      adopted[0].proc.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
    }
  }
  check(adopted.length === 1, '(A) un solo turno spontaneo aperto');
  check(adopted[0].sid === s.sessionId, '(A) consegnato alla sessione giusta');
  check(bg.length === 1 && bg[0] === 0, '(A) la card viene avvisata: zero lavori vivi');
  check(s.bgTasks.length === 0, '(A) livello dei lavori azzerato');
  check(s.activeTurn === null, '(A) il result chiude il turno spontaneo');
  check(adopted[0].proc._closed === true, '(A) turno chiuso');
  return setImmediate(() => {
    const types = lines.map((l) => JSON.parse(l).type);
    check(types.includes('assistant'), '(A) la risposta del modello arriva al tubo');
    check(types[types.length - 1] === 'result', '(A) il result è l\'ultima riga');
    check(!lines.some((l) => JSON.parse(l).subtype === 'task_notification'),
      '(A) i bookend PRIMA della ripartenza non aprono il turno');
    parteB();
  });
}

function parteB() {
  // (B) Solo bookend, senza ripartenza del modello: NESSUN turno fantasma ----
  {
    const s = fakeSession();
    let opened = 0;
    eng.setUnsolicitedTurnHandler(() => { opened++; return true; });
    for (const m of afterResult.slice(0, 3)) route.call(s, m);
    check(opened === 0, '(B) task_notification da solo non accende «sta lavorando»');
    check(!eng.opensTurn({ type: 'rate_limit_event' }), '(B) rate_limit_event non apre');
    check(!eng.opensTurn({ type: 'system', subtype: 'status', status: 'idle' }), '(B) status non-requesting non apre');
  }
  // (C) Gestore che rifiuta (sessione già occupata/sparita) → si lascia cadere --
  {
    const s = fakeSession();
    eng.setUnsolicitedTurnHandler(() => false);
    route.call(s, afterResult[5]);
    check(s.activeTurn === null, '(C) turno rifiutato non resta appeso');
  }
  // (D) Turno aperto dal proprietario: nessun turno spontaneo in mezzo ------------------
  {
    const s = fakeSession();
    let opened = 0; const fed = [];
    eng.setUnsolicitedTurnHandler(() => { opened++; return true; });
    s.activeTurn = { _feed: (m) => fed.push(m) };
    route.call(s, afterResult[5]);
    check(opened === 0 && fed.length === 1, '(D) il messaggio va al turno del proprietario');
  }
  // (E) I lavori ambient non contano; conta la sostituzione a livello ---------
  {
    const s = fakeSession(); const bg = [];
    eng.setUnsolicitedTurnHandler(null);
    eng.setBackgroundTasksHandler((sid, n) => bg.push(n));
    route.call(s, { type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a', task_type: 'agent' }, { task_id: 'w', task_type: 'watch', ambient: true }] });
    check(s.bgTasks.length === 1 && bg[0] === 1, '(E) un lavoro vero, l\'ambient escluso');
  }
  // (F) L'ozio NON sfratta una sessione con lavori vivi -------------------------
  {
    const timers = []; const realSet = global.setTimeout;
    global.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
    try {
      const s = fakeSession(); let evicted = 0; let rearmed = 0;
      s.bgTasks = [{ id: 't' }];
      s.evict = () => { evicted++; };
      s._armIdleTimer = function () { rearmed++; };
      SdkSession.prototype._armIdleTimer.call(s);
      timers[0]();
      check(evicted === 0 && rearmed === 1, '(F) lavoro vivo → rinvio, non sfratto');
      s.bgTasks = [];
      SdkSession.prototype._armIdleTimer.call(s);
      timers[1]();
      check(evicted === 1, '(F) finiti i lavori, l\'ozio sfratta come prima');
    } finally { global.setTimeout = realSet; }
  }
  eng.setUnsolicitedTurnHandler(null);
  eng.setBackgroundTasksHandler(null);
  console.log(`sdk-turno-spontaneo: ${ok} controlli verdi`);
}
