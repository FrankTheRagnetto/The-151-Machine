'use strict';
// public/js/origin-badge.js deve partire senza errori (12/10/2026: la pulizia
// tolse render() ma boot() lo chiamava ancora → «render is not defined» a ogni
// avvio, riga rossa sulla schermata d'avvio). Puro: niente server, niente browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'origin-badge.js'), 'utf8');
let rossi = 0, n = 0;
function t(nome, fn) { n++; try { fn(); console.log('  ✓ ' + nome); } catch (e) { rossi++; console.log('  ✗ ' + nome + ' — ' + e.message); } }
function prova(readyState) {
  const ascoltatori = [];
  const document = {
    readyState, head: { appendChild() {} }, documentElement: { appendChild() {} }, body: { appendChild() {} },
    getElementById() { return null; }, createElement() { return { style: {}, addEventListener() {}, appendChild() {} }; },
    addEventListener(tipo, fn) { ascoltatori.push(fn); },
  };
  const window = { location: { origin: 'http://x', href: 'http://x/' } };
  const ctx = { window, document, location: window.location, console, URL };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ascoltatori.forEach((fn) => fn());
  return window;
}
t('si carica a pagina già pronta senza errori', () => prova('complete'));
t('si carica durante il caricamento senza errori (DOMContentLoaded)', () => prova('loading'));
t('espone ancora il pannello e la sonda', () => {
  const w = prova('complete');
  if (typeof w.showOriginPanel !== 'function' || typeof w.beaconOrigins !== 'function') throw new Error('mancano showOriginPanel/beaconOrigins');
});
console.log(rossi ? `ROSSO — ${rossi}/${n} controlli falliti.` : `VERDE — ${n} controlli passati.`);
process.exit(rossi ? 1 : 0);
