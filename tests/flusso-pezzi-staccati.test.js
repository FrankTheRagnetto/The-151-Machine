'use strict';
// [15/11/2026] Sul telefono di prova il testo in diretta incollava i pezzi divisi da uno
// strumento: «…controllo il telefono.Prova rossa sulla versione…». Prova PURA
// dello stream-handler vero: due blocchi di testo separati da uno strumento
// arrivano al telefono staccati da una riga vuota; un blocco solo resta com'è;
// il flusso dei sotto-agenti non aggiunge stacchi; un blocco che comincia già
// a capo non ne riceve un secondo.
const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const createStreamHandler = require('../server/stream-handler');
let ok = 0;
const check = (c, l) => { assert.ok(c, l); ok++; console.log('  ✓ ' + l); };

function run(lines) {
  return new Promise((resolve) => {
    const sent = [];
    const manager = new Proxy({ sessions: new Map(), finishMessage: () => {} },
      { get: (t, k) => (k in t ? t[k] : () => {}) });
    const { spawnStreamHandler } = createStreamHandler({
      manager, sendToSession: (sid, d) => sent.push(d), broadcastSessionStatus: () => {}, getPluginManager: () => null,
    });
    const proc = new EventEmitter();
    proc.stdout = new Readable({ read() {} }); proc.stderr = new Readable({ read() {} });
    spawnStreamHandler(proc, 'dddddddd-test');
    proc.stdout.push(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    setImmediate(() => { proc.emit('close', 0); resolve(sent.filter((d) => d.type === 'delta').map((d) => d.content).join('')); });
  });
}
const ev = (event, extra) => Object.assign({ type: 'stream_event', event }, extra || {});
const inizioTesto = (x) => ev({ type: 'content_block_start', content_block: { type: 'text', text: '' } }, x);
const inizioTool = (id) => ev({ type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'Bash' } });
const delta = (t, x) => ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } }, x);

(async () => {
  const due = await run([inizioTesto(), delta('Controllo il '), delta('telefono.'), inizioTool('t1'), inizioTesto(), delta('Prova rossa.')]);
  check(due === 'Controllo il telefono.\n\nProva rossa.', 'due pezzi divisi da uno strumento: staccati (' + JSON.stringify(due) + ')');
  const uno = await run([inizioTesto(), delta('Ciao '), delta('Anna.')]);
  check(uno === 'Ciao Anna.', 'un pezzo solo: invariato (' + JSON.stringify(uno) + ')');
  const sub = await run([inizioTesto(), delta('Mando un agente.'), inizioTool('t1'),
    inizioTesto({ parent_tool_use_id: 't1' }), delta('INTERNO', { parent_tool_use_id: 't1' }), inizioTesto(), delta('Fatto.')]);
  check(sub === 'Mando un agente.\n\nFatto.', 'sotto-agente: un solo stacco, il suo testo fuori (' + JSON.stringify(sub) + ')');
  const capo = await run([inizioTesto(), delta('Uno.'), inizioTool('t1'), inizioTesto(), delta('\n\nDue.')]);
  check(capo === 'Uno.\n\nDue.', 'pezzo che comincia già a capo: nessuno stacco doppio (' + JSON.stringify(capo) + ')');
  console.log(`flusso-pezzi-staccati: ${ok} controlli verdi`);
})().catch((e) => { console.error(e.message); process.exit(1); });
