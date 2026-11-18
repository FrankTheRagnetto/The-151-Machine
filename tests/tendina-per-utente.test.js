'use strict';
// [2026-10-09] il proprietario: «tutto ciò che la sessione scrive per me (domande, prompt
// da incollare, istruzioni) deve stare fuori dalla tendina, sempre». Prova PURA
// dello stream-handler vero coi messaggi veri di oggi
// (tests/fixtures/esempi, messaggi di esempio).
// Caso vero: alle 9:16 una risposta intera col prompt da incollare è finita in
// «▶ Passaggi» — l'agente in background ha fatto ripartire il turno e il testo
// dopo è diventato «la risposta».
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const createStreamHandler = require('../server/stream-handler');
const { perNico } = createStreamHandler;
const PN = require('../public/js/per-utente.js');
let ok = 0;
const check = (c, l) => { assert.ok(c, l); ok++; };
const F = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'esempi', n), 'utf8');

function run(lines) {
  return new Promise((resolve) => {
    const sent = []; const finished = [];
    const manager = new Proxy({ sessions: new Map(), finishMessage: (...a) => finished.push(a) },
      { get: (t, k) => (k in t ? t[k] : () => {}) });
    const { spawnStreamHandler } = createStreamHandler({
      manager, sendToSession: (sid, d) => sent.push(d), broadcastSessionStatus: () => {}, getPluginManager: () => null,
    });
    const proc = new EventEmitter();
    proc.stdout = new Readable({ read() {} }); proc.stderr = new Readable({ read() {} });
    spawnStreamHandler(proc, 'dddddddd-test');
    proc.stdout.push(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    setImmediate(() => { proc.emit('close', 0); resolve({ done: sent.find((d) => d.type === 'done'), finished }); });
  });
}
let mid = 0;
const A = (blocks) => ({ type: 'assistant', message: { id: 'm' + (++mid), content: blocks } });
const T = (t) => ({ type: 'text', text: t });
const U = (n, name) => ({ type: 'tool_use', id: 'tu' + n, name: name || 'Bash', input: {} });
const R = (n) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu' + n, content: 'ok' }] } });
const UTENTE = (t) => ({ type: 'user', message: { content: t } });

(async () => {
  // (1) Il caso vero delle 9:16-9:19: agente in background → risposta col
  // prompt → avviso automatico → lavori → risposta finale → «Stop hook» → riga.
  {
    const risposta = F('0916-risposta-col-prompt.md');
    const { done, finished } = await run([
      A([U(1, 'Agent')]), R(1), A([T(risposta)]), { type: 'result', result: risposta },
      UTENTE('<task-notification>\n<task-id>a9099382f071dfd31</task-id>\n</task-notification>'),
      A([U(2)]), R(2), A([U(3)]), R(3),
      A([T(F('0919-finale.md'))]),
      UTENTE('Stop hook feedback:\nHai cambiato codice ma la scheda del progetto non è stata toccata dopo'),
      A([T(F('0919-dopo-avviso.md'))]), { type: 'result' },
    ]);
    check(done.fullResponse.includes('Incolla questo nella sessione del controllo'), '(1) il prompt da incollare è nella risposta, non nella tendina');
    check(done.fullResponse.includes('```\nDecisioni prese:'), '(1) il blocco del prompt c\'è intero');
    check(done.fullResponse.indexOf('Hai ragione sulla firma') < done.fullResponse.indexOf('Ho corretto la regola'), '(1) nell\'ordine in cui è stato scritto');
    check(done.steps.length === 0, '(1) tendina vuota: ' + JSON.stringify(done.steps).slice(0, 80));
    check(finished[0][1] === done.fullResponse && finished[0][4].length === 0, '(1) anche la storia salvata la tiene fuori');
  }
  // (2) Il parlare-da-solo vero delle 7:48 resta nella tendina.
  {
    const { done } = await run([
      A([T('Sto capendo perché il riporto della nota di stamattina si è fermato; poi ti scrivo.')]), A([U(1)]), R(1),
      A([T('Sto mettendo il problema della nota nella lista delle cose da fare, poi ti preparo il messaggio per la squadra.')]), A([U(2)]), R(2),
      A([T('☀️ Agent 7 — Stamattina la nota di oggi non è nata da sola.')]),
    ]);
    check(done.steps.length === 2 && done.fullResponse === '☀️ Agent 7 — Stamattina la nota di oggi non è nata da sola.', '(2) i passaggi brevi restano ripiegati');
  }
  // (3) La riga in inglese delle 9:04 (ha un «—» ma niente firma): tendina.
  {
    const { done } = await run([A([T('Both verified done by the check session — moving them to history as done.')]), A([U(1)]), R(1), A([T('Fatto.')])]);
    check(done.steps.length === 1 && done.fullResponse === 'Fatto.', '(3) «Both verified…» resta passaggio');
  }
  // (4) Una domanda fra un lavoro e l'altro non si nasconde mai.
  {
    const { done } = await run([A([T('Il cestino va svuotato ogni notte o una volta a settimana?')]), A([U(1)]), R(1), A([T('Intanto ho preparato le due versioni.')])]);
    check(done.fullResponse.startsWith('Il cestino va svuotato') && done.steps.length === 0, '(4) la domanda resta fuori');
  }
  // (5) Un elenco di istruzioni fra un lavoro e l'altro: fuori.
  {
    const { done } = await run([A([T('Prima di andare avanti:\n1. Apri Archivio.\n2. Cancella i file .apk.')]), A([U(1)]), R(1), A([T('Poi dimmi.')])]);
    check(/1\. Apri Archivio/.test(done.fullResponse) && done.steps.length === 0, '(5) le istruzioni restano fuori');
  }
  // (6) Il messaggio delle 7 scelte (9:22, nessuno strumento): identico.
  {
    const sette = F('0922-sette-scelte.md');
    const { done } = await run([A([T(sette)]), { type: 'result', result: sette }]);
    check(done.fullResponse === sette && done.steps.length === 0, '(6) le 7 scelte arrivano intere');
    check(/7\. Il vecchio visore/.test(done.fullResponse), '(6) fino alla settima');
  }
  // (7) Il riconoscitore da solo.
  check(perNico(F('0916-risposta-col-prompt.md')), '(7) risposta firmata col prompt');
  check(perNico('☀️ Agent 7 — Fatto.'), '(7) la firma della squadra');
  check(perNico('Scegli tu:\n- A) sopra\n- B) sotto'), '(7) un elenco');
  check(!perNico('Aspetto il timer.'), '(7) «aspetto» non è per il proprietario');
  check(!perNico('Controllo il server.'), '(7) «controllo» non è per il proprietario');
  check(!perNico(''), '(7) vuoto');
  // (8) Collaudo del proprietario 9:47: la risposta delle 9:19 era GIÀ SALVATA divisa
  // (prompt delle 9:16 nei passaggi). La chat la sistema a schermo.
  {
    const salvata = { role: 'assistant', content: F('0919-finale.md') + '\n\n' + F('0919-dopo-avviso.md'), steps: [F('0916-risposta-col-prompt.md')] };
    const r = PN.ripiega(salvata.content, salvata.steps);
    check(r.steps.length === 0, '(8) la tendina della risposta salvata si svuota');
    check(r.content.startsWith('☀️ Agent 7 — Hai ragione sulla firma') && r.content.includes('Incolla questo nella sessione del controllo:') && r.content.includes('```\nDecisioni prese:'), '(8) il prompt torna nella risposta, per primo');
    check(r.content.includes('Ho corretto la regola'), '(8) e la risposta di dopo resta');
    const r2 = PN.ripiega(r.content, r.steps);
    check(r2.content === r.content && r2.steps.length === 0, '(8) rifarlo non cambia niente');
    const corta = PN.ripiega('Fatto.', ['Controllo il server.']);
    check(corta.content === 'Fatto.' && corta.steps.length === 1, '(8) il parlare-da-solo salvato resta nella tendina');
  }
  // (9) Tutti i punti usano la stessa regola, e la chat la carica prima.
  {
    const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    check(rd('server/stream-handler.js').includes("require('../public/js/per-utente.js')"), '(9) il server usa il posto solo');
    check(/PerNico\.ripiega\(entry\.content, entry\.steps\)/.test(rd('public/js/core.js')), '(9) la cronologia (anche la copia del telefono) passa dalla regola');
    check(/PerNico\.ripiega\(_serverFull, msg\.steps\)/.test(rd('public/js/ws.js')), '(9) la risposta in diretta passa dalla regola');
    const idx = rd('public/index.html');
    check(idx.indexOf('js/per-utente.js') > -1 && idx.indexOf('js/per-utente.js') < idx.indexOf('js/core.js'), '(9) caricato prima di core.js');
    check(rd('public/sw.js').includes("'/js/per-utente.js'"), '(9) nel guscio offline');
  }
  console.log(`tendina-per-utente: ${ok} controlli verdi`);
})().catch((e) => { console.error(e); process.exit(1); });
