'use strict';
// Nome del modello sulle schede e nel chip: «Opus 5.5», mai
// «Opus 5-5» («I really fucking detest that»), e senza il timbro della data.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/sessions.js'), 'utf8');
const corpo = src.slice(src.indexOf('function prettifyModelId'), src.indexOf('\n}\n', src.indexOf('function prettifyModelId')) + 2);
const ctx = {}; vm.runInNewContext(corpo, ctx);
let n = 0, rossi = 0;
for (const [id, atteso] of [
  ['claude-opus-5-5', 'Opus 5.5'], ['claude-opus-5-5[1m]', 'Opus 5.5'], ['claude-fable-5[1m]', 'Fable 5'],
  ['claude-opus-4-8', 'Opus 4.8'], ['claude-haiku-4-5-20251001', 'Haiku 4.5'], ['opus', 'Opus'],
]) {
  n++; const v = ctx.prettifyModelId(id);
  if (v === atteso) console.log('  ✓ ' + id + ' → ' + v); else { rossi++; console.log('  ✗ ' + id + ' → ' + v + ' (atteso ' + atteso + ')'); }
}
console.log(`nome-modello: ${n - rossi}/${n} verdi`);
process.exit(rossi ? 1 : 0);
