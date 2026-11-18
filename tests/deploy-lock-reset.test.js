#!/usr/bin/env node
'use strict';

// [12/10/2026] server/deploy.js, deployRoute: nel ramo «restart.lock occupato»
// si rimetteva a false solo deployInProgress e non DEPLOY_IN_PROGRESS → da lì
// in poi OGNI /api/deploy rispondeva 409 deploy_in_progress fino al riavvio.
//
// Prova pura: niente server, niente file scritti. Il lock si finge
// intercettando fs.readFileSync sul suo percorso; il secondo deploy è un «hot»
// (nessun riavvio, nessun lock acquisito) e deve passare.

const fs = require('fs');
const path = require('path');

// deploy.js al caricamento pulisce un lock «stantio» e alla USCITA del processo
// cancella tmp/restart.lock (process.on('exit')). Una prova non deve mai
// toccare il lock vero di chi la lancia: unlink e lettura del lock sono finti
// PRIMA del require, e l'unlink resta finto fino all'uscita.
const LOCK = path.join(__dirname, '..', 'tmp', 'restart.lock');
const realUnlink = fs.unlinkSync;
fs.unlinkSync = function (p, ...rest) {
  if (path.resolve(String(p)) === LOCK) return;
  return realUnlink.call(this, p, ...rest);
};

let lockHeld = false;
const realRead = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (p === LOCK) {
    if (!lockHeld) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return JSON.stringify({ pid: process.pid, ts: Date.now(), caller: 'prova' });
  }
  return realRead.call(this, p, ...rest);
};

const deploy = require(path.join(__dirname, '..', 'server', 'deploy.js'));
if (deploy.RESTART_LOCK_PATH !== LOCK) { console.log('FAIL percorso del lock cambiato: ' + deploy.RESTART_LOCK_PATH); process.exit(1); }

const serverState = { CODE_HASH: 'diverso', BUILD_HASH: 'b', DEPLOY_HASH: 'd', shutdownInProgress: false };
const handler = deploy.createDeployHandler({
  manager: { setDeployMarker() {} },
  wss: { clients: new Set() },
  restartIntent: {},
  closeServersAndExit() { throw new Error('non deve uscire'); },
  serverState,
  getPluginManager: null,
});

function call(body) {
  let out = null;
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { out = { code: this.statusCode, body: o }; return this; },
  };
  const req = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, body, get: () => '-' };
  handler.deployRoute(req, res);
  return out;
}

const log = console.log;
console.log = () => {};
let failed = 0;
const results = [];
try {
  lockHeld = true;
  const r1 = call({ mode: 'full', files_changed: ['x.js'] });
  results.push(['lock occupato → 409 con holder', r1 && r1.code === 409 && r1.body && 'holder' in r1.body, r1]);
  lockHeld = false;
  const r2 = call({ mode: 'hot' });
  results.push(['dopo il lock occupato un deploy hot passa (non 409)', r2 && r2.code === 200 && r2.body.status === 'hot_reload', r2]);
} finally {
  console.log = log;
  fs.readFileSync = realRead;
}
for (const [name, ok, r] of results) {
  if (!ok) failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : ' — ' + JSON.stringify(r)));
}
console.log(`\ndeploy-lock-reset: ${results.length - failed} ok, ${failed} falliti`);
process.exit(failed ? 1 : 0);
