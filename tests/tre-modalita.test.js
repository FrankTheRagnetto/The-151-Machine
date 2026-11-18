// Le modalità del telefono (2026-10-07, rifatte dopo la prova del proprietario; dal
// 12/10/2026 sono due: SOLO PI è tolta con la Machine sul Pi).
// UN'INTERFACCIA SOLA, sempre la Machine (dal 16/10 senza pillole «pc»/«pi»).
//   PIENA   — tutto.
//   OFFLINE — il telefono serve la STESSA app dalla copia
//             nell'APK allo stesso indirizzo; tutto grigio, con una riga
//             (dal 12/10 niente Entertainment né siti della scuola).
// Cosa si prova qui, senza telefono e senza server:
//   A. public/js/modalita.js eseguito in una sandbox: sale e scende da solo.
//   B. Niente più relay col Pi (né 4003, né SOLO PI); niente gettoni nei log.
//   C. Il grigio: main.css segue la modalità; le pillole «pc»/«pi» non tornano.
//   D. Il telefono (OfflineBridge.java): copia servita allo stesso indirizzo,
//      /api 503 offline, file del telefono mai toccati, sonda col tetto,
//      niente collegamenti alla scuola, niente segreti,
//      allowNavigation senza «*» (rischio di /hack chiuso).
// Sul telefono vero: checklist al proprietario.
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
  try {
    const r = fn();
    if (r && typeof r.then === 'function') attese.push(r.catch((e) => { rossi++; console.log('  ✗ ' + nome + ' — ' + e.message); }));
  } catch (e) { rossi++; console.log('  ✗ ' + nome + ' — ' + e.message); }
}

// ─── A. modalita.js in sandbox ──────────────────────────────────────────────
function sandbox({ telefono = null } = {}) {
  const elementi = {};
  function el(id) {
    return {
      id, children: [], attrs: {}, textContent: '', parentNode: null,
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      addEventListener() {},
      insertBefore(c) { c.parentNode = this; this.children.push(c); elementi[c.id] = c; },
      get firstChild() { return this.children[0] || null; },
    };
  }
  const area = el('input-area');
  elementi['input-area'] = area;
  const htmlAttrs = {};
  const risposte = [];        // coda: {status, body} oppure 'giu'
  const chiamate = { reload: 0, wsOnResume: 0, eventi: [] };
  const ctx = {
    console: { log() {}, warn() {} },
    setTimeout() { return 1; },
    clearTimeout() {},
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    CustomEvent: function (tipo, o) { this.type = tipo; this.detail = o && o.detail; },
    dispatchEvent(e) { chiamate.eventi.push(e.detail && e.detail.modo); },
    fetch() {
      const r = risposte.length ? risposte.shift() : 'giu';
      if (r === 'giu') return Promise.reject(new Error('rete'));
      const status = r.status || 200;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(r.body) });
    },
    location: { reload() { chiamate.reload++; } },
    document: {
      readyState: 'complete', hidden: false,
      getElementById: (id) => elementi[id] || null,
      createElement: () => el('solo-pi-nota'),
      addEventListener() {},
      documentElement: { setAttribute(k, v) { htmlAttrs[k] = v; } },
    },
  };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.getServerUrl = () => 'http://pc:3170';
  ctx.wsOnResume = () => { chiamate.wsOnResume++; };
  ctx.chatAvailable = true;
  if (telefono) ctx.AndroidRete = telefono;
  vm.createContext(ctx);
  return { ctx, elementi, htmlAttrs, risposte, chiamate, avvia: () => vm.runInContext(leggi('public/js/modalita.js'), ctx) };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const H = (body, status) => ({ body, status });

t('A1 PC c\'è → PIENA, nessuna scritta nuova', async () => {
  const s = sandbox();
  s.risposte.push(H({ chatAvailable: true }));
  s.avvia(); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena');
  assert.strictEqual(s.htmlAttrs['data-modalita'], 'piena');
  assert.deepStrictEqual(s.chiamate.eventi, ['piena'], 'evento modalita per i plugin');
});

t('A2 chatAvailable falso SENZA «offline» non è più SOLO PI: resta PIENA, nessuna riga', async () => {
  const s = sandbox();
  s.risposte.push(H({ chatAvailable: false }));
  s.avvia(); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena');
  assert.ok(!s.elementi['solo-pi-nota'], 'la riga di SOLO PI non nasce più');
});

t('A4 avviata SENZA PC (offline) → quando il PC torna si riparte da capo', async () => {
  const s = sandbox();
  s.ctx.chatAvailable = false;
  s.risposte.push(H({ ok: false, offline: true, chatAvailable: false }, 503));
  s.avvia(); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'offline');
  s.risposte.push(H({ chatAvailable: true }));
  s.ctx.modalitaControlla('prova'); await flush();
  assert.strictEqual(s.chiamate.reload, 1);
});

t('A5 la copia del telefono risponde 503 offline → OFFLINE al primo colpo', async () => {
  const s = sandbox();
  s.risposte.push(H({ ok: false, offline: true, chatAvailable: false }, 503));
  s.avvia(); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'offline');
  assert.strictEqual(s.htmlAttrs['data-modalita'], 'offline');
});

t('A6 il telefono dice «PC giù» (piRaggiungibile, nome nativo nell\'APK) → OFFLINE senza aspettare la rete', async () => {
  const s = sandbox({ telefono: { piRaggiungibile: () => false, paginaDalTelefono: () => true } });
  s.avvia(); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'offline');
});

t('A7 OFFLINE servita dal telefono → PC torna → si ricarica dal PC', async () => {
  let su = false;
  const s = sandbox({ telefono: { piRaggiungibile: () => su, paginaDalTelefono: () => true } });
  s.avvia(); await flush();
  su = true; s.risposte.push(H({ chatAvailable: true }));
  s.ctx.__retePiCambiata(); await flush();
  assert.strictEqual(s.chiamate.reload, 1);
});

t('A8 il PC muto: grigio solo dopo 2 fallite E 12 s di silenzio', async () => {
  const s = sandbox();
  let ora = 1000000;
  s.ctx.Date = { now: () => ora };
  s.risposte.push(H({ chatAvailable: true }));
  s.avvia(); await flush();
  s.risposte.push('giu'); s.ctx.modalitaControlla('a'); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena', 'una sola: niente grigio');
  ora += 5000;
  s.risposte.push('giu'); s.ctx.modalitaControlla('b'); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena', 'IL CASO VERO: due di fila in 5 s (buco Starlink) non è grigio');
  ora += 2000;
  s.risposte.push(H({ chatAvailable: true })); s.ctx.modalitaControlla('c'); await flush();
  ora += 11000;
  s.risposte.push('giu'); s.ctx.modalitaControlla('d'); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena', 'una buona azzera il conto e l\'orologio');
  ora += 6000;
  s.risposte.push('giu'); s.ctx.modalitaControlla('e'); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena', '6 s dalla prima: ancora no');
  ora += 6000;
  s.risposte.push('giu'); s.ctx.modalitaControlla('f'); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'offline', '12 s dalla prima fallita: PC giù davvero');
});

t('A10 risalita sotto i 30 s: fuori da PIENA si richiede ogni pochi secondi', () => {
  const m = leggi('public/js/modalita.js').match(/var OGNI = \{ piena: (\d+), offline: (\d+) \}/);
  assert.ok(m && Number(m[1]) <= 5000 && Number(m[2]) <= 5000);
});

t('A16 socket vivo → /api/health ogni 30 s, non ogni 5; socket muto o una fallita → di nuovo ogni 5 s (batteria, 10/11)', async () => {
  const s = sandbox();
  let ora = 1000000;
  s.ctx.Date = { now: () => ora };
  const timer = [];
  s.ctx.setTimeout = (fn, ms) => { timer.push({ fn, ms }); return timer.length; };
  let domande = 0;
  const fetchVero = s.ctx.fetch;
  s.ctx.fetch = function () { domande++; return fetchVero.apply(this, arguments); };
  s.ctx.ws = { readyState: 1 };
  s.ctx._wsLastRecv = ora;
  // L'orologio di modalita.js: l'ultimo timer da OGNI ms (5000), non quello del TIMEOUT (4000).
  const batti = async (passo) => {
    ora += passo;
    const t5 = timer.filter((x) => x.ms === 5000).pop(); if (!t5) throw new Error("nessun battito: " + JSON.stringify(timer.map((x) => x.ms)) + " domande=" + domande);
    timer.length = 0;
    t5.fn(); await flush();
  };
  s.risposte.push(H({ chatAvailable: true }));
  s.avvia(); await flush();
  assert.strictEqual(domande, 1, 'una domanda all\'avvio');
  for (let i = 0; i < 5; i++) { s.ctx._wsLastRecv = ora; await batti(5000); }
  assert.strictEqual(domande, 1, 'socket vivo: 25 s senza bussare');
  s.risposte.push(H({ chatAvailable: true }));
  s.ctx._wsLastRecv = ora; await batti(5000);
  assert.strictEqual(domande, 2, 'a 30 s dall\'ultima si richiede comunque');
  // Il socket tace da più di 20 s (PC giù, pong mancati): si torna ogni 5 s.
  s.ctx._wsLastRecv = ora - 21000;
  s.risposte.push('giu'); await batti(5000);
  assert.strictEqual(domande, 3, 'socket muto: domanda subito al battito');
  // Una fallita: veloce anche se il socket sembrasse vivo, e il grigio arriva coi tempi di prima.
  s.ctx._wsLastRecv = ora;
  s.risposte.push('giu'); await batti(5000);
  assert.strictEqual(domande, 4, 'dopo una fallita si chiede ogni 5 s');
  s.risposte.push('giu'); await batti(5000);
  s.risposte.push('giu'); await batti(5000);
  assert.strictEqual(s.ctx.modalitaAttuale(), 'offline', '2 fallite e 12 s dalla prima: grigio come prima');
});

t('A11 modalita.js è caricato dalla pagina, dopo ws.js; nessuna scritta-chip in testata', () => {
  const html = leggi('public/index.html');
  const iWs = html.indexOf('src="js/ws.js"'), iMod = html.indexOf('src="js/modalita.js"');
  assert.ok(iWs > 0 && iMod > iWs);
  assert.ok(!/modalita-chip/.test(leggi('public/js/modalita.js') + leggi('public/css/main.css')), 'nessuna scritta-chip in testata');
});

t('A12 OFFLINE: la casa dice «PC not reachable» e non apre niente da sola (12/10)', async () => {
  const s = sandbox({ telefono: { piRaggiungibile: () => false, paginaDalTelefono: () => true } });
  s.avvia(); await flush();
  assert.strictEqual(s.ctx.modalitaAttuale(), 'offline');
  const src = leggi('public/js/modalita.js');
  assert.ok(/PC not reachable/.test(src));
  assert.ok(!/apriEntertainment|openEntertainment|PORTALI|\.apri\(|extremeenglish4kids/.test(src), 'niente intrattenimento né siti della scuola');
});

t('A13 mai chiusi fuori: offline toglie la pagina della password e nasconde le chat senza accesso', () => {
  const src = leggi('public/js/modalita.js');
  assert.ok(/nuovo === OFFLINE\) \{[\s\S]{0,500}lo\.classList\.add\('hidden'\)/.test(src));
  assert.ok(/data-senza-accesso/.test(src) && /html\[data-senza-accesso="si"\] #messages/.test(leggi('public/css/main.css')));
});

t('A14 a PC spento si leggono TUTTE le sessioni: archivio IndexedDB scritto a ogni elenco, letto nel ripiego', () => {
  const core = leggi('public/js/core.js'), ses = leggi('public/js/sessions.js');
  assert.ok(/function archiviaSessioni\(lista\)/.test(core) && /indexedDB\.open\(ARCHIVIO_DB/.test(core));
  assert.ok(/window\.cacheSessionList\(lista\);\s*\/\/[^\n]*\n\s*try \{ window\.archiviaSessioni\(lista\)/.test(ses), 'scritto quando l\'elenco arriva');
  assert.ok(/var COPIA_DOPO_MS = 2500;/.test(ses) && /Promise\.race\(\[server, tardi\]\)/.test(ses), 'mai vuota: la copia del telefono dopo 2,5 s');
  assert.ok(/getCachedSessionList\(\);[\s\S]{0,400}await window\.leggiArchivio\(\)[\s\S]{0,200}s\.history = _arch\[s\.id\]/.test(ses), 'letto nel ripiego');
  assert.ok(/if \(!window\.chatAvailable\) \{\s*var newBtn/.test(leggi('public/js/init.js')) && /await loadSessions\(\);\s*if \(window\.chatAvailable\) await loadCommands/.test(leggi('public/js/init.js')), 'init carica le sessioni anche senza PC');
});

t('A15 /api 503 offline (copia del telefono) → api() lo alza; il server non finge più un «PC spento» (12/10)', () => {
  assert.ok(!/pcOffline: true/.test(leggi('server/index.js')), 'nessun 503 pcOffline: era il Pi');
  assert.ok(/res\.status === 503 && parsed && \(parsed\.offline === true \|\| parsed\.pcOffline === true\)\) throw/.test(leggi('public/js/core.js')));
});

t('A16 browser del PC: il PC che si riavvia NON diventa «Pi offline»', async () => {
  const s = sandbox();
  s.risposte.push(H({ chatAvailable: true, cliAvailable: true }));
  s.avvia(); await flush();
  s.risposte.push('giu', 'giu', 'giu');
  for (let i = 0; i < 3; i++) { s.ctx.modalitaControlla('x'); await flush(); }
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena');
});

t('A17 riavvio annunciato (4100) sul telefono: niente «offline» nel frattempo', async () => {
  const s = sandbox();
  s.ctx.isInRestartMode = () => true;
  s.risposte.push(H({ chatAvailable: true }));
  s.avvia(); await flush();
  s.risposte.push('giu', 'giu');
  for (let i = 0; i < 2; i++) { s.ctx.modalitaControlla('x'); await flush(); }
  assert.strictEqual(s.ctx.modalitaAttuale(), 'piena');
});

// ─── B. Niente più relay col Pi (12/10/2026) ─────────────────────────────
t('B1 la Machine non parla più col Pi: niente peer-relay, niente /api/relay, niente proxy di /ws, niente 4003', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'server', 'peer-relay.js')), 'server/peer-relay.js tolto');
  const vivo = (f) => leggi(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  const idx = vivo('server/index.js');
  assert.ok(!/require\(['"]\.\/peer-relay['"]\)|getPeerRelay|_proxyWss|_socketVersoPc/.test(idx), 'index.js senza relay');
  assert.ok(!/app\.(get|post|use)\(['"]\/api\/relay/.test(idx), 'niente rotte /api/relay/*');
  assert.ok(!/4003|solo-pi/.test(idx), 'il server non chiude più con 4003');
  assert.ok(!/PeerProc|peer-relay/.test(vivo('server/session-manager.js')), 'session-manager senza PeerProc');
  const ws = vivo('public/js/ws.js'), mod = vivo('public/js/modalita.js');
  assert.ok(!/4003|modalitaSoloPi/.test(ws), 'ws.js senza 4003');
  assert.ok(!/SOLO_PI|soloPi|modalitaSoloPi|solo-pi-nota/.test(mod), 'modalita.js senza SOLO PI');
  assert.ok(!/soloPi|solo-pi-nota/.test(leggi('public/css/main.css').replace(/\/\*[\s\S]*?\*\//g, '')), 'main.css senza SOLO PI');
});

t('B2 /api/health non parla più del peer', () => {
  const src = leggi('server/index.js');
  const i = src.indexOf("app.get('/api/health'");
  const tratto = src.slice(i, src.indexOf('\n});', i));
  assert.ok(i > 0 && /chatAvailable: cliAvailable,/.test(tratto));
  assert.ok(!/peerOnline|lastPollAgeMs|x-peer-poll|pokeNow/.test(tratto.replace(/\/\/.*$/gm, '')));
});

// B5 (/hack, 07/10/2026: tre «annulla» sull'impronta aprivano l'app col gettone
// di prima) tolta il 12/11/2026: l'impronta e il suo ripiego sulla password non
// esistono più. Si entra solo con la parola; tests/senza-impronta.test.js.

t('B6 /hack: gettone rifiutato (401) → le chat copiate sul telefono se ne vanno', () => {
  const core = leggi('public/js/core.js');
  assert.ok(/function svuotaCopieLocali\(\)[\s\S]{0,600}indexedDB\.deleteDatabase\(ARCHIVIO_DB\)/.test(core));
  for (const f of ['public/js/core.js', 'public/js/init.js', 'public/js/ws.js']) {
    const src = leggi(f);
    const tolti = (src.match(/localStorage\.removeItem\('151-terminal-token'\);/g) || []).length;
    const svuotati = (src.match(/localStorage\.removeItem\('151-terminal-token'\);\r?\n\s*if \(window\.svuotaCopieLocali\) window\.svuotaCopieLocali\(\);/g) || []).length;
    assert.strictEqual(svuotati, tolti, f + ': ogni gettone tolto svuota anche le copie');
  }
});

// ─── C. Il grigio; le pillole «pc»/«pi» non tornano ─────────────────────────
t('C1 niente pillole «pc»/«pi» né bottone Raspberry', () => {
  const src = leggi('public/js/topbar.js');
  assert.ok(!/data-k="(server|rpi)"/.test(src), 'nessuna pillola pc/pi nella barra');
  assert.ok(!/function poll(Server|Raspberry)\(/.test(src), 'nessuno chiede più lo stato di pc/pi');
  assert.ok(!/topbarRidipingi/.test(src + leggi('public/js/modalita.js')), 'niente più ridipintura delle pillole');
  assert.ok(!/raspberry/i.test(leggi('public/index.html')), 'niente vista né script del Raspberry nella pagina');
});

t('C2 OFFLINE: grigio tutto, nessuna eccezione (12/10)', () => {
  const css = leggi('public/css/main.css');
  assert.ok(css.includes('html[data-modalita="offline"] .apps-card {'));
  assert.ok(!/plugin-id="entertainment"|casa-niente-rete|apps-group-school/.test(css));
  for (const id of ['#session-list', '#messages', '#input-area']) assert.ok(css.includes('html[data-modalita="offline"] ' + id), id);
});

t('C3 il bottone «New Session» che si spegne è quello VERO (#all-teams-btn, non il fantasma #new-session-btn)', () => {
  // Fino al 12/10 main.css e init.js nascondevano #new-session-btn, che non
  // esiste dal 14/04: in SOLO PI (tolta il 12/10) il bottone restava acceso.
  const css = leggi('public/css/main.css'), html = leggi('public/index.html'), init = leggi('public/js/init.js');
  assert.ok(/<button id="all-teams-btn"/.test(html), 'il bottone è in pagina');
  assert.ok(!/#new-session-btn\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'nessuna regola sul fantasma');
  assert.ok(!/getElementById\('new-session-btn'\)/.test(init), 'init.js non cerca il fantasma');
  assert.ok(/getElementById\('all-teams-btn'\)/.test(init));
  // La regola del piede (#sidebar-footer .footer-sessions button.new-session-btn,
  // specificità 1,2,1) vincerebbe con display:flex: servono due id.
  assert.ok(css.includes('html[data-modalita="offline"] #all-teams-btn,'));
});

// ─── D. Il telefono ─────────────────────────────────────────────────────────
const JAVA = 'app/android/app/src/main/java/com/the151universe/machine/';
const BRIDGE = () => leggi(JAVA + 'OfflineBridge.java');

t('D1 Pi giù → la STESSA app dalla copia nell\'APK, /api 503 offline, file del telefono intatti', () => {
  const src = BRIDGE();
  const i = src.slice(src.indexOf('public WebResourceResponse shouldInterceptRequest'), src.indexOf('public void onReceivedError'));
  assert.ok(/eDelPi\(u\)/.test(i) && /!fileDelTelefono\(path\)/.test(i));
  assert.ok(/path\.startsWith\("\/api\/"\)[\s\S]{0,120}risposta\(503[\s\S]{0,80}\\"offline\\":true/.test(i));
  assert.ok(/return daCopia\(path\)/.test(i));
  assert.ok(/am\.open\("public" \+ p\)/.test(src), 'dagli assets/public dell\'APK');
  assert.ok(/p\.contains\("\.\."\)/.test(src), 'niente ../');
  assert.ok(/_capacitor_file_/.test(src) && /_capacitor_content_/.test(src));
});

t('D2 la sonda ha un tetto vero (DNS compreso) e parte a ogni cambio di rete', () => {
  const src = BRIDGE();
  assert.ok(/SONDA_MS = 2500/.test(src) && /f\.get\(SONDA_MS, TimeUnit\.MILLISECONDS\)/.test(src));
  assert.ok(/registerDefaultNetworkCallback/.test(src));
  assert.ok(/window\.__retePiCambiata/.test(src) && /window\.__retePiCambiata = function/.test(leggi('public/js/modalita.js')));
});

t('D3 pagina del Pi fallita → si ricarica dalla copia (mai schermo blu), al massimo 2 volte', () => {
  const src = BRIDGE();
  assert.ok(/onReceivedError[\s\S]{0,300}isForMainFrame\(\) && eDelPi\(req\.getUrl\(\)\) && ricarichePerErrore < 2/.test(src));
});

t('D4 il ponte AndroidRete non apre più siti: niente apri(), niente lista della scuola (1.20, 12/10)', () => {
  const src = BRIDGE();
  assert.ok(!/public void apri\(|PORTALI|extremeenglish4kids|customtabs/.test(src));
  assert.ok(/public boolean piRaggiungibile\(\)/.test(src) && /public boolean paginaDalTelefono\(\)/.test(src));
});

t('D5 nessun segreto passa dal ponte AndroidRete', () => {
  const codice = BRIDGE().replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  assert.ok(!/getCredentials|password|CookieManager|token/i.test(codice));
});

t('D6 «del Pi» = schema, host E porta; AndroidUpdater (nativo, nell\'APK 1.20) scarica solo dal Pi', () => {
  const src = BRIDGE();
  const m = src.slice(src.indexOf('private boolean eDelPi('), src.indexOf('private boolean eDelPi(') + 400);
  assert.ok(/getHost\(\)/.test(m) && /getScheme\(\)/.test(m) && /getPort\(\) == portaPi/.test(m));
  assert.ok(/eDelPi\(u\) && "\/api\/download-apk"\.equals\(u\.getPath\(\)\)/.test(src));
  assert.ok(/if \(offline != null && !offline\.apkAmmesso\(url\)\)/.test(leggi(JAVA + 'MainActivity.java')));
});

t('D7 rischio di /hack chiuso: niente allowNavigation «*», niente pagina offline a parte', () => {
  const cfg = JSON.parse(leggi('app/capacitor.config.json'));
  const nav = (cfg.server && cfg.server.allowNavigation) || [];
  assert.ok(!nav.some((h) => h.includes('*')), 'allowNavigation: ' + JSON.stringify(nav));
  assert.ok(!cfg.server.errorPath, 'niente errorPath: la copia è la stessa app');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public', 'offline.html')));
});

t('D10 la copia offline dei plugin arriva DAVVERO nell\'APK (cap sync la cancellava)', () => {
  const sync = leggi('tools/sync-offline-plugins.js');
  assert.ok(/process\.argv\.includes\('--android'\)/.test(sync) && /assets', 'public'\);?/.test(sync) === false || /'assets', 'public'/.test(sync));
  // dal 12/10/2026 si copiano solo gli id di offline-plugins.json, uno per uno
  // (non più l'intera public/plugins con le cartelle dei plugin tolti)
  assert.ok(/fs\.cpSync\(path\.join\(OUT_DIR, id\)|fs\.cpSync\(src, path\.join\(dest, id\)/.test(sync));
  assert.ok(/readFileSync\(MANIFEST_PATH[\s\S]*?\.map\(\(p\) => p\.id\)/.test(sync), 'l\'elenco viene da offline-plugins.json');
  // [12/10/2026] tools/publish-apk.sh è tolto con l'aggiornamento dentro l'app:
  // l'APK nuova arriva per link, non dal server.
});

t('D11 niente aggiornamento dentro l\'app: la pagina non chiede versioni e non chiama AndroidUpdater, il server non serve l\'APK', () => {
  const pagina = ['auth.js', 'init.js'].map((f) => leggi('public/js/' + f)).join('\n');
  assert.ok(!/AndroidUpdater|checkForAppUpdate|\/api\/app-version|\/api\/download-apk/.test(pagina));
  const server = leggi('server/index.js');
  assert.ok(!/\/api\/app-version|\/api\/download-apk|'\/app-version'|'\/download-apk'/.test(server));
  assert.ok(!fs.existsSync(path.join(ROOT, 'app-version.json')) && !fs.existsSync(path.join(ROOT, 'tools', 'publish-apk.sh')));
});

t('D8 MainActivity accende il servitore e lo segue in primo piano/sfondo', () => {
  const main = leggi(JAVA + 'MainActivity.java');
  assert.ok(/offline = new OfflineBridge\(this, getBridge\(\)\);\s*offline\.installa\(\);/.test(main));
  assert.ok(/offline\.onResume\(\)/.test(main) && /offline\.onPause\(\)/.test(main));
});

t('B4 nessun log del server stampa un indirizzo con la sua query (?token=)', () => {
  for (const f of ['server/index.js']) {
    const nudi = leggi(f).split('\n').filter((l) => /console\.(log|warn|error)\(/.test(l) && /req\.(originalUrl|url)\b/.test(l) && !/split\('\?'\)\[0\]/.test(l));
    assert.deepStrictEqual(nudi, [], f + ':\n' + nudi.join('\n'));
  }
});

Promise.all(attese).then(() => {
  console.log(rossi ? `tre-modalita: ${rossi}/${n} ROSSI` : `tre-modalita: ${n}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
});
