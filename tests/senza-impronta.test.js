// L'impronta della Machine sparisce «once and for all».
//
// Prima: nell'app Android (Capacitor) biometric.js nascondeva #app appena
// caricato e lo teneva dietro uno schermo «Authentication required» finché
// l'impronta non passava; lo rifaceva a ogni ritorno dallo sfondo. Sul telefono
// di prova (senza impronta né codice) l'app restava ferma lì. In più auth.js
// offriva «Set Up Fingerprint», salvava la parola nel Keystore e mostrava il
// tasto dell'impronta sulla pagina d'accesso.
//
// Adesso: si entra senza impronta (e dal 12/11 anche senza parola),
// poi l'app resta aperta come nel browser del PC.
//
// La prova gira TUTTI gli script locali che public/index.html carica, nel loro
// ordine, in un telefono finto (Capacitor.isNativePlatform() === true, con un
// plugin NativeBiometric che registra chi lo cerca) e controlla:
//   A. con un gettone valido l'app si mostra diretta: niente schermo di blocco,
//      #app mai nascosto, pagina d'accesso nascosta, NativeBiometric mai chiesto;
//   B. pausa → ripresa (pause/resume e appStateChange): ancora nessun blocco;
//   C. senza gettone, il gettone arriva DA SOLO (dal 12/11/2026: niente
//      più parola, il muro server/solo-tailnet.js decide chi entra): gettone
//      nuovo salvato, pagina d'accesso via, nessuna offerta d'impronta,
//      NativeBiometric mai chiesto; con un 403 la pagina dice «Not on your
//      Tailscale»;
//   D. nella pagina non restano il tasto dell'impronta né l'offerta;
//   E. né la casella della parola.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const SCRIPT = [...HTML.matchAll(/<script\s+src="(js\/[^"]+)"/g)].map((m) => m[1]);

let n = 0, rossi = 0;
async function t(nome, fn) {
  n++;
  try { await fn(); console.log('  ✓ ' + nome); }
  catch (e) { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); }
}

// ── Un telefono finto ────────────────────────────────────────────────────────
function telefono({ gettone, loginStatus = 200 }) {
  const tracce = { bio: [], fogliStile: [], creati: [], errori: [], ascolto: {} };
  const elementi = new Map();

  function nuovoEl(id, tag) {
    const classi = new Set();
    const el = {
      id: id || '', tagName: (tag || 'div').toUpperCase(), nodeType: 1,
      style: { setProperty() {}, removeProperty() {} }, dataset: {},
      textContent: '', innerHTML: '', innerText: '', value: '', placeholder: '', disabled: false,
      children: [], childNodes: [], parentNode: null, offsetParent: null,
      scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, offsetWidth: 0,
      classList: {
        add: (...c) => c.forEach((x) => classi.add(x)), remove: (...c) => c.forEach((x) => classi.delete(x)),
        contains: (c) => classi.has(c), toggle: (c, si) => { const v = si === undefined ? !classi.has(c) : !!si; if (v) classi.add(c); else classi.delete(c); return v; },
      },
      get className() { return [...classi].join(' '); }, set className(v) { classi.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => classi.add(x)); },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute(k, v) { this['@' + k] = v; }, getAttribute(k) { return this['@' + k] == null ? null : this['@' + k]; },
      removeAttribute(k) { delete this['@' + k]; }, hasAttribute(k) { return this['@' + k] != null; },
      appendChild(c) { c.parentNode = el; el.children.push(c); tracce.creati.push(c); if (c.id) elementi.set(c.id, c); return c; },
      insertBefore(c) { return el.appendChild(c); }, prepend(c) { el.appendChild(c); }, append(c) { if (c && typeof c === 'object') el.appendChild(c); },
      removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); if (el.id) elementi.delete(el.id); },
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      focus() {}, blur() {}, click() {}, scrollIntoView() {}, scrollTo() {}, select() {},
      animate: () => ({ finished: Promise.resolve(), cancel() {} }),
      insertAdjacentHTML() {}, insertAdjacentElement() {}, cloneNode() { return nuovoEl('', tag); },
    };
    return el;
  }
  const el = (id) => { if (!elementi.has(id)) elementi.set(id, nuovoEl(id)); return elementi.get(id); };

  const head = nuovoEl('', 'head');
  head.appendChild = (c) => { tracce.fogliStile.push(c); if (c.id) elementi.set(c.id, c); c.parentNode = head; return c; };
  head.removeChild = (c) => { tracce.fogliStile = tracce.fogliStile.filter((x) => x !== c); if (c.id) elementi.delete(c.id); return c; };
  const body = nuovoEl('', 'body');
  const docEl = nuovoEl('', 'html');
  docEl.appendChild = head.appendChild;

  const documento = {
    readyState: 'complete', head, body, documentElement: docEl, visibilityState: 'visible', hidden: false,
    cookie: '', title: '',
    getElementById: (id) => {
      // Gli elementi creati da script esistono solo dopo appendChild.
      if (elementi.has(id)) return elementi.get(id);
      if (/^bio-lock/.test(id)) return null;
      return el(id);
    },
    createElement: (tag) => { const e = nuovoEl('', tag); tracce.creati.push(e); return e; },
    createElementNS: (ns, tag) => nuovoEl('', tag),
    createTextNode: (s) => ({ nodeType: 3, textContent: s }),
    createDocumentFragment: () => nuovoEl('', 'fragment'),
    querySelector: (sel) => (/^#[\w-]+$/.test(sel) ? documento.getElementById(sel.slice(1)) : null),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    hasFocus: () => true, activeElement: null,
  };

  // NativeBiometric: chi lo cerca, anche solo per vedere se c'è, lascia traccia.
  const bioVero = {
    isAvailable: () => Promise.resolve({ isAvailable: true }),
    verifyIdentity: () => new Promise(() => {}),           // il dito non arriva mai
    getCredentials: () => Promise.reject(new Error('no credentials')),
    setCredentials: () => Promise.resolve(),
    deleteCredentials: () => Promise.resolve(),
  };
  const bio = new Proxy(bioVero, { get(o, k) { tracce.bio.push('NativeBiometric.' + String(k)); return o[k]; } });
  const App = {
    addListener(nome, fn) { (tracce.ascolto[nome] = tracce.ascolto[nome] || []).push(fn); return Promise.resolve({ remove() {} }); },
    getInfo: () => Promise.resolve({ version: '0' }),
  };
  const pluginVeri = { App, NativeBiometric: bio };
  const Plugins = new Proxy(pluginVeri, {
    get(o, k) {
      if (k === 'NativeBiometric') tracce.bio.push('Plugins.NativeBiometric');
      if (k in o) return o[k];
      return new Proxy({}, { get: (_, m) => (m === 'then' ? undefined : () => Promise.resolve({})) });
    },
    has(o, k) { if (k === 'NativeBiometric') tracce.bio.push('Plugins.NativeBiometric'); return k in o; },
  });
  const Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins, registerPlugin: () => ({}) };

  const memoria = new Map([['151-server-url', 'http://pc.finto:3170']]);
  if (gettone) memoria.set('151-terminal-token', gettone);
  const localStorage = {
    getItem: (k) => (memoria.has(k) ? memoria.get(k) : null), setItem: (k, v) => memoria.set(k, String(v)),
    removeItem: (k) => memoria.delete(k), clear: () => memoria.clear(), key: (i) => [...memoria.keys()][i] || null,
    get length() { return memoria.size; },
  };

  // Orologio finto: i timer girano solo quando la prova avanza il tempo.
  let ora = 0, seq = 0;
  const timer = new Map();
  const metti = (fn, ms, ripeti) => { const id = ++seq; timer.set(id, { fn, at: ora + Math.max(0, +ms || 0), ms: Math.max(1, +ms || 0), ripeti }); return id; };
  const togli = (id) => timer.delete(id);

  const risposta = (status, corpo) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null },
    json: () => Promise.resolve(corpo), text: () => Promise.resolve(JSON.stringify(corpo)),
    clone() { return risposta(status, corpo); },
  });
  const chiamate = [];
  const fetchFinto = (url, opz) => {
    const u = String(url);
    chiamate.push({ u, opz });
    if (/\/api\/health/.test(u)) return Promise.resolve(risposta(200, { ok: true, configured: true }));
    if (/\/api\/login/.test(u)) return Promise.resolve(loginStatus === 200 ? risposta(200, { token: 'gettone-nuovo' }) : risposta(loginStatus, { error: 'Not on your Tailscale' }));
    if (/\/api\/sessions/.test(u)) return Promise.resolve(risposta(200, []));
    return Promise.resolve(risposta(200, {}));
  };

  const finestra = {
    document: documento, localStorage, sessionStorage: localStorage, Capacitor,
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => metti(fn, ms, false), clearTimeout: togli,
    setInterval: (fn, ms) => metti(fn, ms, true), clearInterval: togli,
    requestAnimationFrame: (fn) => metti(fn, 16, false), cancelAnimationFrame: togli,
    requestIdleCallback: (fn) => metti(fn, 1, false), cancelIdleCallback: togli,
    queueMicrotask, Promise, fetch: fetchFinto,
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, Date, Math, JSON,
    location: { origin: 'http://pc.finto:3170', href: 'http://pc.finto:3170/', protocol: 'http:', host: 'pc.finto:3170', hostname: 'pc.finto', pathname: '/', search: '', hash: '', reload() {} },
    navigator: { userAgent: 'Android finto', onLine: true, serviceWorker: undefined, vibrate() {}, clipboard: { writeText: () => Promise.resolve() } },
    history: { pushState() {}, replaceState() {}, back() {} },
    screen: { width: 400, height: 800 }, innerWidth: 400, innerHeight: 800, devicePixelRatio: 2,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    WebSocket: function () { return { send() {}, close() {}, readyState: 0, addEventListener() {} }; },
    Notification: undefined, indexedDB: undefined,
    marked: { parse: (s) => s, setOptions() {}, use() {} }, DOMPurify: { sanitize: (s) => s, addHook() {} },
    hljs: { highlightElement() {}, highlight: () => ({ value: '' }) },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    ResizeObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    IntersectionObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    Event: function (tipo) { this.type = tipo; }, CustomEvent: function (tipo, o) { this.type = tipo; this.detail = o && o.detail; },
    open: () => null, alert() {}, confirm: () => false, prompt: () => null,
  };
  finestra.window = finestra; finestra.self = finestra; finestra.globalThis = finestra;
  vm.createContext(finestra);

  for (const rel of SCRIPT) {
    const f = path.join(PUB, rel);
    if (!fs.existsSync(f)) continue;
    try { vm.runInContext(fs.readFileSync(f, 'utf8'), finestra, { filename: rel }); }
    catch (e) { tracce.errori.push(rel + ': ' + (e && e.message)); }
  }

  const microtask = () => new Promise((r) => setImmediate(r));
  async function avanza(ms) {
    const fine = ora + ms;
    for (let giri = 0; giri < 5000; giri++) {
      for (let i = 0; i < 5; i++) await microtask();
      let prossimo = null;
      for (const [id, x] of timer) if (x.at <= fine && (!prossimo || x.at < prossimo[1].at)) prossimo = [id, x];
      if (!prossimo) break;
      const [id, x] = prossimo;
      ora = Math.max(ora, x.at);
      if (x.ripeti) x.at = ora + x.ms; else timer.delete(id);
      try { x.fn(); } catch (e) { tracce.errori.push('timer: ' + (e && e.message)); }
    }
    ora = fine;
    for (let i = 0; i < 5; i++) await microtask();
  }
  function lancia(nome, arg) { for (const fn of tracce.ascolto[nome] || []) { try { fn(arg); } catch (e) { tracce.errori.push(nome + ': ' + e.message); } } }

  // «Bloccato» = un foglio di stile che nasconde #app, o lo schermo bio-lock visibile.
  function blocco() {
    const nasconde = tracce.fogliStile.filter((s) => /#app\s*\{[^}]*display\s*:\s*none/.test(s.textContent || ''));
    const schermo = tracce.creati.filter((e) => e.id === 'bio-lock' && !e.classList.contains('bio-lock-hidden') && e.parentNode);
    const r = [];
    if (nasconde.length) r.push('foglio che nasconde #app (' + (nasconde[0].id || 'senza id') + ')');
    if (schermo.length) r.push('schermo #bio-lock a vista');
    return r;
  }
  return { finestra, tracce, memoria, el, avanza, lancia, blocco, chiamate };
}

(async () => {
  // A + B: avvio con gettone valido, poi sfondo e ritorno.
  const A = telefono({ gettone: 'gettone-valido' });
  await A.avanza(30000);

  await t('A1 avvio nativo con gettone: nessun blocco a schermo', () => {
    assert.deepStrictEqual(A.blocco(), [], 'bloccato: ' + A.blocco().join(', '));
  });
  await t('A2 avvio nativo con gettone: entra diretto, la pagina d\'accesso resta nascosta', () => {
    assert.ok(A.chiamate.some((c) => /\/api\/sessions/.test(c.u)), 'init.js non ha nemmeno provato il gettone (errori: ' + A.tracce.errori.join(' | ') + ')');
    assert.ok(A.el('login-overlay').classList.contains('hidden'), 'la pagina della password è a vista');
    assert.strictEqual(A.memoria.get('151-terminal-token'), 'gettone-valido');
  });
  await t('A3 avvio nativo con gettone: NativeBiometric mai chiesto', () => {
    assert.deepStrictEqual([...new Set(A.tracce.bio)], []);
  });

  A.lancia('pause');
  A.lancia('appStateChange', { isActive: false });
  await A.avanza(60000);
  A.lancia('appStateChange', { isActive: true });
  A.lancia('resume');
  await A.avanza(30000);

  await t('B1 ritorno dallo sfondo (pause → resume): nessun blocco', () => {
    assert.deepStrictEqual(A.blocco(), [], 'bloccato: ' + A.blocco().join(', '));
    assert.ok(A.el('login-overlay').classList.contains('hidden'), 'la pagina della password è tornata');
  });
  await t('B2 ritorno dallo sfondo: NativeBiometric mai chiesto', () => {
    assert.deepStrictEqual([...new Set(A.tracce.bio)], []);
  });

  // C: senza gettone nessuno scrive niente: il gettone lo chiede l'avvio
  // (dal 12/11/2026: niente più parola, decide il muro del server).
  const C = telefono({ gettone: null });
  await C.avanza(20000);
  await t('C1 senza gettone: il gettone arriva da solo (POST /api/login senza password, niente /api/setup)', () => {
    const login = C.chiamate.filter((c) => /\/api\/login/.test(c.u));
    assert.ok(login.length >= 1, 'l\'avvio non ha chiesto il gettone (errori: ' + C.tracce.errori.join(' | ') + ')');
    assert.ok(!/password/.test(String(login[0].opz && login[0].opz.body)), 'la richiesta porta ancora una password');
    assert.ok(!C.chiamate.some((c) => /\/api\/setup/.test(c.u)), 'chiama ancora /api/setup');
  });
  await t('C2 gettone nuovo salvato, pagina d\'accesso via, nessun blocco', () => {
    assert.strictEqual(C.memoria.get('151-terminal-token'), 'gettone-nuovo');
    assert.ok(C.el('login-overlay').classList.contains('hidden'), 'la pagina d\'accesso è rimasta');
    assert.deepStrictEqual(C.blocco(), [], 'bloccato: ' + C.blocco().join(', '));
  });
  await t('C3 dopo il gettone: nessuna offerta d\'impronta, NativeBiometric mai chiesto', () => {
    assert.ok(!C.memoria.has('151-biometric-offered'), 'segno «impronta offerta» scritto');
    assert.deepStrictEqual([...new Set(C.tracce.bio)], []);
  });

  // C4: fuori dal Tailscale il server dice 403 → solo il messaggio, nessun gettone.
  const R = telefono({ gettone: null, loginStatus: 403 });
  await R.avanza(20000);
  await t('C4 server che rifiuta (403): «Not on your Tailscale», pagina a vista, nessun gettone', () => {
    assert.strictEqual(R.el('login-error').textContent, 'Not on your Tailscale');
    assert.ok(!R.el('login-overlay').classList.contains('hidden'), 'la pagina col messaggio deve essere a vista');
    assert.ok(!R.memoria.has('151-terminal-token'), 'un gettone è stato salvato lo stesso');
  });

  await t('E la pagina non ha più la casella della parola', () => {
    assert.ok(!/type="password"|id="login-input"/.test(HTML), 'index.html ha ancora la casella della parola');
  });

  await t('D la pagina non ha più tasto dell\'impronta, offerta né biometric.js', () => {
    assert.ok(!/fingerprint-btn|fingerprint-wrapper|biometric-setup|enable-biometric-btn|js\/biometric\.js/.test(HTML),
      'index.html parla ancora d\'impronta');
    assert.ok(!fs.existsSync(path.join(PUB, 'js/biometric.js')), 'public/js/biometric.js esiste ancora');
  });

  const inciampi = [...new Set([...A.tracce.errori, ...C.tracce.errori, ...R.tracce.errori])];
  if (inciampi.length) console.log('  (nota: nel telefono finto ' + inciampi.length + ' inciampi fuori prova: ' + inciampi.slice(0, 4).join(' | ') + ')');
  console.log(`\n${n - rossi}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
})();
