#!/usr/bin/env node
'use strict';
// [12/11/2026 ] La Machine sa che una sessione si è chiusa con l'agente Wrap:
// lo stream VERO (server/stream-handler.js) vede la skill «wrap» e chiama
// manager.markWrapped; quella di un aiutante (parent_tool_use_id) no.
const path = require('path');
const { Readable } = require('stream'); const EE = require('events');
const create = require(path.join(__dirname, '..', 'server/stream-handler.js'));
const marks = [];
const sess = { id: 'S1', history: [], status: 'busy' };
const manager = new Proxy({ sessions: new Map([['S1', sess]]), markWrapped: (id) => marks.push(id) }, { get: (t, k) => k in t ? t[k] : (() => undefined) });
const h = create({ manager, sendToSession() {}, broadcastSessionStatus() {}, getPluginManager: () => null });
const proc = new EE(); proc.stdout = new Readable({ read() {} }); proc.stderr = new Readable({ read() {} });
h.spawnStreamHandler(proc, 'S1');
const riga = (o) => proc.stdout.push(JSON.stringify(o) + '\n');
riga({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't0', name: 'Skill', input: { skill: 'apps' } }] } });
riga({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'wrap' } }] } });
setTimeout(() => {
  const prima = marks.length;
  riga({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'wrap' } }] } });
  setTimeout(() => {
    let fail = 0;
    const ok = (c, n) => { console.log((c ? '  ok   ' : '  FAIL ') + n); if (!c) fail++; };
    ok(prima === 0, 'un\'altra skill, o il wrap di un aiutante: la sessione non è segnata');
    ok(marks.length === 1 && marks[0] === 'S1', 'la skill «wrap» della sessione: segnata');
    process.exit(fail ? 1 : 0);
  }, 200);
}, 200);
