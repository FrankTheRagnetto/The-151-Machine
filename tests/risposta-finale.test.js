'use strict';
// [2026-10-01] il proprietario: «muri di testo, non capisco cosa sto guardando» →
// «sì, solo la risposta finale». Prova PURA dello stream-handler vero: il
// testo prima dell'ultimo strumento va in `steps`, la risposta è solo il
// pezzo dopo; il testo dei sotto-agenti non entra; senza strumenti non cambia
// niente; i passaggi finiscono anche nella storia.
const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const createStreamHandler = require('../server/stream-handler');
let ok = 0;
const check = (c, l) => { assert.ok(c, l); ok++; };

function run(lines) {
  return new Promise((resolve) => {
    const sent = []; const finished = [];
    const manager = new Proxy({
      sessions: new Map(),
      finishMessage: (...a) => finished.push(a),
    }, { get: (t, k) => (k in t ? t[k] : () => {}) });
    const { spawnStreamHandler } = createStreamHandler({
      manager, sendToSession: (sid, d) => sent.push(d), broadcastSessionStatus: () => {}, getPluginManager: () => null,
    });
    const proc = new EventEmitter();
    proc.stdout = new Readable({ read() {} }); proc.stderr = new Readable({ read() {} });
    spawnStreamHandler(proc, 'cccccccc-test');
    proc.stdout.push(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    setImmediate(() => { proc.emit('close', 0); resolve({ done: sent.find((d) => d.type === 'done'), finished }); });
  });
}
const A = (blocks, extra) => Object.assign({ type: 'assistant', message: { content: blocks } }, extra || {});
const T = (t) => ({ type: 'text', text: t });
const U = (n) => ({ type: 'tool_use', id: 'tu' + n, name: 'Bash', input: {} });

(async () => {
  // (A) il muro: parla, strumento, parla, strumento, risponde
  {
    const { done, finished } = await run([
      A([T('Controllo il server.')]), A([U(1)]),
      A([T('Ora leggo il log.')]), A([U(2)]),
      A([T('Il server è su, tutto ok.')]),
      { type: 'result', result: 'Il server è su, tutto ok.' },
    ]);
    check(done.fullResponse === 'Il server è su, tutto ok.', '(A) la risposta è solo il pezzo finale: ' + JSON.stringify(done.fullResponse));
    check(done.finalOnly === true, '(A) il client sa che è già separata');
    check(JSON.stringify(done.steps) === JSON.stringify(['Controllo il server.', 'Ora leggo il log.']), '(A) i passaggi ripiegati');
    check(finished[0][1] === 'Il server è su, tutto ok.' && finished[0][4].length === 2, '(A) la storia salva risposta e passaggi');
  }
  // (B) niente strumenti: identico a prima
  {
    const { done } = await run([A([T('Ciao Anna.')]), { type: 'result', result: 'Ciao Anna.' }]);
    check(done.fullResponse === 'Ciao Anna.' && done.steps.length === 0, '(B) risposta semplice invariata');
  }
  // (C) il turno finisce con uno strumento: risposta = ultimo testo
  {
    const { done } = await run([A([T('Lancio il comando.')]), A([U(1)]), { type: 'result' }]);
    check(done.fullResponse === 'Lancio il comando.' && done.steps.length === 0, '(C) nessun testo dopo: vale l\'ultimo');
  }
  // (D) sotto-agente: il suo testo non entra
  {
    const { done } = await run([
      A([T('Mando un agente.')]), A([U(1)]),
      A([T('RAPPORTO INTERNO DEL SOTTO-AGENTE')], { parent_tool_use_id: 'tu1' }),
      A([T('Fatto: tre file sistemati.')]),
    ]);
    check(!/SOTTO-AGENTE/.test(done.fullResponse) && !/SOTTO-AGENTE/.test(JSON.stringify(done.steps)), '(D) il sotto-agente resta fuori');
    check(done.fullResponse === 'Fatto: tre file sistemati.', '(D) risposta giusta');
  }
  // (E) attesa in background (turno tenuto aperto): «aspetto» diventa passaggio
  {
    const { done } = await run([
      A([U(1)]), A([T('Aspetto il timer.')]), { type: 'result' },
      A([U(2)]), A([T('Il timer ha stampato FATTO.')]), { type: 'result', result: 'Il timer ha stampato FATTO.' },
    ]);
    check(done.fullResponse === 'Il timer ha stampato FATTO.', '(E) dopo l\'attesa la risposta è il seguito');
    check(done.steps[0] === 'Aspetto il timer.', '(E) «aspetto» ripiegato fra i passaggi');
  }
  console.log(`risposta-finale: ${ok} controlli verdi`);
})().catch((e) => { console.error(e); process.exit(1); });
