'use strict';
// Updates: un gesto solo («I typically just update
// everything», poi «così clicco solo su update sarebbe gasante»). In cima il
// numero e il bottone «Update everything», con una conferma nello stesso
// blocco prima dell'avvio; il comando da copiare resta come seconda strada; i
// canali sotto, chiusi di base; un canale scaduto o in errore non si dice mai
// «up to date»; colori solo dalle variabili di main.css. La vista viva:
// domanda della password type=password + autocomplete new-password, svuotata
// all'invio; nessun bottone Stop (/hack: fermare pacman a metà rompe il sistema).
// Puro: niente server, niente browser. La vista è una funzione (api.view) che
// rende HTML da un JSON finto. La misura vera in Chromium e Firefox è nel
// rapporto del designer.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(R, 'plugins', 'updates', 'client.js'), 'utf8');
const server = fs.readFileSync(path.join(R, 'plugins', 'updates', 'server.js'), 'utf8');
const mainCss = fs.readFileSync(path.join(R, 'public', 'css', 'main.css'), 'utf8');
let rossi = 0, n = 0;
function t(nome, fn) { n++; try { fn(); console.log('  ✓ ' + nome); } catch (e) { rossi++; console.log('  ✗ ' + nome + ' — ' + e.message); } }
function ok(c, m) { if (!c) throw new Error(m); }

// Carica il plugin in una sandbox e prende quello che registra.
let api = null;
try {
  const ctx = { window: { The151Machine: { register: (id, h) => { if (id === 'updates') api = h; } } }, document: {}, localStorage: { getItem: () => '' } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
} catch (e) { console.log('  (caricamento: ' + e.message + ')'); }
const view = (m) => { ok(api && typeof api.view === 'function', 'il plugin non espone view(model): la vista non si può provare'); return api.view(m, { label: 'Computer' }).html; };

const ARCH = 'yay -Syu --answerdiff=None --answeredit=None --answerclean=None --removemake';
const machine = { label: 'Computer', hostname: 'pc', os: 'EndeavourOS' };
const c = (o) => Object.assign({ short: 's', what: 'w', does: 'd', silences: 'x', notes: [], items: [], count: 0 }, o);
function data(chs) {
  const a = chs.filter((x) => x.state === 'outdated');
  return { machine, generatedAt: '2026-10-16T10:00:00Z', channels: chs, totalUpdates: a.reduce((s, x) => s + x.count, 0), allInOne: a.length ? a.map((x) => x.command).join(' && ') : null, allInOneChannels: a.map((x) => x.name) };
}
const quattro = data([
  c({ name: 'Arch — system + AUR', command: ARCH, state: 'outdated', count: 5, items: [{ group: 'repo', name: 'linux', from: '1', to: '2' }] }),
  c({ name: 'Flatpak', command: 'flatpak update', state: 'outdated', count: 1 }),
  c({ name: 'npm — global packages', command: 'npm update -g', state: 'outdated', count: 2 }),
  c({ name: 'uv — Python tools', command: 'uv tool upgrade --all', state: 'outdated', count: 1 }),
]);
const pulito = data([c({ name: 'Arch — system + AUR', command: ARCH, state: 'current' }), c({ name: 'Flatpak', state: 'absent' })]);
const scaduto = data([c({ name: 'uv — Python tools', command: 'uv tool upgrade --all', state: 'current', notes: ['The uv check timed out.'] })]);
const errore = data([c({ name: 'npm — global packages', state: 'error', reason: 'spawn npm ENOENT' }), c({ name: 'Arch — system + AUR', command: ARCH, state: 'current' })]);

t('in cima: «N updates waiting» e il bottone «Update everything», PRIMA del comando e dei canali', () => {
  const h = view({ phase: 'ready', data: quattro });
  ok(/9 updates waiting/.test(h), 'manca il totale «9 updates waiting»');
  const iGo = h.indexOf('class="upd-go" data-act="confirm"');
  ok(iGo > 0 && /Update everything/.test(h.slice(iGo, iGo + 600)), 'manca il bottone «Update everything»');
  ok((h.match(/class="upd-go"/g) || []).length === 1, 'deve esserci UN solo gesto principale');
  const iCmd = h.indexOf('flatpak</span> <span class="t">update</span> <span class="t">&amp;&amp;'), iCopy = h.indexOf('class="upd-copy"'), iCh = h.indexOf('<details class="upd-ch');
  ok(iCmd > iGo, 'il comando unico non c\'è, o viene prima del bottone');
  ok(iCopy > iCmd, 'manca «Copy command» dopo il comando (la seconda strada)');
  ok(iCh > iCopy, 'i canali vengono prima del blocco principale');
});
t('«Update everything» non avvia niente: prima una conferma nello stesso blocco', () => {
  const h = view({ phase: 'ready', data: quattro });
  ok(!/data-act="start"/.test(h), 'il bottone che avvia c\'è già senza conferma');
  const c = view({ phase: 'ready', data: quattro, confirm: true });
  ok(/Update 9 packages now\?/.test(c), 'manca la domanda «Update 9 packages now?»');
  ok(/The PC asks for its password/.test(c), 'non avvisa che il PC chiede la password (c\'è Arch)');
  ok(/data-act="start"[^>]*>Update</.test(c) && /data-act="cancel"[^>]*>Cancel</.test(c), 'mancano Update / Cancel');
  ok(!/\bconfirm\s*\(/.test(src.replace(/^\s*(\/\/|\*).*$/gm, '')), 'usa un popup di sistema (confirm())');
  // L'avvio parte SOLO da act('start'), col corpo {confirm:true}: mai un comando dal client.
  ok(/what === 'start'\) start\(\)/.test(src) && /postJson\('\/update\/start', \{ confirm: true \}\)/.test(src), 'l\'avvio non passa dalla conferma o manda altro che {confirm:true}');
});
t('i dettagli dei canali sono chiusi di base', () => {
  const h = view({ phase: 'ready', data: quattro });
  ok((h.match(/<details class="upd-ch/g) || []).length === 4, 'attese 4 righe-canale <details>');
  ok(!/<details[^>]*\sopen/.test(h), 'una riga nasce aperta');
});
t('tutto aggiornato: una riga calma, nessun comando da copiare', () => {
  const h = view({ phase: 'ready', data: pulito });
  ok(/Everything is up to date/.test(h), 'manca «Everything is up to date»');
  ok(!/upd-copy/.test(h), 'c\'è un Copy senza niente da copiare');
  ok(/Not set up on Computer: Flatpak/.test(h), 'il canale assente non è nominato in fondo');
});
t('un controllo scaduto non è «up to date»', () => {
  const h = view({ phase: 'ready', data: scaduto });
  ok(!/Everything is up to date/.test(h) && !/>up to date</.test(h), 'dice «up to date» su un controllo scaduto');
  ok(/not sure/.test(h) && /timed out/.test(h), 'non dice che il controllo è incompleto');
});
t('un canale in errore mostra il motivo senza aprire la riga', () => {
  const h = view({ phase: 'ready', data: errore });
  const sum = h.slice(h.indexOf('<summary>'), h.indexOf('</summary>'));
  ok(/spawn npm ENOENT/.test(sum) && /error/.test(sum), 'il motivo dell\'errore è nascosto');
});
t('in controllo e senza risposta: stato dichiarato, Check again', () => {
  const l = view({ phase: 'loading' });
  ok(/Checking for updates/.test(l) && /upd-again" disabled/.test(l), 'il controllo in corso non si vede');
  ok(/Still checking/.test(view({ phase: 'loading', slow: true })), 'manca la riga «Still checking»');
  const d = view({ phase: 'down', headline: 'No reply from the server', detail: 'x' });
  ok(/No reply from the server/.test(d) && /Check again/.test(d), 'lo stato «nessuna risposta» non si vede');
});
t('i nomi arrivano scappati (niente HTML dal server)', () => {
  const h = view({ phase: 'ready', data: data([c({ name: '<img src=x>', command: 'a', state: 'outdated', count: 1 })]) });
  ok(!/<img src=x>/.test(h), 'HTML non scappato');
});
t('CSS del plugin: nessun colore scritto a mano, solo variabili', () => {
  const css = (src.match(/var CSS = \[([\s\S]*?)\]\.join/) || [])[1];
  ok(css, 'blocco CSS non trovato');
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g), lit = css.match(/rgba?\(\s*\d/g), named = css.match(/:\s*(white|black)\b/g);
  ok(!hex && !lit && !named, 'colori scritti a mano: ' + JSON.stringify([hex, lit, named]));
  for (const v of ['--green-rgb', '--orange-rgb', '--red-rgb']) ok(mainCss.includes(v + ':'), v + ' manca in main.css');
});
t('bersagli da 44px (52 il gesto principale e le risposte)', () => {
  for (const [sel, min] of [['.upd-go{', 52], ['.upd-ans{', 52], ['.upd-copy,.upd-copy2{', 44], ['.upd-again{', 44], ['.upd-ch>summary{', 44], ['.upd-alt>summary{', 44], ['.upd-ghost{', 44], ['.upd-send{', 44], ['.upd-in{', 44]]) {
    const i = src.indexOf("'" + sel); ok(i > 0, sel + ' non trovato');
    const r = src.slice(i, src.indexOf("'", i + 1));
    const m = r.match(/min-height:(\d+)px/); ok(m && +m[1] >= min, sel + ' sotto i ' + min + 'px');
  }
});
t('dottrina: copia col helper comune, comando Arch intatto, niente token nell\'indirizzo', () => {
  ok(/window\.copyToClipboard\(/.test(src), 'non usa window.copyToClipboard');
  const codice = src.replace(/^\s*(\/\/|\*).*$/gm, '');
  ok(!/navigator\.clipboard/.test(codice), 'chiama navigator.clipboard diretto');
  ok(!/--noconfirm|--useask/.test(codice), 'flag vietati nel client');
  ok(!/[?&]token=/.test(codice), 'un token nell\'indirizzo');
  ok(/window\.UI\.authFetch\(/.test(codice), 'non passa da window.UI.authFetch');
  ok(server.includes("'yay -Syu --answerdiff=None --answeredit=None --answerclean=None --removemake'"), 'comando Arch cambiato');
});

// ── La vista viva ────────────────────────────────────────────────────
const T = () => { ok(api && api._test, 'il plugin non espone _test (phrase, askHtml, runSection)'); return api._test; };
const meta = { startedAt: Date.now(), channels: ['Arch — system + AUR', 'Flatpak'], totalUpdates: 9 };
const run = (o) => Object.assign({ id: 'a'.repeat(32), state: 'live', meta, log: '', size: 10, st: { running: true, ask: null, progress: null, meta } }, o);
t('la password: type=password, autocomplete new-password, etichetta, Send', () => {
  const h = T().askHtml({ kind: 'password', line: 'Password of the PC' }, run());
  ok(/<input[^>]*type="password"/.test(h), 'la casella non è type=password');
  ok(/<input[^>]*autocomplete="new-password"/.test(h), 'manca autocomplete="new-password"');
  ok(/Password of the PC/.test(h) && /type="submit"[^>]*>Send</.test(h), 'mancano l\'etichetta o Send');
});
t('la password si svuota all\'invio e non la tiene niente', () => {
  const m = src.match(/var body = JSON\.stringify\(\{ id: S\.run\.id, text: input\.value \}\);\s*input\.value = '';\s*sendBody\(body\);/);
  ok(m, 'il valore non viene svuotato subito dopo averlo letto (prima dell\'invio)');
  const codice = src.replace(/^\s*(\/\/|\*).*$/gm, '');
  ok(!/(localStorage|sessionStorage)\.setItem\([^)]*(input|text|pass)/i.test(codice), 'una risposta finisce nello storage');
  ok(!/console\.\w+\([^)]*(input|body)/.test(codice), 'una risposta finisce in console');
});
t('nessun bottone Stop, in nessuno stato', () => {
  const asks = [null, { kind: 'password', line: 'p' }, { kind: 'yesno', line: ':: Remove x? [y/N]' }, { kind: 'choice', line: 'Enter a number (default=1):', ctx: '1) a  2) b' }, { kind: 'text', line: '==>' }];
  for (const a of asks) {
    const h = T().runSection(run({ st: { running: true, ask: a, meta } }));
    ok(!/<button[^>]*>[^<]*\bStop\b/i.test(h), 'c\'è un bottone Stop (' + (a && a.kind) + ')');
  }
  ok(!/\/update\/(stop|kill|cancel)/.test(src), 'il client chiama una rotta che ferma');
});
t('le domande: yes/no col default visibile, scelta numerata, testo', () => {
  const y = T().askHtml({ kind: 'yesno', line: ':: Remove plasma-x11-session? [y/N]' }, run());
  ok(/\[y\/N\]/.test(y) && /data-answer="y"[^>]*>Yes/.test(y) && /data-answer="n"[^>]*>No<small>default/.test(y), 'yes/no o default mancanti');
  const c = T().askHtml({ kind: 'choice', line: 'Enter a number (default=1):', ctx: ':: There are 2 providers available for jack:\n   1) jack2  2) pipewire-jack\n' }, run());
  ok(/data-answer="1"/.test(c) && /data-answer="2"/.test(c) && /pipewire-jack/.test(c), 'la scelta numerata non mostra i numeri');
  ok(/<input[^>]*type="text"/.test(T().askHtml({ kind: 'text', line: '==>' }, run())), 'la domanda di testo non ha la casella');
});
t('la frase sola sullo stato, dall\'ultima riga utile', () => {
  const P = T().phrase;
  ok(P(run({ log: '(123/231) upgrading foo\n', st: { running: true, progress: { n: 123, total: 231, what: 'upgrading', pkg: 'foo' } } })) === 'Updating 123 of 231', 'non dice «Updating 123 of 231»');
  ok(P(run({ log: '==> Making package: spotify 1:1.2-1 (x)\n==> Retrieving sources...\n' })) === 'Building Spotify…', 'non dice «Building Spotify…»');
  ok(P(run({ log: ':: Synchronizing package databases...\n core downloading...\n' })) === 'Downloading…', 'non dice «Downloading…»');
  ok(P(run({ st: { running: true, ask: { kind: 'password' } } })) === 'Waiting for you', 'una domanda aperta non dice «Waiting for you»');
});
t('fine giro: fatto (+ riavvio), fermato, interrotto', () => {
  const R = T().runSection;
  const okH = R(run({ state: 'ok', st: { exit: 0, changed: 231, restartAdvised: true, meta } }));
  ok(/Done — 231 packages updated/.test(okH) && /Restart the PC when you can/.test(okH) && /New system parts are waiting/.test(okH), 'fatto/riavvio mancanti');
  ok(!/Restart the PC/.test(R(run({ state: 'ok', st: { exit: 0, changed: 3, restartAdvised: false, meta } }))), 'consiglia il riavvio quando non serve');
  ok(/The update stopped/.test(R(run({ state: 'failed', log: 'error: boom\n', st: { exit: 1, meta } }))), 'manca «The update stopped»');
  const lost = R(run({ state: 'lost', log: 'last line here\n', st: { lost: true, meta } }));
  ok(/The update was interrupted/.test(lost) && /last line here/.test(lost), 'interrotto senza le ultime righe');
});
t('il giro vivo passa da window.Battito, si riattacca a un 409, dice il 403 in chiaro', () => {
  const codice = src.replace(/^\s*(\/\/|\*).*$/gm, '');
  ok(/window\.Battito\.ogni\('updates-run'/.test(codice) && !/setInterval\(/.test(codice), 'il giro non passa da Battito');
  ok(/x\.status === 409 && x\.body\.id\)\s*\{\s*attach\(x\.body\.id/.test(codice), 'un 409 non si riattacca all\'aggiornamento in corso');
  ok(/r\.status === 403\) msg\('[^']*Tailscale/.test(codice), 'il 403 non nomina Tailscale');
  ok(/'\/update\/current'/.test(codice), 'all\'apertura non chiede /update/current');
});

console.log(`\nupdates-un-gesto: ${n - rossi}/${n} verdi`);
process.exit(rossi ? 1 : 0);
