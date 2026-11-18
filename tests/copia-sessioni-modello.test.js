'use strict';
// : «a volte i nomi dei modelli spariscono dalle card (resta un
// trattino) e tornano solo chiudendo e riaprendo l'app». Una causa: la copia della
// lista che il telefono tiene per quando il PC tace (cacheSessionList, core.js)
// non teneva `model`; se all'apertura il PC risponde lento la lista si disegna da
// lì. Prova PURA: le due funzioni vere di core.js su un localStorage finto.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/core.js'), 'utf8');
const a = src.indexOf('function cacheSessionList(');
const b = src.indexOf('\n}', src.indexOf('function getCachedSessionList(')) + 2;
assert.ok(a > 0 && b > a, 'le due funzioni ci sono in core.js');
const mem = {};
const localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }, key: (i) => Object.keys(mem)[i], get length() { return Object.keys(mem).length; },
};
const ctx = { localStorage, console, JSON };
vm.createContext(ctx);
vm.runInContext(src.slice(a, b), ctx);
ctx.cacheSessionList([
  { id: 's1', title: 'Apps', status: 'idle', model: 'claude-opus-5-5', history: [{ text: 'x' }] },
  { id: 's2', title: 'Vecchia', status: 'idle' },
]);
const copia = ctx.getCachedSessionList();
assert.strictEqual(copia[0].model, 'claude-opus-5-5', 'la copia tiene il modello: ' + JSON.stringify(copia[0]));
assert.strictEqual(copia[1].model, null, 'senza modello: null, mai undefined');
assert.strictEqual(copia[0].history, undefined, 'la copia resta snella (niente storia)');
console.log('copia-sessioni-modello: 3 controlli verdi');
