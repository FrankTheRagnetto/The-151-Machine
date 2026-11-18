#!/usr/bin/env node
'use strict';
// [17/10/2026] il proprietario: il riavvio della Machine diventa una voce in fondo al
// pannello dei plugin, «Restart machine»: la tocchi, chiede «sei sicuro?» come
// oggi, riavvia — per la STESSA strada sicura di prima (POST
// /api/ecosystem-restart → tools/deploy.sh --force sul server). Prima stava
// nella pressione lunga della freccina in alto, che poi il proprietario ha tolto del tutto.
// Prova pura: il codice vero di ui.js e sessions.js in una sandbox vm.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const blocco = (n, fn) => Promise.resolve().then(fn).catch((e) => { fail++; console.log('  FAIL ' + n + ' — lancia: ' + e.message); });

const ui = rd('public/js/ui.js');
const ses = rd('public/js/sessions.js');
const html = rd('public/index.html');
const core = rd('public/js/core.js');
const tra = (src, da, a) => { const i = src.indexOf(da); if (i < 0) return ''; const j = src.indexOf(a, i); return j < 0 ? '' : src.slice(i, j + a.length); };

(async () => {
  // ---- A: la voce sta in fondo al pannello ----
  await blocco('A', () => {
    const gruppi = tra(ui, 'var APP_GROUPS = [', '\n];');
    const ctx = { IC: new Proxy({}, { get: (_, k) => '<svg data-ic="' + String(k) + '"></svg>' }) };
    vm.createContext(ctx);
    vm.runInContext(gruppi + '\nthis.G = APP_GROUPS;', ctx);
    const ultimo = ctx.G[ctx.G.length - 1].items.slice(-1)[0] || {};
    ok(ultimo.label === 'Restart machine', 'A. l\'ultima voce del pannello è «Restart machine»');
    ok(ultimo.kind === 'action' && ultimo.action === 'restartMachine', 'A. è un\'azione (nessun plugin da accendere, nessun riavvio per averla)');
    ok(/data-ic="power"/.test(ultimo.icon || ''), 'A. ha l\'icona di accensione');
    ok(/power:\s*s\(/.test(core), 'A. l\'icona esiste in core.js (IC.power)');
  });

  // ---- B: toccarla chiama il riavvio di sempre ----
  await blocco('B', async () => {
    const run = tra(ui, 'async function runAppItem(item) {', '\n}\n');
    let chiuso = 0, riavvii = 0;
    const ctx = { window: { ecosystemRestart: () => { riavvii++; } }, closeAppsPanel: () => { chiuso++; },
      openApp() {}, api: async () => ({}), showToast() {}, showReportModal() {} };
    vm.createContext(ctx);
    vm.runInContext(run, ctx);
    await ctx.runAppItem({ kind: 'action', action: 'restartMachine' });
    ok(riavvii === 1, 'B. la voce chiama window.ecosystemRestart');
    ok(chiuso === 1, 'B. e chiude il pannello (la conferma si vede sopra l\'app)');
  });

  // ---- C: la strada sicura: conferma, poi POST /ecosystem-restart ----
  await blocco('C', async () => {
    const fn = tra(ses, 'async function _ecosystemRestart(btn) {', '\n}\n');
    const expose = tra(ses, 'window.ecosystemRestart = function', '};');
    ok(!!expose, 'C. sessions.js espone window.ecosystemRestart');
    const prova = async (si) => {
      const chiamate = [];
      const domande = [];
      const ctx = { window: { UI: { confirm: async (m, o) => { domande.push([m, o]); return si; } }, api: async (met, p) => { chiamate.push(met + ' ' + p); return { ok: true }; }, showToast() {} },
        _ecosystemRestartOverlay() { chiamate.push('overlay'); }, console };
      ctx.window.window = ctx.window;
      vm.createContext(ctx);
      vm.runInContext(fn + '\n' + expose, ctx);
      await ctx.window.ecosystemRestart();
      return { chiamate, domande };
    };
    const no = await prova(false);
    ok(no.domande.length === 1 && /Restart EVERYTHING\?/.test(no.domande[0][0]), 'C. chiede «sei sicuro?» come oggi');
    ok(no.chiamate.length === 0, 'C. risposta no → non riavvia niente');
    const si = await prova(true);
    ok(si.chiamate[0] === 'POST /ecosystem-restart' && si.chiamate[1] === 'overlay', 'C. risposta sì → POST /ecosystem-restart e schermata di riavvio');
  });

  // ---- D: la freccina in alto non c'è più ----
  await blocco('D', () => {
    const css = rd('public/css/main.css');
    const ws = rd('public/js/ws.js');
    const sw = rd('public/sw.js');
    ok(!/id="retitle-btn"/.test(html), 'D. index.html: niente freccina in alto');
    ok(!/retitle|_retitleHardReload|_raceTimeout/i.test(ses), 'D. sessions.js: niente codice della freccina');
    ok(!/#retitle-btn|retitleSpin/.test(css), 'D. main.css: niente stile della freccina');
    ok(!/finishRetitle/.test(ws), 'D. ws.js: niente richiamo alla freccina');
    ok(!/type === 'CLEAR'/.test(sw), 'D. sw.js: niente messaggio CLEAR (lo mandava solo la freccina)');
  });

  console.log(`\nriavvio-plugin: ${pass} verdi, ${fail} rossi`);
  process.exit(fail ? 1 : 0);
})();
