'use strict';
// [08/11/2026] (2) — «riaprendo la chat vedo il mio !ls e poi NIENTE»
//. La storia sul disco era
// intera (user «!ls», comando «PC», assistant), ma il telefono si fermava al
// «!ls». Causa provata in Chromium vero sulla pagina servita:
//   appendMessage('comando', …) → TypeError «Cannot read properties of null
//   (reading 'body')»: copyText leggeva _optParts.body, che esiste solo per
//   le risposte di Claude.
// Il messaggio «PC» non nasceva MAI (né dal vivo né dalla storia), e
// renderHistoryMessages si fermava lì: tutto quel che veniva dopo spariva.
// Prova PURA: il vero public/js/chat.js e il vero renderHistoryMessages di
// core.js in una vm, con un DOM finto minimo.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let ok = 0; const falliti = [];
function check(c, l) { if (c) { ok++; console.log('  ok  ' + l); } else { falliti.push(l); console.log('  NO  ' + l); } }

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.parentNode = null; this.dataset = {}; this.style = {
      setProperty() {}, removeProperty() {} };
    this._attrs = {}; this.className = ''; this._html = ''; this.textContent = '';
    const self = this;
    this.classList = {
      add(...c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove(...c) { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains(c) { return self.className.split(/\s+/).includes(c); },
      toggle() {},
    };
  }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get firstChild() { return this.children[0] || null; }
  get previousElementSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) - 1] || null; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; }
  addEventListener() {}
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  querySelector() { return new El('div'); } // un figlio qualsiasi: basta che esista
  querySelectorAll(sel) {
    const all = []; const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } }; walk(this);
    if (/\.message/.test(sel)) return all.filter((n) => n.classList.contains('message'));
    return [];
  }
}

function carica() {
  const messagesEl = new El('div');
  const document = {
    createElement: (t) => new El(t), getElementById: () => new El('div'),
    body: new El('body'), documentElement: new El('html'),
    querySelector: () => null, querySelectorAll: () => [],
  };
  const window = {
    messagesEl, sessions: [], activeSessionId: 's1',
    PezzoBottoni: require('../public/js/pezzo-bottoni.js'),
    computeMsgKey: (m) => m.role + ':' + String(m.content).length,
    requestAnimationFrame: (f) => f(), addEventListener() {}, matchMedia: () => ({ matches: false }),
    visualViewport: null,
  };
  const ctx = {
    window, document, messagesEl, console, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { clipboard: null }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    DOMPurify: { sanitize: (s) => s }, marked: { parse: (s) => String(s) },
    requestAnimationFrame: (f) => f(), escapeHtml: (s) => String(s), autoScroll: true,
  };
  ctx.window.window = ctx.window; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Le globali di window sono globali anche nella pagina: le copio sul contesto.
  for (const k of Object.keys(window)) ctx[k] = window[k];
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/chat.js'), 'utf8'), ctx, { filename: 'chat.js' });
  for (const k of Object.keys(ctx.window)) if (!(k in ctx)) ctx[k] = ctx.window[k];
  // renderHistoryMessages vero, preso da core.js (solo la funzione).
  const core = fs.readFileSync(path.join(__dirname, '..', 'public/js/core.js'), 'utf8');
  const i = core.indexOf('function renderHistoryMessages(');
  const j = core.indexOf('window.renderHistoryMessages = renderHistoryMessages;', i);
  assert.ok(i > 0 && j > i, 'renderHistoryMessages trovata in core.js');
  vm.runInContext(core.slice(i, j) + '\nwindow.renderHistoryMessages = renderHistoryMessages;', ctx, { filename: 'core.js#renderHistoryMessages' });
  return ctx;
}

const ctx = carica();
const W = ctx.window;

// (A) Il messaggio «PC» nasce (dal vivo: ws.js comando_esito → appendMessage)
{
  const prima = ctx.messagesEl.children.length;
  let errore = null;
  try { W.appendMessage('comando', '**$ ls** · done · 0.2 s\n\n```text\napp\n```', Date.now(), true); } catch (e) { errore = e.message; }
  check(!errore, '(A) appendMessage(«comando») non lancia' + (errore ? ': ' + errore : ''));
  const el = ctx.messagesEl.lastElementChild;
  check(ctx.messagesEl.children.length === prima + 1 && el && el.classList.contains('comando'), '(A) la bolla «PC» è nella chat');
}

// (B) Riaprendo la chat: la storia VERA della sessione Apps 12fea0c2 (13:24) --
{
  const storia = [
    { role: 'user', content: '/apps Salva la riparazione', timestamp: 1794140004010 },
    { role: 'assistant', content: 'Ho salvato e pubblicato la riparazione.', tools: ['Bash'], timestamp: 1794140301684 },
    { role: 'user', content: '!ls', timestamp: 1794140645268 },
    { role: 'comando', content: '**$ ls** · done · 0.2 s\n\n```text\nACCEPTABLE_USE.md\n```', code: 0, timestamp: 1794140645463 },
    { role: 'assistant', content: 'Il comando ha funzionato: `ls` ha mostrato le cartelle.', tools: ['Bash'], timestamp: 1794140661744 },
  ];
  let errore = null;
  try { W.renderHistoryMessages(storia, false); } catch (e) { errore = e.message; }
  check(!errore, '(B) la storia si disegna senza errori' + (errore ? ': ' + errore : ''));
  const bolle = ctx.messagesEl.children.filter((n) => n.classList.contains('message'));
  const ruoli = bolle.map((n) => n.className.replace('message ', '').split(' ')[0]);
  check(JSON.stringify(ruoli) === JSON.stringify(['user', 'assistant', 'user', 'comando', 'assistant']),
    '(B) tutte e cinque le bolle, in ordine: ' + JSON.stringify(ruoli));
  const ultima = bolle[bolle.length - 1];
  check(!!ultima && /Il comando ha funzionato/.test(ultima.children.map((c) => c.innerHTML).join('')),
    '(B) la risposta di Claude dopo il comando c\'è');
}

// (C) — UNA voce che non si disegna non deve portarsi via le seguenti.
// Prova in Chromium vero (pagina servita, chat.js di HEAD 3211a92): il tocco
// sulla card di una sessione con un messaggio «PC» lanciava dentro
// switchSession PRIMA del join → activeSessionId cambiato, socket ancora
// sull'altra sessione, menu aperto (1° tocco «non fa niente»), 2° tocco = no-op
// che chiude il menu, e get_stream_state → «not joined to session».
// Qualunque voce futura che lanci deve restare un buco di UNA bolla.
{
  const vera = W.appendMessage;
  ctx.appendMessage = W.appendMessage = function (role) {
    if (role === 'rotta') throw new Error('voce rotta di prova');
    return vera.apply(this, arguments);
  };
  let errore = null;
  const err = console.error; console.error = () => {};
  try {
    W.renderHistoryMessages([
      { role: 'user', content: 'prima', timestamp: 1 },
      { role: 'rotta', content: 'x', timestamp: 2 },
      { role: 'assistant', content: 'dopo la voce rotta', timestamp: 3 },
    ], false);
  } catch (e) { errore = e.message; } finally { console.error = err; ctx.appendMessage = W.appendMessage = vera; }
  check(!errore, '(C) renderHistoryMessages non lancia per una voce rotta' + (errore ? ': ' + errore : ''));
  const ruoli = ctx.messagesEl.children.filter((n) => n.classList.contains('message')).map((n) => n.className.replace('message ', '').split(' ')[0]);
  check(JSON.stringify(ruoli) === JSON.stringify(['user', 'assistant']), '(C) le bolle dopo la voce rotta ci sono: ' + JSON.stringify(ruoli));
}

if (falliti.length) { console.error(`bolla-pc: ${falliti.length} FALLITI, ${ok} OK`); process.exit(1); }
console.log(`bolla-pc: ${ok} controlli OK`);
