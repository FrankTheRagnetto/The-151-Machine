#!/usr/bin/env node
'use strict';

/**
 * notifiche-una-per-sessione.test.js — le notifiche del telefono dicono il vero.
 *
 * «now I have three notifications clumped up together, but
 * there's only one session I need to respond to. So the notifications are
 * untrustworthy.» E l'icona: a volte lo schermo viola, a volte «a white circle
 * with an eye in the middle» (era la «i» di sistema di Android: il plugin
 * cercava `ic_launcher` fra i drawable, non c'è, e ripiegava su
 * android.R.drawable.ic_dialog_info).
 *
 * LE LEGGI:
 *   A. UNA notifica per sessione: stesso numero per la stessa sessione (Android
 *      sostituisce), numeri diversi per sessioni diverse, mai 1511/1513 (servizi).
 *   B. Sparisce quando la sessione è aperta, ha la risposta del proprietario, è letta
 *      altrove dopo la notifica, o non c'è più — anche al ritorno di un'app
 *      che Samsung aveva ucciso (riconciliaNotifiche contro /api/sessions).
 *   C. La riserva a 3 minuti non cancella mai la notifica vera.
 *   D. UNA icona per tutte: ic_stat_machine esiste come drawable, e plugin,
 *      configurazione e servizi nativi la usano tutti, col viola dell'accento.
 *   E. I fili: ogni notifica di sessione porta il suo id, e ogni «letta» /
 *      «al lavoro» / «cancellata» la toglie; il server ricorda readAt.
 *
 * Run: node tests/notifiche-una-per-sessione.test.js  (raccolto da `npm test`).
 * Esecuzione vera del plugin in una sandbox vm + controlli sul sorgente.
 * Nessun server, nessun telefono, nessuna rete.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// ---------- sandbox del plugin ----------
function caricaPlugin(opts) {
  opts = opts || {};
  const chiamate = { schedule: [], cancel: [] };
  const store = {};
  const fakePlugin = {
    schedule(a) { chiamate.schedule.push(a.notifications[0]); return Promise.resolve(); },
    cancel(a) { a.notifications.forEach((n) => chiamate.cancel.push(n.id)); return Promise.resolve(); },
    requestPermissions() { return Promise.resolve({ display: 'granted' }); },
    addListener(nome, fn) { (ascolti[nome] = ascolti[nome] || []).push(fn); return Promise.resolve({ remove() {} }); },
  };
  const ascolti = {};
  const timer = [];
  const win = {
    Capacitor: { Plugins: { LocalNotifications: fakePlugin } },
    sessions: [],
    activeSessionId: null,
  };
  const doc = { visibilityState: opts.visibile ? 'visible' : 'hidden' };
  const ctx = {
    window: win,
    document: doc,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    console: { log() {} },
    Date, JSON, Math, Object, Promise,
    setTimeout: (fn) => { timer.push(fn); return timer.length; },
  };
  vm.createContext(ctx);
  vm.runInContext(rd('plugins/chime-notifications/client.js'), ctx);
  const reg = () => JSON.parse(store['151-notifiche-sessioni'] || '{}');
  const scorri = () => { while (timer.length) timer.shift()(); };
  return { win, doc, chiamate, reg, ascolti, store, scorri };
}

console.log('\nA. una notifica per sessione');
{
  const t = caricaPlugin();
  ok(typeof t.win.clearSessionNotification === 'function', 'clearSessionNotification esposta');
  ok(typeof t.win.riconciliaNotifiche === 'function', 'riconciliaNotifiche esposta');
  t.win.notifyDone('Writer finished', { force: true, sessionId: 'sess-aaa' });
  t.win.notifyDone('Writer is requesting permission', { force: true, sessionId: 'sess-aaa' });
  t.win.notifyDone('Apps finished', { force: true, sessionId: 'sess-bbb' });
  const ids = t.chiamate.schedule.map((n) => n.id);
  ok(ids.length === 3, 'tre notifiche chieste (' + ids.length + ')');
  ok(ids[0] === ids[1], 'stessa sessione = stesso numero (Android sostituisce)');
  ok(ids[0] !== ids[2], 'sessioni diverse = numeri diversi');
  ok(ids.every((i) => i !== 1511 && i !== 1513 && i !== 99999 && i >= 200000), 'mai i numeri dei servizi nativi');
  ok(Object.keys(t.reg()).length === 2, 'registro: due sessioni, non tre notifiche');
  ok(t.chiamate.schedule.every((n) => n.smallIcon === 'ic_stat_machine' && n.iconColor === '#a78bfa'),
     'ogni notifica: icona ic_stat_machine + viola dell\'accento');
}

console.log('\nB. sparisce quando non aspetta più l\'utente');
{
  const t = caricaPlugin();
  t.win.notifyDone('x', { force: true, sessionId: 's1' });
  const id1 = t.chiamate.schedule[0].id;
  t.win.clearSessionNotification('s1');
  ok(t.chiamate.cancel.includes(id1), 'aperta/risposta → cancel del suo numero');
  ok(!('s1' in t.reg()), 'aperta/risposta → fuori dal registro');

  // riconciliazione contro l'elenco del server
  const t2 = caricaPlugin();
  ['busy', 'letta', 'nonletta', 'sparita', 'idle'].forEach((s) => t2.win.notifyDone(s, { force: true, sessionId: s }));
  const idDi = {};
  t2.chiamate.schedule.forEach((n) => { idDi[n.body] = n.id; });
  const at = t2.reg().letta.at;
  t2.win.riconciliaNotifiche([
    { id: 'busy', status: 'busy' },
    { id: 'letta', status: 'idle', readAt: at + 1000 },
    { id: 'nonletta', status: 'idle', readAt: at - 60000 },
    { id: 'idle', status: 'idle', readAt: null },
  ]);
  const c = t2.chiamate.cancel;
  ok(c.includes(idDi.busy), 'al lavoro → via');
  ok(c.includes(idDi.letta), 'letta altrove DOPO la notifica → via');
  ok(c.includes(idDi.sparita), 'sessione cancellata → via');
  ok(!c.includes(idDi.nonletta), 'letta PRIMA della notifica → resta (aspetta davvero)');
  ok(!c.includes(idDi.idle), 'mai letta, ferma → resta');
  ok(Object.keys(t2.reg()).sort().join() === 'idle,nonletta', 'registro = solo chi aspetta l\'utente');

  const t3 = caricaPlugin({ visibile: true });
  t3.win.notifyDone('y', { force: true, sessionId: 'aperta' });
  t3.win.activeSessionId = 'aperta';
  t3.win.riconciliaNotifiche([{ id: 'aperta', status: 'idle' }]);
  ok(t3.chiamate.cancel.includes(t3.chiamate.schedule[0].id), 'aperta davanti all\'utente → via');

  const t4 = caricaPlugin();
  t4.win.notifyDone('z', { force: true, sessionId: 'q' });
  t4.win.riconciliaNotifiche([]);
  ok(t4.chiamate.cancel.length === 0, 'elenco vuoto (server muto) → non si tocca niente');
}

console.log('\nC. la riserva a 3 minuti');
{
  const t = caricaPlugin();
  t.win.activeSessionId = 'r1';
  t.win.sessions = [{ id: 'r1', title: 'Apps' }];
  t.win.schedulePendingNotification();
  const riserva = t.chiamate.schedule[0];
  ok(riserva && riserva.smallIcon === 'ic_stat_machine', 'riserva con la stessa icona');
  t.win.notifyDone('fatto', { sessionId: 'r1' });              // risposta arrivata, app nascosta
  const vera = t.chiamate.schedule[1];
  ok(vera && vera.id === riserva.id, 'la vera prende il numero della riserva (una sola)');
  t.win.cancelPendingNotification();                           // setStreamingState(false) dopo
  ok(!t.chiamate.cancel.includes(vera.id), 'chiudere la riserva non cancella la vera');
  ok(t.reg().r1 && !t.reg().r1.riserva, 'registro: la vera, non la riserva');

  const t2 = caricaPlugin();
  t2.win.activeSessionId = 'r2';
  t2.win.schedulePendingNotification();
  t2.win.cancelPendingNotification();                          // risposta vista ad app aperta
  ok(t2.chiamate.cancel.includes(t2.chiamate.schedule[0].id), 'risposta ad app aperta → riserva via');
  ok(!('r2' in t2.reg()), 'e fuori dal registro');

  const t3 = caricaPlugin({ visibile: true });
  t3.win.activeSessionId = 'r3';
  t3.win.schedulePendingNotification();
  t3.win.notifyDone('fatto', { sessionId: 'r3' });             // visibile: nessuna notifica
  ok(t3.chiamate.schedule.length === 1 && t3.chiamate.cancel.includes(t3.chiamate.schedule[0].id),
     'risposta vista dal vivo → nessuna notifica e la riserva muore');
}

console.log('\nD. una icona per tutte');
{
  const RES = 'app/android/app/src/main/res/';
  const xml = rd(RES + 'drawable/ic_stat_machine.xml');
  ok(/<vector/.test(xml) && /#FFFFFFFF/.test(xml) && !/fillColor="#(?!FFFFFFFF)/.test(xml),
     'ic_stat_machine: vettore, solo bianco su trasparente');
  const cfg = JSON.parse(rd('app/capacitor.config.json'));
  const ln = cfg.plugins.LocalNotifications;
  ok(ln.smallIcon === 'ic_stat_machine' && fs.existsSync(path.join(ROOT, RES, 'drawable', ln.smallIcon + '.xml')),
     'configurazione: icona predefinita = un drawable che esiste (niente «i» di sistema)');
  ok(ln.iconColor.toLowerCase() === '#a78bfa', 'configurazione: viola dell\'accento');
  const acc = (rd('public/css/main.css').match(/--accent:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  ok(acc && acc.toLowerCase() === '#a78bfa', 'il viola è proprio --accent');
  const J = 'app/android/app/src/main/java/com/the151universe/machine/';
  for (const f of ['MicService.java']) { // PlaybackService uscito con Entertainment (13/10/2026)
    const s = rd(J + f);
    const small = s.match(/setSmallIcon\(R\.drawable\.(\w+)\)/g) || [];
    ok(small.length > 0 && small.every((m) => m.includes('ic_stat_machine')), f + ': icona piccola ic_stat_machine');
    ok(/setColor\(0xFFA78BFA\)/.test(s), f + ': viola dell\'accento');
  }
  const javaAll = fs.readdirSync(path.join(ROOT, J)).filter((f) => f.endsWith('.java')).map((f) => rd(J + f)).join('\n');
  ok(!/setSmallIcon\(R\.(mipmap|drawable)\.ic_launcher/.test(javaAll), 'nessun nativo usa l\'icona dell\'app come icona piccola');
  const plug = rd('plugins/chime-notifications/client.js');
  ok(!/smallIcon:\s*'ic_launcher'/.test(plug), 'plugin: niente più ic_launcher (cercato fra i drawable, non esiste)');
}

console.log('\nE. i fili');
{
  const ws = rd('public/js/ws.js');
  const chiamate = ws.match(/window\.notifyDone\([^;]*\);/g) || [];
  ok(chiamate.length >= 4 && chiamate.every((c) => /sessionId/.test(c)), 'ogni notifyDone di ws.js porta la sua sessione (' + chiamate.length + ')');
  const blocco = (tipo) => { const i = ws.indexOf("msg.type === '" + tipo + "'"); return i < 0 ? '' : ws.slice(i, i + 900); };
  ok(/clearSessionNotification\(msg\.sessionId\)/.test(blocco('session_read')), 'session_read (letta altrove) → via la notifica');
  ok(/status === 'busy'[^]*clearSessionNotification\(msg\.sessionId\)/.test(blocco('session_status_changed').concat(ws.slice(ws.indexOf("msg.type === 'session_status_changed'"), ws.indexOf("msg.type === 'session_read'")))),
     'sessione al lavoro → via la notifica');
  ok(/clearSessionNotification\(msg\.sessionId\)/.test(blocco('session_deleted')), 'sessione cancellata → via la notifica');
  const iR = ws.indexOf('function clearActiveAwaitingOnReturn'); const ritorno = ws.slice(iR, ws.indexOf('\n}\n', iR) + 3);
  ok(/segnaLetta\(window\.activeSessionId\)/.test(ritorno), 'ritorno sulla pagina → letta, sempre (non solo col pallino)');
  const ss = rd('public/js/sessions.js');
  ok(/window\.segnaLetta = function/.test(ss) && /type: 'session_read'/.test(ss), 'segnaLetta manda session_read');
  const sw = ss.slice(ss.indexOf('window.switchSession = function'), ss.indexOf('window.switchSession = function') + 2500);
  ok(/window\.segnaLetta\(id\)/.test(sw), 'aprire una sessione → letta ovunque');
  ok(/riconciliaNotifiche\(lista\)/.test(ss), 'elenco fresco dal server → riconciliazione');
  ok(/segnaLetta\(activeSessionId\)/.test(rd('public/js/input.js')), 'rispondere → letta ovunque');
  const sm = rd('server/session-manager.js');
  ok(/markRead\(id, at = Date\.now\(\)\)/.test(sm), 'server: markRead');
  ok((sm.match(/readAt: (s|session)\.readAt \|\| null/g) || []).length === 2, 'server: readAt su disco e in /api/sessions');
  ok(/manager\.markRead\(sid\)/.test(rd('server/ws-handler.js')), 'server: session_read lo ricorda');
}

console.log('\nF. tocco sulla notifica → QUELLA sessione');
{
  const t = caricaPlugin();
  t.win.notifyDone('Apps finished', { force: true, sessionId: 'seconda' });
  ok(t.chiamate.schedule[0].extra && t.chiamate.schedule[0].extra.sessionId === 'seconda', 'la notifica porta la sua sessione');
  t.win.activeSessionId = 'r';
  t.win.schedulePendingNotification();
  ok(t.chiamate.schedule[1].extra && t.chiamate.schedule[1].extra.sessionId === 'r', 'anche la riserva a 3 minuti');
  const tocchi = t.ascolti.localNotificationActionPerformed || [];
  ok(tocchi.length === 1, 'un ascoltatore del tocco, uno solo');

  // app già aperta su un'altra sessione
  const aperte = [];
  t.win.sessions = [{ id: 'prima' }, { id: 'seconda' }];
  t.win.activeSessionId = 'prima';
  t.win.switchSession = (id) => { aperte.push(id); t.win.activeSessionId = id; };
  tocchi[0]({ actionId: 'tap', notification: { id: 1, extra: { sessionId: 'seconda' } } });
  ok(aperte.join() === 'seconda', 'app aperta su un\'altra → si apre la seconda');
  ok(t.store['151-terminal-session'] === 'seconda', 'e resta quella da riaprire');
  ok(!('seconda' in t.reg()), 'la sua notifica esce dal registro');

  // avvio a freddo: elenco sessioni non ancora arrivato
  const t2 = caricaPlugin();
  const aperte2 = [];
  t2.win.switchSession = (id) => { aperte2.push(id); t2.win.activeSessionId = id; };
  t2.ascolti.localNotificationActionPerformed[0]({ notification: { extra: { sessionId: 'fredda' } } });
  ok(aperte2.length === 0 && t2.store['151-terminal-session'] === 'fredda', 'a freddo: scritta per init.js, niente salto nel vuoto');
  t2.win.sessions = [{ id: 'altra' }, { id: 'fredda' }];
  t2.win.activeSessionId = 'altra';
  t2.scorri();
  ok(aperte2.join() === 'fredda', 'a freddo: arrivato l\'elenco, si apre quella toccata');

  // tocco su una notifica senza sessione: niente
  const t3 = caricaPlugin();
  let saltato = false;
  t3.win.switchSession = () => { saltato = true; };
  t3.ascolti.localNotificationActionPerformed[0]({ notification: { extra: null } });
  ok(!saltato, 'notifica senza sessione → nessun salto');
}

console.log('\nG. registrazione: la notifica subito');
{
  const s = rd('app/android/app/src/main/java/com/the151universe/machine/MicService.java');
  ok(/setForegroundServiceBehavior\(Notification\.FOREGROUND_SERVICE_IMMEDIATE\)/.test(s),
     'MicService chiede la notifica SUBITO (Android 12+ la rimanda fino a 10 s)');
  ok(/SDK_INT >= 31\)[^}]*FOREGROUND_SERVICE_IMMEDIATE/.test(s), 'solo da Android 12 (API 31), dove esiste');
}

console.log('\n' + pass + ' ok, ' + fail + ' falliti');
process.exit(fail ? 1 : 0);
