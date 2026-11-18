'use strict';

// =============================================================================
// IL MURO DEI FILE PLUGIN (2026-09-27, )
// Prima /plugins serviva l'intera cartella plugins/ con una lista NERA, e
// public/plugins/ riceveva ogni .js tranne server.js: i moduli server
// (book-facts.js, stream-gate.js, i moduli di playlist-doctor, …) erano
// leggibili senza login. Ora è una lista BIANCA: di un plugin esce solo il
// `client` del suo manifest. Questo test monta il guardiano ESATTAMENTE come
// server/index.js + server/plugin-loader.js (guardiano → public/ → plugins/)
// su una porta effimera, contro una cartella finta e contro i plugin VERI.
// Puro: niente server vivo, niente login, niente scritture fuori da /tmp.
// =============================================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createPluginStaticGuard, declaredClientFile } = require('../server/plugin-loader');

const REAL_PLUGINS = path.join(__dirname, '..', 'plugins');

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function mount(pluginsDir, publicDir) {
  const app = express();
  // stesso ordine del vero: guardiano davanti a public/, poi il loader.
  app.use('/plugins', createPluginStaticGuard(pluginsDir));
  app.use(express.static(publicDir));
  app.use('/plugins', createPluginStaticGuard(pluginsDir), express.static(pluginsDir, { dotfiles: 'deny', index: false }));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  let checks = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

  // ── A. cartella finta ──────────────────────────────────────────────────────
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-guard-'));
  const plugins = path.join(root, 'plugins');
  const pub = path.join(root, 'public');
  const fake = path.join(plugins, 'fake');
  fs.mkdirSync(path.join(fake, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'manifest.json'), JSON.stringify({ id: 'fake', client: 'client.js', server: 'server.js' }));
  fs.writeFileSync(path.join(fake, 'client.js'), 'CLIENT');
  fs.writeFileSync(path.join(fake, 'server.js'), 'SERVER-SECRET');
  fs.writeFileSync(path.join(fake, 'helper.js'), 'SERVER-MODULE');
  fs.writeFileSync(path.join(fake, 'tool.py'), 'PY');
  fs.writeFileSync(path.join(fake, 'state.json'), '{}');
  fs.writeFileSync(path.join(fake, 'sub', 'x.js'), 'NESTED');
  // un plugin che prova a dichiarare il server come client
  fs.mkdirSync(path.join(plugins, 'furbo'));
  fs.writeFileSync(path.join(plugins, 'furbo', 'manifest.json'), JSON.stringify({ id: 'furbo', client: 'server.js' }));
  fs.writeFileSync(path.join(plugins, 'furbo', 'server.js'), 'SERVER-SECRET');
  // uno che prova a uscire dalla cartella
  fs.mkdirSync(path.join(plugins, 'fuga'));
  fs.writeFileSync(path.join(plugins, 'fuga', 'manifest.json'), JSON.stringify({ id: 'fuga', client: '../fake/server.js' }));
  // un plugin senza client (tipo auto-skills)
  fs.mkdirSync(path.join(plugins, 'solo-server'));
  fs.writeFileSync(path.join(plugins, 'solo-server', 'manifest.json'), JSON.stringify({ id: 'solo-server' }));
  fs.writeFileSync(path.join(plugins, 'solo-server', 'server.js'), 'SERVER-SECRET');
  fs.writeFileSync(path.join(plugins, '_registry.json'), '{"fake":{"enabled":true}}');
  // la copia VECCHIA in public/: un modulo server lasciato lì da un sync di prima
  fs.mkdirSync(path.join(pub, 'plugins', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'plugins', 'fake', 'client.js'), 'CLIENT-PUBLIC');
  fs.writeFileSync(path.join(pub, 'plugins', 'fake', 'helper.js'), 'SERVER-MODULE-PUBLIC');
  fs.writeFileSync(path.join(pub, 'plugins', 'fake', 'config.json'), '{}');

  ok(declaredClientFile(plugins, 'fake') === 'client.js', 'client dichiarato letto');
  ok(declaredClientFile(plugins, 'furbo') === null, 'server.js non può essere il client');
  ok(declaredClientFile(plugins, 'fuga') === null, 'un client con percorso è rifiutato');
  ok(declaredClientFile(plugins, 'solo-server') === null, 'plugin senza client: niente');
  ok(declaredClientFile(plugins, '..') === null && declaredClientFile(plugins, '_registry.json') === null, 'id malformati rifiutati');

  const srv = await mount(plugins, pub);
  const port = srv.address().port;
  try {
    let r = await get(port, '/plugins/fake/client.js?v=abc');
    ok(r.status === 200 && r.body === 'CLIENT-PUBLIC', 'il client esce (dalla copia in public/)');
    const deny = [
      '/plugins/fake/server.js', '/plugins/fake/helper.js', '/plugins/fake/tool.py',
      '/plugins/fake/state.json', '/plugins/fake/manifest.json', '/plugins/fake/sub/x.js',
      '/plugins/fake/config.json', '/plugins/fake/', '/plugins/fake', '/plugins/_registry.json',
      '/plugins/furbo/server.js', '/plugins/fuga/client.js', '/plugins/solo-server/server.js',
      '/plugins/fake/%73erver.js', '/plugins/fake%2Fserver.js', '/plugins/fake/..%2Fserver.js',
      '/plugins/fake/%E0%A4%A', '/plugins//fake/server.js', '/plugins/FAKE/server.js',
      '/plugins/fake/client.js/../server.js',
    ];
    for (const p of deny) {
      r = await get(port, p);
      ok(r.status === 404, `${p} → 404 (era ${r.status})`);
      ok(!/SECRET|MODULE|NESTED|PY/.test(r.body), `${p} non rivela niente`);
    }
    // senza copia in public/ il client esce dal loader (plugin non ancora sincronizzato)
    fs.rmSync(path.join(pub, 'plugins', 'fake', 'client.js'));
    r = await get(port, '/plugins/fake/client.js');
    ok(r.status === 200 && r.body === 'CLIENT', 'client servito da plugins/ se manca in public/');
  } finally {
    srv.close();
  }

  // ── B. i plugin VERI: ogni file che non è il client dichiarato è 404 ────────
  const srv2 = await mount(REAL_PLUGINS, path.join(__dirname, '..', 'public'));
  const port2 = srv2.address().port;
  let realDenied = 0;
  try {
    for (const id of fs.readdirSync(REAL_PLUGINS)) {
      const dir = path.join(REAL_PLUGINS, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      const client = declaredClientFile(REAL_PLUGINS, id);
      for (const f of fs.readdirSync(dir)) {
        if (!fs.statSync(path.join(dir, f)).isFile()) continue;
        const r = await get(port2, `/plugins/${id}/${encodeURIComponent(f)}`);
        if (f === client) {
          ok(r.status === 200, `${id}/${f} è il client: deve uscire (era ${r.status})`);
        } else {
          ok(r.status === 404, `${id}/${f} NON è il client: deve essere 404 (era ${r.status})`);
          realDenied++;
        }
      }
      // e la copia in public/: niente che non sia il client
      const pubDir = path.join(__dirname, '..', 'public', 'plugins', id);
      if (fs.existsSync(pubDir)) {
        for (const f of fs.readdirSync(pubDir)) {
          if (f === client) continue;
          const r = await get(port2, `/plugins/${id}/${encodeURIComponent(f)}`);
          ok(r.status === 404, `public/plugins/${id}/${f} (copia vecchia) → 404 (era ${r.status})`);
          realDenied++;
        }
      }
    }
  } finally {
    srv2.close();
  }
  ok(realDenied > 10, `almeno i moduli server noti sono stati provati (${realDenied})`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`plugin-static-guard.test.js: PASS (${checks} controlli, ${realDenied} file veri non-client murati)`);
})().catch((e) => { console.error(e); process.exit(1); });
