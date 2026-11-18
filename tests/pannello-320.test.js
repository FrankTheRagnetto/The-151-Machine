'use strict';
// [07/11/2026] Le prove del Terminal sono uscite col plugin (ora «!» in chat,
// tests/comando-chat.test.js).
// Il pannello App resta largo 320px: sono i plugin a starci
// dentro, senza testo tagliato e senza scorrimento di lato. Prima il Terminal
// teneva le colonne (white-space:pre) e scorreva di lato, la cronologia finiva
// in «…», e in Updates le versioni lunghe uscivano dal pannello. Puro: niente
// server, niente browser (la misura vera in Chromium e Firefox è nel rapporto).
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const upd = fs.readFileSync(path.join(R, 'plugins', 'updates', 'client.js'), 'utf8');
let rossi = 0, n = 0;
function t(nome, fn) { n++; try { fn(); console.log('  ✓ ' + nome); } catch (e) { rossi++; console.log('  ✗ ' + nome + ' — ' + e.message); } }
function regola(src, sel) {
  const i = src.indexOf("'" + sel + '{');
  if (i < 0) throw new Error('regola ' + sel + ' non trovata');
  return src.slice(i, src.indexOf('}', i) + 1);
}
function ok(c, m) { if (!c) throw new Error(m); }

t('Updates: le versioni lunghe vanno a capo dentro il pannello', () => {
  ok(/overflow-x:hidden/.test(regola(upd, '.upd-list')), 'la lista scorre ancora di lato');
  ok(/flex-wrap:wrap/.test(regola(upd, '.upd-list li')), 'la riga non va a capo');
  const v = regola(upd, '.upd-list .v');
  ok(/flex:0 1 auto/.test(v) && /min-width:0/.test(v), 'la versione non si può stringere');
});

console.log(`\npannello-320: ${n - rossi}/${n} verdi`);
process.exit(rossi ? 1 : 0);
