// Meno risvegli a schermo acceso (10/11/2026, batteria ).
// Su un telefono vero la Machine consumava ~9%/ora di schermo: a pagina ferma bussava ~25
// volte al minuto e si svegliava ogni secondo. Qui:
//   A. topbar.js in una sandbox: in 2 minuti di giri da 5 s la pastiglia 5h/7d
//      (/api/status/claude-cli-usage) si chiede al massimo 3 volte, non 25.
//   B. I due battiti locali al secondo sono lenti: topbar-modello ≥ 3 s,
//      dettatura-riattacco ≥ 3 s.
//   C. Il telefono (OfflineBridge.java): nessuna sonda in sottofondo — la
//      guardia inPrimoPiano è in testa a sondaInSfondo, l'unica porta dei
//      callback di rete e della riprova.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const leggi = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let n = 0, rossi = 0;
const attese = [];
function t(nome, fn) {
  n++;
  const rosso = (e) => { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') attese.push(r.then(() => console.log('  ✓ ' + nome), rosso));
    else console.log('  ✓ ' + nome);
  } catch (e) { rosso(e); }
}

function topbarInSandbox() {
  let ora = 1000000;
  const battiti = {};
  const chiamate = [];
  const nulla = () => null;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date: { now: () => ora },
    localStorage: { getItem: (k) => (k === '151-terminal-token' ? 'gettone' : null), setItem() {} },
    fetch: (u) => { chiamate.push(String(u)); return Promise.resolve({ ok: true, json: () => Promise.resolve({ session_pct: 10, weekly_pct: 20 }) }); },
    document: {
      readyState: 'complete', getElementById: nulla, querySelector: nulla,
      querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    },
    Battito: { ogni: (nome, ms, fn) => { battiti[nome] = { ms, fn }; return { ferma() {} }; } },
    setTimeout: () => 1, clearTimeout() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(leggi('public/js/topbar.js'), ctx);
  return { battiti, chiamate, avanti: (ms) => { ora += ms; } };
}

console.log('battiti-lenti — meno risvegli a schermo acceso');

t('A. la pastiglia 5h/7d si chiede al massimo una volta al minuto (era ogni 5 s)', () => {
  const s = topbarInSandbox();
  const giro = s.battiti['topbar-poll'];
  assert.ok(giro, 'topbar-poll registrato sul battito');
  for (let i = 0; i < 24; i++) { giro.fn(); s.avanti(giro.ms); } // 2 minuti
  const cc = s.chiamate.filter((u) => u.includes('/api/status/claude-cli-usage')).length;
  assert.ok(cc >= 1 && cc <= 3, 'claude-cli-usage in 2 minuti: ' + cc + ' (prima 24)');
});

t('B. i battiti locali non svegliano più la pagina ogni secondo', () => {
  const s = topbarInSandbox();
  assert.ok(s.battiti['topbar-modello'] && s.battiti['topbar-modello'].ms >= 3000, 'topbar-modello: ' + (s.battiti['topbar-modello'] || {}).ms);
  const m = leggi('public/js/dictation.js').match(/Battito\.ogni\('dettatura-riattacco',\s*(\d+)/);
  assert.ok(m && Number(m[1]) >= 3000, 'dettatura-riattacco: ' + (m && m[1]));
});

t('C. il telefono non sonda il PC con l\'app in sottofondo', () => {
  const src = leggi('app/android/app/src/main/java/com/the151universe/machine/OfflineBridge.java');
  const corpo = (src.match(/private void sondaInSfondo\(\) \{([\s\S]*?)\n {4}\}/) || [])[1] || '';
  const codice = corpo.replace(/\/\/[^\n]*/g, '').trim();
  assert.ok(/^if \(!inPrimoPiano\) return;/.test(codice), 'la prima istruzione di sondaInSfondo deve essere la guardia: ' + codice.slice(0, 80));
  // Le porte d'ingresso passano tutte di lì.
  assert.ok(/onAvailable\(Network n\) \{ sondaInSfondo\(\); \}/.test(src) && /onLost\(Network n\) \{ sondaInSfondo\(\); \}/.test(src));
  assert.ok(/postDelayed\(this::sondaInSfondo, RIPROVA_MS\)/.test(src));
  // Al ritorno si rimette in primo piano PRIMA di sondare.
  assert.ok(/void onResume\(\) \{ inPrimoPiano = true;[^}]*sondaInSfondo\(\); \}/.test(src), 'onResume: primo piano, poi sonda');
});

Promise.all(attese).then(() => {
  console.log(`\n${n - rossi}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
});
