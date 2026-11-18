#!/usr/bin/env node
'use strict';

// [12/10/2026] Il riconoscitore dei comandi di riavvio/consegna
// (server/stream-handler.js, isRestartCommand) deve scattare SOLO quando il
// comando ESEGUE il riavvio, mai quando la stessa parola è l'argomento di chi
// legge. Prima era una regex (RESTART_CMD_RE) che scattava anche su
// `grep 'pm2 restart'` e `rg /api/deploy` → la sessione che LEGGEVA veniva
// segnata come colpevole del riavvio.
//
// Sul codice vecchio: se l'export non c'è, si estrae la regex dal sorgente e
// la si prova sugli stessi casi → i casi «falsi» la mandano rossa.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server', 'stream-handler.js');
let isRestart = require(FILE).isRestartCommand;
if (typeof isRestart !== 'function') {
  const src = fs.readFileSync(FILE, 'utf8');
  const m = src.match(/const RESTART_CMD_RE = (\/.*\/[a-z]*);/);
  if (!m) { console.log('FAIL né isRestartCommand né RESTART_CMD_RE'); process.exit(1); }
  // eslint-disable-next-line no-eval
  const re = eval(m[1]);
  isRestart = (c) => re.test(c);
  console.log('(codice vecchio: provo la regex RESTART_CMD_RE)');
}

const VERI = [
  'pm2 restart the-151-machine',
  'pm2 reload all',
  'pm2 start ecosystem.linux.config.js --update-env',
  'cd /home/x/the-151-machine && pm2 restart 0',
  'git pull; pm2 resurrect',
  'bash tools/deploy.sh',
  './tools/deploy.sh --pi',
  'tools/deploy-pi.sh',
  'cd repo && bash tools/deploy-pi.sh 2>&1 | tail -20',
  'sh /home/x/repo/tools/deploy.sh',
  'source tools/deploy.sh',
  'bash -c "pm2 restart 0"',
  'npx pm2 restart 0',
  'sudo pm2 kill',
  'FOO=1 pm2 restart x',
  'curl -s -X POST http://127.0.0.1:3170/api/deploy -H "Authorization: Bearer x"',
  'echo ok || pm2 restart 0',
];

const FALSI = [
  "grep -rn 'pm2 restart' server/",
  'grep -n "pm2 reload" tools/*.sh',
  'rg /api/deploy server',
  'grep -rn /api/deploy public/js',
  "grep -n deploy tools/deploy.sh",
  "sed -n '1,9p' tools/deploy.sh",
  'cat tools/deploy-pi.sh',
  'less tools/deploy.sh',
  'head -50 tools/deploy.sh',
  'tail -f ~/.151machine/deploy-logs/x.log | grep pm2',
  'git log --oneline -- tools/deploy.sh',
  'git diff tools/deploy-pi.sh',
  'pm2 ls',
  'pm2 logs the-151-machine --lines 50',
  'pm2 jlist | python3 -c "import json"',
  'echo "remember: pm2 restart is forbidden"',
  'grep -c "a; pm2 restart" notes.md',
  'node -c tools/deploy.js',
  'ls tools | grep deploy',
];

let failed = 0;
for (const c of VERI) {
  const ok = isRestart(c) === true;
  if (!ok) failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + 'riavvio vero:  ' + c);
}
for (const c of FALSI) {
  const ok = isRestart(c) === false;
  if (!ok) failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + 'sola lettura:  ' + c);
}
console.log(`\nrestart-cmd: ${VERI.length + FALSI.length - failed} ok, ${failed} falliti`);
process.exit(failed ? 1 : 0);
