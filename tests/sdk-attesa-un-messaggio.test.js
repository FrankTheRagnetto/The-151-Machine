'use strict';
// [2026-10-01] Ordine del proprietario: «quando una sessione aspetta, il seguito deve
// completare LO STESSO messaggio, non crearne un secondo; e il "sto
// aspettando" non deve suonare come risposta pronta». Prova PURA: si guida
// SdkTurnProc vero con la sequenza del CLI registrata dal vivo il 30/09.
process.env.SDK_BG_GRACE_MS = '40';
process.env.SDK_BG_HOLD_OTHER_MS = '120';
const assert = require('assert');
const eng = require('../server/sdk-engine');
const { SdkSession, SdkTurnProc } = eng;
const route = SdkSession.prototype._route;
let ok = 0;
const check = (c, l) => { assert.ok(c, l); ok++; };

function fakeSession() {
  return { sessionId: 'bbbbbbbb-test', dead: false, _evicting: false, activeTurn: null,
    bgTasks: [], interrupts: 0, turnEnds: 0,
    _armIdleTimer() {}, interrupt() { this.interrupts++; },
    onTurnEnd() { this.turnEnds++; } };
}
function collect(turn) {
  const lines = [];
  turn.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  return lines;
}
const txt = (t) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const bgOn = { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash' }] };
const bgOff = { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
const result1 = { type: 'result', subtype: 'success', result: 'Aspetto il timer.', duration_ms: 3900, usage: { input_tokens: 5, output_tokens: 7 } };
const result2 = { type: 'result', subtype: 'success', result: 'FATTO.', duration_ms: 2000, usage: { input_tokens: 3, output_tokens: 2 } };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  eng.setUnsolicitedTurnHandler(() => { throw new Error('non deve nascere un secondo turno'); });
  eng.setBackgroundTasksHandler(null);

  // (A) Il caso del proprietario: «aspetto» → lavoro finisce → seguito NELLO STESSO turno
  {
    const s = fakeSession(); const t = new SdkTurnProc(s); s.activeTurn = t;
    const out = collect(t); let closed = false; t.on('close', () => { closed = true; });
    route.call(s, bgOn);
    route.call(s, txt('Aspetto il timer.'));
    route.call(s, result1);
    check(!t._closed && s.activeTurn === t, '(A) result con lavoro vivo NON chiude il messaggio');
    check(s.turnEnds === 0, '(A) nessuna fine turno → niente «risposta pronta», niente suono');
    route.call(s, bgOff);
    route.call(s, { type: 'system', subtype: 'task_notification', status: 'completed' });
    route.call(s, { type: 'system', subtype: 'init' });
    route.call(s, txt('FATTO.'));
    route.call(s, result2);
    await tick(10);
    check(t._closed && closed, '(A) il secondo result chiude il messaggio');
    check(s.turnEnds === 1, '(A) UNA sola fine turno per tutto');
    const text = out.filter((m) => m.type === 'stream_event').map((m) => m.event.delta.text).join('');
    check(text === 'Aspetto il timer.\n\nFATTO.', '(A) un messaggio solo, con a-capo fra le due parti: ' + JSON.stringify(text));
    const results = out.filter((m) => m.type === 'result');
    check(results.length === 2, '(A) passano due result (l\'uso dei token si conta tutto)');
    check(results[0].result === undefined && results[0].duration_ms === undefined, '(A) il result di attesa non porta testo né durata');
    check(results[0].usage && results[0].usage.output_tokens === 7, '(A) ma porta l\'uso, per il freno dei token');
    check(results[1].result === 'FATTO.', '(A) il result finale passa intero');
  }
  // (B) Nessun lavoro vivo: il result chiude come sempre --------------------
  {
    const s = fakeSession(); const t = new SdkTurnProc(s); s.activeTurn = t; collect(t);
    route.call(s, txt('ciao')); route.call(s, result1);
    check(t._closed && s.turnEnds === 1, '(B) turno normale: chiude al result');
  }
  // (C) Lavoro finito ma il modello non riparte: chiude dopo la grazia -------
  {
    const s = fakeSession(); const t = new SdkTurnProc(s); s.activeTurn = t; collect(t);
    route.call(s, bgOn); route.call(s, result1);
    route.call(s, bgOff);
    check(!t._closed, '(C) subito dopo: ancora in attesa');
    await tick(80);
    check(t._closed, '(C) dopo la grazia il messaggio si chiude');
  }
  // (D) Lavoro che non finisce mai (server in background): tetto -----------
  {
    const s = fakeSession(); const t = new SdkTurnProc(s); s.activeTurn = t; collect(t);
    route.call(s, bgOn); route.call(s, result1);
    await tick(60);
    check(!t._closed, '(D) prima del tetto: in attesa');
    await tick(120);
    check(t._closed, '(D) al tetto il messaggio si chiude da solo');
  }
  // (E) il proprietario scrive mentre è in attesa: niente interrupt del CLI fermo ------
  {
    const s = fakeSession(); const t = new SdkTurnProc(s); s.activeTurn = t; collect(t);
    route.call(s, bgOn); route.call(s, result1);
    check(t.isIdleHold(), '(E) in attesa col modello fermo');
    t.kill();
    check(s.interrupts === 0, '(E) kill in attesa non interrompe il CLI (il lavoro continua)');
    check(t._closed, '(E) il turno si chiude');
    const s2 = fakeSession(); const t2 = new SdkTurnProc(s2); s2.activeTurn = t2; collect(t2);
    route.call(s2, txt('lavoro')); t2.kill();
    check(s2.interrupts === 1, '(E) kill a turno vivo interrompe come prima');
  }
  // (F) La ripresa annulla la grazia: un seguito lento non viene troncato ---
  {
    const s = fakeSession(); const t = new SdkTurnProc(s); s.activeTurn = t; collect(t);
    route.call(s, bgOn); route.call(s, result1); route.call(s, bgOff);
    route.call(s, { type: 'system', subtype: 'init' });
    await tick(80);
    check(!t._closed, '(F) modello ripartito: la grazia non chiude a metà');
    route.call(s, result2);
    check(t._closed, '(F) chiude al suo result');
  }
  eng.setUnsolicitedTurnHandler(null);
  console.log(`sdk-attesa-un-messaggio: ${ok} controlli verdi`);
})().catch((e) => { console.error(e); process.exit(1); });
