'use strict';
// Le intestazioni SESSIONS e PLUGINS, e niente più barra nera in alto
//. Prima #status-bar-slot > #main-topbar portava le
// percentuali d'uso (5 ore + settimana) e «The 151 Machine». Adesso:
//   A. la barra nera non esiste più (HTML, JS, CSS);
//   B. le due barre laterali hanno la loro intestazione, della stessa famiglia;
//   C. le percentuali stanno nell'intestazione Sessions E nella riga della chat
//      (il posto del telefono, dove la barra laterale è nascosta);
//   D. sul telefono restano visibili; sul PC la riga della chat non le ripete;
//   E. la fascia di sistema Android passa alla riga della chat;
//   F. il popup degli orari si apre da ogni copia, ancorato a quella toccata,
//      sopra le barre laterali;
//   G. colori solo dal file comune nelle regole nuove;
//   H. la prova sa andare rossa sulla versione di prima.
// Puro: niente server, niente browser (le foto in Chromium e Firefox sono nel
// rapporto del Designer).
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const leggi = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const html = leggi('public/index.html');
const css = leggi('public/css/main.css');
const js = leggi('public/js/topbar.js').replace(/\r\n/g, '\n');

let rossi = 0, n = 0;
function t(nome, fn) { n++; try { fn(); console.log('  ✓ ' + nome); } catch (e) { rossi++; console.log('  ✗ ' + nome + ' — ' + e.message); } }
function ok(c, m) { if (!c) throw new Error(m); }
const senzaCommentiCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const senzaCommentiJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const senzaCommentiHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
// Le regole CSS (selettore → corpo) di un testo senza commenti, @media compresi.
function regole(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ sel: m[1].trim(), corpo: m[2] });
  return out;
}
function funzione(src, nome) {
  const i = src.indexOf('function ' + nome + '(');
  ok(i >= 0, 'funzione ' + nome + ' non trovata');
  const j = src.indexOf('\n  }\n', i);
  return src.slice(i, j + 4);
}

// ─── A. La barra nera non c'è più ──────────────────────────────────────────
function barraAssente(h, c, j) {
  const err = [];
  if (/id="status-bar-slot"/.test(senzaCommentiHtml(h))) err.push('index.html ha ancora #status-bar-slot');
  const cj = senzaCommentiJs(j);
  for (const k of ['status-bar-slot', 'main-topbar', 'tb-wordmark']) if (cj.includes(k)) err.push('topbar.js costruisce ancora ' + k);
  for (const r of regole(senzaCommentiCss(c))) if (/#status-bar-slot|#main-topbar/.test(r.sel)) err.push('main.css veste ancora ' + r.sel.split('\n').pop());
  return err;
}
t('A1 niente #status-bar-slot / #main-topbar / wordmark nella barra', () => {
  const e = barraAssente(html, css, js);
  ok(!e.length, e.join('; '));
});
t('A2 la classe device-s24 (serviva solo alla barra) non è più né scritta né letta', () => {
  ok(!/device-s24/.test(senzaCommentiJs(js)), 'topbar.js la scrive ancora');
  ok(!/device-s24/.test(senzaCommentiCss(css)), 'main.css la legge ancora');
});

// ─── B. Le due intestazioni ────────────────────────────────────────────────
t('B1 SESSIONS: #sidebar comincia con #sidebar-header.panel-header, titolo «Sessions», poi la lista', () => {
  const h = senzaCommentiHtml(html);
  const m = h.match(/<div id="sidebar">\s*<div id="sidebar-header" class="panel-header">\s*<h2 class="panel-title">Sessions<\/h2>\s*<\/div>\s*<div id="session-list">/);
  ok(m, 'struttura #sidebar > #sidebar-header (h2.panel-title Sessions) > #session-list non trovata');
});
t('B2 PLUGINS: #apps-header è della stessa famiglia (panel-header + h2.panel-title «Plugins»)', () => {
  const h = senzaCommentiHtml(html);
  ok(/<div id="apps-header" class="panel-header">/.test(h), '#apps-header senza .panel-header');
  ok(/<h2 class="panel-title">Plugins<\/h2>/.test(h), 'h2.panel-title Plugins mancante');
  // Il titolo lo cambia ui.js col nome del plugin: il selettore deve reggere.
  ok(/querySelector\('#apps-header h2'\)/.test(leggi('public/js/ui.js')), 'ui.js non trova più il titolo');
});
t('B3 una sola veste: nessuna regola per «#apps-header h2» che ridisegni il titolo a parte', () => {
  const r = regole(senzaCommentiCss(css)).filter((x) => /#apps-header h2\b/.test(x.sel));
  ok(!r.length, 'ancora ' + r.length + ' regole proprie per #apps-header h2');
  const pt = regole(senzaCommentiCss(css)).find((x) => x.sel === '.panel-title');
  ok(pt && /text-transform:\s*uppercase/.test(pt.corpo), '.panel-title non in maiuscolo (SESSIONS / PLUGINS)');
});
t('B4 le intestazioni sono alte quanto la riga della chat (la linea continua sul PC)', () => {
  const ph = regole(senzaCommentiCss(css)).find((x) => x.sel === '.panel-header');
  ok(ph && /min-height:\s*calc\(64px \+ var\(--top-inset\)\)/.test(ph.corpo), '.panel-header senza min-height 64px + inset');
  const after = regole(senzaCommentiCss(css)).find((x) => x.sel === '.panel-header::after');
  ok(after && /var\(--divider-w\)/.test(after.corpo) && /var\(--divider\)/.test(after.corpo), 'la linea non usa --divider/--divider-w come #header::after');
});

// ─── C. Le percentuali nelle intestazioni e sul telefono ───────────────────
t('C1 la pillola sta SOLO nel titolo Sessions, mai nella riga della chat', () => {
  const f = funzione(js, 'ensureUsage');
  ok(/getElementById\('sidebar-header'\)/.test(f), 'non monta nell\'intestazione Sessions');
  ok(!/getElementById\('header'\)/.test(f), 'monta ancora una copia nella riga della chat');
  ok((f.match(/buildUsage\(\)/g) || []).length === 1, 'più di una copia');
});
t('C2 pollAll e start chiamano ensureUsage (una riga ridisegnata la ritrova)', () => {
  ok(/ensureUsage\(\)/.test(funzione(js, 'pollAll')), 'pollAll non la chiama');
  ok(/ensureUsage\(\)/.test(funzione(js, 'start')), 'start non la chiama');
});
t('C3 un solo stato dipinto su tutte le copie (non possono dire numeri diversi)', () => {
  const p = funzione(js, 'paintUsage');
  ok(/querySelectorAll\('\.cc-usage'\)/.test(p), 'paintUsage non dipinge tutte le copie');
  ok(/_writeCcSegment\(el, 'session'/.test(p) && /_writeCcSegment\(el, 'weekly'/.test(p), 'mancano 5 ore o settimana');
});
t('C4 la pillola è un <button> vero (tastiera e lettore di schermo)', () => {
  const b = funzione(js, 'buildUsage');
  ok(/createElement\('button'\)/.test(b) && /type = 'button'/.test(b), 'non è un button');
  ok(/aria-label/.test(b), 'manca aria-label');
});

// ─── D. Nessuna regola per la copia tolta dalla riga della chat ────────────
t('D1 nessuna regola CSS per #header .cc-usage (la copia non esiste più)', () => {
  ok(!/#header \.cc-usage/.test(senzaCommentiCss(css)), 'ancora regole per #header .cc-usage');
});
t('D3 le percentuali hanno il colore del livello', () => {
  for (const [lv, v] of [['low', 'green'], ['mid', 'orange'], ['high', 'red']]) {
    ok(new RegExp('\\.cc-seg\\[data-level="' + lv + '"\\]\\s+\\.cc-val \\{ color: var\\(--' + v + '\\); \\}').test(css), 'livello ' + lv + ' senza var(--' + v + ')');
  }
});

// ─── E. La fascia di sistema passa alla riga della chat ────────────────────
t('E1 #header porta da sé calc(10px + var(--top-inset)) e nessuno gliela toglie', () => {
  const r = regole(senzaCommentiCss(css));
  const h = r.find((x) => x.sel === '#header');
  ok(h && /padding-top:\s*calc\(10px \+ var\(--top-inset\)\)/.test(h.corpo), '#header non pad la fascia di sistema');
  const tolte = r.filter((x) => /~\s*#header\s*$/.test(x.sel) && /padding-top/.test(x.corpo));
  ok(!tolte.length, 'una regola «… ~ #header» le toglie ancora la fascia: ' + tolte.map((x) => x.sel).join(', '));
});
t('E2 la lista delle sessioni non pad più la fascia due volte (ci pensa #sidebar-header)', () => {
  const r = regole(senzaCommentiCss(css)).find((x) => x.sel === '#session-list');
  ok(r && !/safe-area-inset-top|--top-inset/.test(r.corpo), '#session-list pad ancora la fascia');
  const ph = regole(senzaCommentiCss(css)).find((x) => x.sel === '.panel-header');
  ok(/padding-top:\s*calc\(10px \+ var\(--top-inset\)\)/.test(ph.corpo), '.panel-header non pad la fascia');
});

// ─── F. Il popup ───────────────────────────────────────────────────────────
t('F1 si apre dalla copia toccata, ancorato a lei', () => {
  ok(/toggleCcUsagePopup\(b\)/.test(funzione(js, 'buildUsage')), 'il tocco non passa la copia toccata');
  ok(/usageAnchor\(\)/.test(funzione(js, 'renderCcUsagePopup')), 'il popup non si ancora alla copia toccata');
  const d = funzione(js, 'dismissCcUsagePopup');
  ok(/closest\('\.cc-usage'\)/.test(d), 'un tocco su un\'altra copia chiuderebbe invece di spostare');
});
t('F2 resta dentro lo schermo (8px di margine, largo al massimo lo schermo)', () => {
  const r = funzione(js, 'renderCcUsagePopup');
  ok(/Math\.min\(240, window\.innerWidth - 16\)/.test(r), 'larghezza non limitata allo schermo');
  ok(/Math\.max\(8, Math\.min\(/.test(r), 'bordo sinistro non chiuso fra 8 e lo schermo');
});
t('F3 sta sopra le barre laterali (z-index > 851)', () => {
  const tok = css.match(/--z-popover:\s*(\d+)/);
  ok(tok && +tok[1] > 851, '--z-popover mancante o sotto le barre laterali');
  const p = regole(senzaCommentiCss(css)).find((x) => x.sel === '#cc-usage-popup');
  ok(p && /z-index:\s*var\(--z-popover\)/.test(p.corpo), '#cc-usage-popup non usa --z-popover');
});

// ─── G. Colori solo dal file comune ────────────────────────────────────────
t('G1 nelle regole nuove nessun colore scritto a mano', () => {
  const nuove = regole(senzaCommentiCss(css)).filter((x) => /\.panel-header|\.panel-title|\.cc-usage|#cc-usage-popup/.test(x.sel));
  ok(nuove.length >= 10, 'regole nuove non trovate (' + nuove.length + ')');
  const brutti = nuove.filter((x) => /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i.test(x.corpo));
  ok(!brutti.length, 'colori a mano in: ' + brutti.map((x) => x.sel).join(', '));
});

// ─── H. La prova sa andare rossa ───────────────────────────────────────────
t('H1 A1 boccia la versione di prima (barra nera viva)', () => {
  const vecchioHtml = '<div id="main"><div id="status-bar-slot" class="slot slot--hidden"></div>';
  const vecchioJs = "var SLOT_ID = 'status-bar-slot'; var BAR_ID = 'main-topbar'; x = '<span class=\"tb-wordmark\">The 151 Machine</span>';";
  const vecchioCss = '#status-bar-slot { padding: 2px; }\n#main-topbar .tb-wordmark { color: var(--text); }';
  ok(barraAssente(vecchioHtml, vecchioCss, vecchioJs).length >= 4, 'la prova non vede la barra di prima');
});

console.log(`\nintestazioni: ${n - rossi}/${n} verdi`);
process.exit(rossi ? 1 : 0);
