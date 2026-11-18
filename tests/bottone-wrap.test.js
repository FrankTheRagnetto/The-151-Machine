'use strict';
// Bottone Wrap: fra File e Copy, al posto di Idea, «un
// semplice /wrap button, come avevamo un tempo». Il tocco scrive /wrap nella
// chat aperta e lo manda; senza chat aperta non manda niente. Puro: il client
// del plugin gira in una sandbox, nessun server.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let n = 0, rossi = 0;
function ok(c, nome) { n++; if (c) console.log('  ✓ ' + nome); else { rossi++; console.log('  ✗ ' + nome); } }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/quick-actions/config.json'), 'utf8'));
const ids = cfg.actions.map((a) => a.id);
ok(JSON.stringify(ids) === JSON.stringify(['attach-file', 'wrap', 'copy-chat']), 'barra: File, Wrap, Copy (ora: ' + ids.join(', ') + ')');
ok(!ids.includes('idea-dumper'), 'il bottone Idea non c\'è più');
// (scelta A): l'Idea Dumper esce del tutto, non solo il bottone.
ok(!fs.existsSync(path.join(ROOT, 'public/js/idea-dumper.js')), 'il file dell\'Idea Dumper non c\'è più');
const pagina = ['public/index.html', 'public/js/input.js', 'public/js/dictation.js', 'public/js/core.js', 'public/css/main.css']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
ok(!/IdeaDumper|idea-dumper-panel|view-idea-dumper/.test(pagina), 'nessun aggancio all\'Idea Dumper in pagina, invio, dettatura, stile');

function avvia(sessione, testoGiaScritto) {
  const reg = {}, spedite = [], avvisi = [];
  const input = { value: testoGiaScritto, dispatchEvent() {} };
  const window = {
    The151Machine: {
      register() {}, getActiveSession: () => sessione,
      registerToolbarAction: (id, o) => { reg[id] = o; },
      showToast: (t) => avvisi.push(t),
    },
    UI: { authFetch: () => Promise.resolve({ json: () => cfg }) },
    sendMessage: () => spedite.push(input.value),
  };
  const ctx = { window, document: { getElementById: (id) => (id === 'message-input' ? input : null) },
    Event: function () {}, console, navigator: {}, setTimeout, Promise };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'plugins/quick-actions/client.js'), 'utf8'), ctx);
  return { reg, spedite, avvisi, input };
}

(async () => {
  const a = avvia('s1', '');
  await new Promise((r) => setImmediate(r));
  const w = a.reg['quick-actions-wrap'];
  ok(!!w && w.label === 'Wrap' && /<svg/.test(w.iconSvg), 'il bottone Wrap è registrato, con la sua icona');
  if (w) w.onClick();
  ok(a.spedite.length === 1 && a.spedite[0] === '/wrap', 'tocco → manda «/wrap» nella chat aperta');

  const b = avvia('s1', 'ultima cosa');
  await new Promise((r) => setImmediate(r));
  b.reg['quick-actions-wrap'] && b.reg['quick-actions-wrap'].onClick();
  ok(b.spedite[0] === 'ultima cosa\n/wrap', 'il testo già scritto resta, /wrap va sotto');

  const c = avvia(null, '');
  await new Promise((r) => setImmediate(r));
  c.reg['quick-actions-wrap'] && c.reg['quick-actions-wrap'].onClick();
  ok(c.spedite.length === 0 && c.avvisi.length === 1, 'nessuna chat aperta → niente mandato, un avviso');

  console.log(`bottone-wrap: ${n - rossi}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
})();
