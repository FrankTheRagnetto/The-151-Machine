'use strict';
// [12/11/2026 ] «Doppione dopo un riavvio» (giro ). Il fatto, pm2-out 10/11: sessione bc99ff5d a turno in corso,
// 20:25:50 un messaggio del proprietario «1 in coda» (aiutanti vivi), 21:09:20 riavvio (deploy), 21:09:26 il boot riprende il
// turno rimandando NUDO l'ultimo messaggio del proprietario — già nella conversazione del modello: un doppione — e il messaggio
// in coda, che stava solo in memoria, non parte mai.
// LE LEGGI:
//   A. La ripresa dopo il riavvio manda lo stesso testo con una riga che dice «stesso messaggio, non nuovo, continua»;
//      applicata due volte non si raddoppia.
//   B. La coda dei messaggi del proprietario sopravvive al riavvio: salvata con le sessioni, ricaricata in coda (non nella sessione).
//   C. Il boot (index.js) usa la riga in tutte e due le strade della ripresa e non toglie più il messaggio del proprietario dalla
//      cronologia per rimandarlo; dopo le riprese, le sessioni ferme con messaggi in coda li fanno partire.
// Prova pura: SessionManager vero su una cartella temporanea, nessun CLI.
const fs = require('fs');
const os = require('os');
const path = require('path');
let ok = 0, failed = 0;
const check = (c, l) => { if (c) { ok++; console.log('  ok   ' + l); } else { failed++; console.log('  FAIL ' + l); } };
const { SessionManager } = require('../server/session-manager');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riavvio-doppione-'));
try {
  // A
  const f = SessionManager.ripresaDopoRiavvio;
  check(typeof f === 'function', 'A ripresaDopoRiavvio esiste');
  if (typeof f === 'function') {
    const r = f('ciao, guarda il manga');
    check(r !== 'ciao, guarda il manga' && r.endsWith('\n\nciao, guarda il manga') && /SAME message/.test(r) && /not a repeat/.test(r), 'A il testo del proprietario intero, con la riga «stesso messaggio» davanti');
    check(f(r) === r, 'A due volte non si raddoppia');
  }
  // B
  const store = path.join(tmp, 'sessions.json');
  const m1 = new SessionManager(store);
  const s = m1.create({ title: 'prova', workingDirectory: tmp });
  m1.queueWaitingMessage(s.id, { content: 'messaggio in coda', attachments: [{ name: 'a.png' }], nonce: 'n-1' });
  m1.saveSync();
  const salvato = JSON.parse(fs.readFileSync(store, 'utf8')).find((x) => x.id === s.id) || {};
  check(Array.isArray(salvato.attesa) && salvato.attesa.length === 1 && salvato.attesa[0].content === 'messaggio in coda', 'B la coda è nel file delle sessioni');
  const m2 = new SessionManager(store);
  if (typeof m2.load === 'function' && !m2.sessions.size) m2.load();
  const w = m2._waitingMessages.get(s.id) || [];
  check(m2.hasWaitingMessages(s.id) && w[0].content === 'messaggio in coda' && w[0].nonce === 'n-1' && w[0].attachments.length === 1, 'B dopo il riavvio il messaggio è di nuovo in coda (testo, allegato, nonce)');
  check(m2.sessions.get(s.id) && !('attesa' in m2.sessions.get(s.id)), 'B la coda non resta appesa alla sessione');
  m2.saveSync();
  const m3 = new SessionManager(store);
  if (typeof m3.load === 'function' && !m3.sessions.size) m3.load();
  check(m3.hasWaitingMessages(s.id), 'B sopravvive anche a un secondo riavvio se non è ancora partita');
  // C
  const ix = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const usi = (ix.match(/manager\.sendMessage\(id, SessionManager\.ripresaDopoRiavvio\(text\), attachments, \{ skipUserAppend: true \}\)/g) || []).length;
  check(usi === 2, 'C le due strade della ripresa mandano la riga, senza una seconda bolla (' + usi + ' su 2)');
  check(!/Pop user message — sendMessage will re-add it/.test(ix) && !/manager\.sendMessage\(id, text, attachments\)/.test(ix), 'C il messaggio del proprietario non si toglie più per rimandarlo nudo');
  check(/manager\.hasWaitingMessages\(sid\)\) manager\.deliverWaiting\(sid\)/.test(ix), 'C al boot le sessioni ferme fanno partire la loro coda');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nriavvio-doppione: ${ok} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
