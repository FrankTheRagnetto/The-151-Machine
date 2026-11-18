#!/usr/bin/env node
'use strict';
// [12/11/2026 ] Super agenti scelti: quali (la scheda speciale sempre), colore, icona.
// I punti di partenza vengono dal file delle squadre (docs/squadre.example.json),
// nel codice nessuno. Pura: il blocco vero di public/js/sessions.js e la pagina
// vera di plugins/super-agents/client.js, eseguiti in node con un window finto.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const props = {};
const store = {};
const ctx = {
  console, JSON, parseInt, Object,
  localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  document: { documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8').match(/window\.IC = \(function\(\) \{[\s\S]*?\n\}\)\(\);/)[0], ctx);
const ses = fs.readFileSync(path.join(ROOT, 'public/js/sessions.js'), 'utf8');
const blocco = ses.match(/\/\/ --- Team Launcher v2 ---[\s\S]*?function detectSuperSession\(k\) \{[\s\S]*?\n\}\n/)[0]
  .replace('const TEAMS', 'var TEAMS').replace(/\bIC\./g, 'window.IC.');
let disegni = 0;
ctx.renderSessionList = () => { disegni++; };
ctx.sessions = [];
ctx.detectAgentSession = () => null;
vm.runInContext('var FLEET_TYPE_BY_KEY = {};\n' + blocco + '\nwindow.superAccesi = superAccesi; window.TEAMS = TEAMS; window.superVeste = superVeste; window.tipi = function () { return FLEET_TYPE_BY_KEY; };', ctx);

// Senza file: niente super agenti, niente scheda speciale.
ok(JSON.stringify(ctx.superAccesi()) === '[]' && ctx.superSpeciale() === null, 'senza file: nessun super agente e nessuna scheda speciale');

const esempio = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/squadre.example.json'), 'utf8'));
ctx.applySquadre(esempio);
ok(JSON.stringify(ctx.superAccesi()) === '["writer"]', 'col file d\'esempio: Writer in alto, Reviewer spento');
ok(ctx.superSpeciale() === 'lead' && ctx.TEAMS.lead.command === '/lead' && ctx.TEAMS.lead.title === 'Lead', 'la scheda speciale è quella del file («Lead», /lead)');
ok(ctx.tipi().writer === 'Writer' && ctx.tipi().lead === 'Lead', 'i tipi numerati vengono dai «super» del file');
ok(ctx.superScelte({ lead: { on: false } }).lead.on === true, 'la scheda speciale non si spegne');
ok(ctx.superScelte({ writer: { color: 'rosso', icon: 'boh' } }).writer.color === '#38bdf8' && ctx.superScelte({ writer: { icon: 'boh' } }).writer.icon === 'fileText',
  'colore o icona che non esistono: resta quello del file');
ok(props['--agent-special'] === '#facc15' && props['--agent-special-rgb'] === '250, 204, 21', 'la scheda speciale prende il colore del suo agente');
const prima = disegni;
ctx.applySuperAgents({ reviewer: { on: true, color: '#34d399', icon: 'shield' } }, true);
ok(JSON.stringify(ctx.superAccesi()) === '["writer","reviewer"]', 'Reviewer acceso: va in alto');
ok(props['--agent-reviewer'] === '#34d399' && props['--agent-reviewer-rgb'] === '52, 211, 153', 'il colore scelto colora la scheda (anche l\'alone)');
ok(ctx.TEAMS.reviewer.icon === ctx.IC.shield, 'l\'icona scelta va sulla scheda');
ok(disegni === prima + 1, 'la barra si ridisegna subito');
ok(JSON.parse(store['super-agents']).reviewer.color === '#34d399', 'la scelta resta sul telefono anche a PC spento');

// La pagina
ctx.The151Machine = { register: (id, api) => { ctx._pagina = api; } };
ctx.UI = { authFetch: () => Promise.resolve({ ok: false }) };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'plugins/super-agents/client.js'), 'utf8'), ctx);
const g = ctx._pagina._test.gesto;
const base = ctx.superScelte(null);
const html = ctx._pagina.view(base);
ok(/Always on top/.test(html) && /data-agent="writer"/.test(html) && !/data-agent="reviewer"/.test(html), 'pagina: in lista Lead e Writer, Reviewer no');
ok(!/data-act="icon"/.test(html) && /Add a super agent/.test(html), 'pagina chiusa: solo le righe e «Add a super agent»');
const aperta = ctx._pagina.view(base, '', 'writer');
const icone = (aperta.match(/data-act="icon" data-agent="writer"/g) || []).length;
ok(icone >= 20 && /Color<\/p>/.test(aperta) && /data-act="remove" data-agent="writer"/.test(aperta), 'riga toccata: «Color», «Icon» (' + icone + ') e «Remove»');
ok(!/data-act="remove" data-agent="lead"/.test(ctx._pagina.view(base, '', 'lead')), 'la scheda speciale non si toglie');
const cat = [{ key: 'apps', name: 'Apps', command: '/apps' }, { key: 'writer', name: 'Writer', command: '/writer' }, { key: 'reviewer', name: 'Reviewer', command: '/reviewer' }];
const lista = ctx._pagina.view(base, '', null, cat, true);
ok(/data-act="add" data-agent="apps"/.test(lista) && /data-act="add" data-agent="reviewer"/.test(lista) && !/data-act="add" data-agent="writer"/.test(lista),
  'aggiungi: la lista mostra gli agenti che non sono già in alto');
ok(/could not be reached/.test(ctx._pagina.view(base, '', null, false, true)), 'aggiungi a PC spento: lo dice');
let s2 = g(base, 'add', 'apps', 'Apps');
ctx.applySuperAgents(s2);
ok(JSON.stringify(ctx.superAccesi()) === '["writer","apps"]', 'Apps aggiunto: va in alto, dopo Writer');
ok(ctx.TEAMS.apps && ctx.TEAMS.apps.command === '/apps' && ctx.TEAMS.apps.icon === ctx.IC.messageCircle, 'la sua scheda apre /apps (icona di partenza: la bolla)');
ok(s2.apps.color !== s2.writer.color, 'un agente aggiunto prende un colore non ancora usato');
s2 = g(s2, 'up', 'apps');
ok(JSON.stringify(Object.keys(s2).filter(k => !s2[k].special && s2[k].on).sort((a, b) => s2[a].pos - s2[b].pos)) === '["apps","writer"]', '«Move up»: Apps sale sopra Writer');
s2 = g(s2, 'remove', 'writer');
ctx.applySuperAgents(s2);
ok(JSON.stringify(ctx.superAccesi()) === '["apps"]', '«Remove»: Writer esce dall\'alto');
ok(g(s2, 'remove', 'lead').lead.on === true, '«Remove» sulla scheda speciale: non succede niente');

// L'elenco degli agenti dal PC
const srv = require(path.join(ROOT, 'plugins/super-agents/server.js'))._test;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sa-'));
fs.writeFileSync(path.join(tmp, 'apps.md'), '---\ndescription: "Apps 📱 — una porta sola"\n---\n');
fs.writeFileSync(path.join(tmp, 'wrap.md'), '---\ndescription: "Wrap — chiusura"\n---\n');
fs.writeFileSync(path.join(tmp, '_template.md'), 'x');
fs.writeFileSync(path.join(tmp, 'music.md'), '---\ndescription: "Music 🎧 — musica"\n---\n');
const el = srv.elenco(tmp);
ok(JSON.stringify(el.map(x => x.key + '=' + x.name)) === '["apps=Apps","music=Music"]', 'elenco: ogni agente col suo nome, senza modello e senza wrap');
fs.rmSync(tmp, { recursive: true, force: true });

// [12/11 il proprietario «so many more things should be green… no model selector»]
const vestita = ctx.superVeste('<div class="session-item-wrap" data-id="x"><div class="session-item team-upgrade" data-id="x">', 'writer');
ok(/class="session-item-wrap"/.test(vestita) && /style="--sc-rgb:56, 189, 248" class="session-item super-card team-upgrade"/.test(vestita), 'la scheda viva prende il colore dell\'agente (non il contenitore)');
const css = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8');
ok(/\.session-item\.super-card \{[^}]*background: rgba\(var\(--sc-rgb\)/.test(css) && /super-card:not\(\.is-live\) \.session-title \{ color: rgb\(var\(--sc-rgb\)\)/.test(css), 'colore su sfondo, strisce, nome e modello della sessione viva');
// [12/11 11:05 il proprietario «still retarded»] la scheda «Run /…» di un agente non aperto torna grigia come prima
ok(!/agent-placeholder\.super-card/.test(css), 'nessuna regola colora la scheda «Run /…»');
ok(/'<button class="agent-placeholder agent-' \+ akey \+ '" data-agent="'/.test(ses) && !/agent-placeholder super-card/.test(ses), 'la scheda «Run /…» resta grigia (niente super-card né --sc-rgb)');
ok(/window\.superAgents\[teamKey\]\.on \? 'opus'/.test(ses), 'ogni super agente apre col selettore del modello');

// Il posto: in fondo al pannello dei plugin
const ui = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');
ok(/pluginId: 'super-agents'[^\n]*\n\s*\{ kind: 'action', action: 'restartMachine'[^\n]*\n\s*\]\}\n\];/.test(ui), 'in fondo al pannello dei plugin, subito sopra «Restart machine»');

console.log(`\n${pass} ok, ${fail} falliti`);
process.exit(fail ? 1 : 0);
