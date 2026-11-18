// Sudo dal telefono: la password chiesta sullo schermo della
// Machine quando una sessione lancia sudo senza terminale.
//   A. server/sudo-telefono.js su un express vero, porta effimera: chiede,
//      risponde, annulla, scade, nessuno schermo, gettone sbagliato, fuori
//      dal PC; la password NON passa mai nel WebSocket.
//   B. tools/sudo-telefono/chiedi.js (l'aiutante di sudo) contro quel server:
//      stampa la password su stdout ed esce 0; annullata → esce 1, stdout vuoto.
//   C. tools/sudo-telefono/sudo (il guscio): -A solo in sessione Claude senza
//      terminale; -S/-n/-A lasciati stare; fuori sessione identico.
//   E/F. (/hack 07/11) niente pagine web; solo il figlio del sudo vero.
//   D. la pagina carica la casella e ws.js le passa i due messaggi.
// Il sudo VERO non si tocca qui: password sbagliate = rischio di blocco
// (faillock). La prova vera è del proprietario, dal telefono.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const express = require('express');
const { createSudoTelefono } = require('../server/sudo-telefono');

const ROOT = path.join(__dirname, '..');
let n = 0, rossi = 0;
async function t(nome, fn) {
  n++;
  try { await fn(); console.log('  ✓ ' + nome); }
  catch (e) { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); }
}

function finto() {
  const ricevuti = [];
  const schermo = { readyState: 1, send: (s) => ricevuti.push(s) };
  const wss = { clients: new Set([schermo]) };
  return { wss, schermo, ricevuti };
}
function avvia(opts) {
  const f = finto();
  const st = createSudoTelefono(Object.assign({
    getWss: () => f.wss,
    isTokenValid: (tk) => tk === 'buono',
    isLoopback: (ip) => /127\.0\.0\.1|::1/.test(ip),
    titoloDi: (cid) => (cid === 'cid-1' ? 'Apps' : null),
    // il sudo vero non c'è nelle prove: chi bussa è «sudo» per finta (E prova quello vero)
    chiamante: () => ({ ok: true, comando: 'sudo pacman -S foo' }),
  }, opts || {}));
  const app = express();
  app.use(express.json());
  app.post('/api/sudo/chiedi', st.chiedi);
  app.post('/api/sudo/rispondi', st.rispondi);
  return new Promise((ok) => {
    const srv = app.listen(0, '127.0.0.1', () => ok(Object.assign(f, { st, srv, porta: srv.address().port })));
  });
}
function post(porta, via, corpo, token, extra) {
  return new Promise((ok, ko) => {
    const s = JSON.stringify(corpo || {});
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) };
    if (token) h.Authorization = 'Bearer ' + token;
    Object.assign(h, extra || {});
    const r = http.request({ host: '127.0.0.1', port: porta, path: via, method: 'POST', headers: h }, (res) => {
      let d = ''; res.on('data', (x) => { d += x; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} ok({ status: res.statusCode, json: j }); });
    });
    r.on('error', ko); r.end(s);
  });
}
const aspetta = (ms) => new Promise((r) => setTimeout(r, ms));
async function primaRichiesta(f) {
  for (let i = 0; i < 100; i++) {
    const m = f.ricevuti.map((x) => JSON.parse(x)).find((x) => x.type === 'sudo_chiede');
    if (m) return m;
    await aspetta(10);
  }
  throw new Error('nessuna casella mandata allo schermo');
}

(async () => {
  await t('A1 chiede → la casella arriva allo schermo (comando, titolo) → risposta → la password torna a chi ha chiesto', async () => {
    const f = await avvia();
    try {
      const attesa = post(f.porta, '/api/sudo/chiedi', { comando: 'sudo FALSO', sessione: 'cid-1' });
      const m = await primaRichiesta(f);
      assert.strictEqual(m.comando, 'sudo pacman -S foo', 'il comando viene da sudo, non dal corpo');
      assert.strictEqual(m.titolo, 'Apps');
      const r = await post(f.porta, '/api/sudo/rispondi', { id: m.id, password: 'segreta-di-prova' }, 'buono');
      assert.strictEqual(r.status, 200);
      const a = await attesa;
      assert.strictEqual(a.status, 200);
      assert.strictEqual(a.json.password, 'segreta-di-prova');
      assert.ok(f.ricevuti.some((x) => JSON.parse(x).type === 'sudo_chiuso'), 'la casella si chiude ovunque');
      assert.ok(!f.ricevuti.join('').includes('segreta-di-prova'), 'la password NON passa nel WebSocket');
      assert.strictEqual(f.st._aperte.size, 0);
    } finally { f.srv.close(); }
  });

  await t('A2 annulla → 403 a sudo; gettone sbagliato → 401 e la richiesta resta aperta', async () => {
    const f = await avvia();
    try {
      const attesa = post(f.porta, '/api/sudo/chiedi', { comando: 'sudo true' });
      const m = await primaRichiesta(f);
      assert.strictEqual((await post(f.porta, '/api/sudo/rispondi', { id: m.id, password: 'x' }, 'cattivo')).status, 401);
      assert.strictEqual((await post(f.porta, '/api/sudo/rispondi', { id: m.id, password: 'x' })).status, 401);
      assert.strictEqual(f.st._aperte.size, 1);
      assert.strictEqual((await post(f.porta, '/api/sudo/rispondi', { id: m.id, annulla: true }, 'buono')).status, 200);
      assert.strictEqual((await attesa).status, 403);
      assert.strictEqual((await post(f.porta, '/api/sudo/rispondi', { id: m.id, password: 'x' }, 'buono')).status, 404, 'già chiusa');
    } finally { f.srv.close(); }
  });

  await t('A3 nessuno schermo collegato → 503 subito; scaduta → 408 e la casella si chiude', async () => {
    const f = await avvia({ attesaMs: 150 });
    try {
      f.schermo.readyState = 3;
      assert.strictEqual((await post(f.porta, '/api/sudo/chiedi', { comando: 'sudo true' })).status, 503);
      f.schermo.readyState = 1;
      const a = await post(f.porta, '/api/sudo/chiedi', { comando: 'sudo true' });
      assert.strictEqual(a.status, 408);
      assert.ok(f.ricevuti.some((x) => JSON.parse(x).type === 'sudo_chiuso'));
    } finally { f.srv.close(); }
  });

  await t('A4 la richiesta vale solo dal PC (loopback), e non più di 3 insieme', async () => {
    const f = finto();
    const st = createSudoTelefono({ getWss: () => f.wss, isTokenValid: () => true, isLoopback: () => false });
    let stato = 0;
    const res = { status(c) { stato = c; return this; }, json() { return this; }, set() { return this; }, on() {} };
    st.chiedi({ socket: { remoteAddress: '100.101.102.104' }, body: {} }, res);
    assert.strictEqual(stato, 403);
    assert.strictEqual(f.ricevuti.length, 0, 'nessuna casella per una richiesta da fuori');
    const g = await avvia();
    try {
      const tre = [1, 2, 3].map(() => post(g.porta, '/api/sudo/chiedi', { comando: 'sudo true' }));
      for (let i = 0; i < 100 && g.st._aperte.size < 3; i++) await aspetta(10);
      assert.strictEqual((await post(g.porta, '/api/sudo/chiedi', { comando: 'sudo true' })).status, 429);
      for (const id of Array.from(g.st._aperte.keys())) await post(g.porta, '/api/sudo/rispondi', { id, annulla: true }, 'buono');
      await Promise.all(tre);
    } finally { g.srv.close(); }
  });

  await t('A5 password con a-capo rifiutata (sudo la taglierebbe), richiesta ancora aperta', async () => {
    const f = await avvia();
    try {
      const attesa = post(f.porta, '/api/sudo/chiedi', { comando: 'sudo true' });
      const m = await primaRichiesta(f);
      assert.strictEqual((await post(f.porta, '/api/sudo/rispondi', { id: m.id, password: 'a\nb' }, 'buono')).status, 400);
      assert.strictEqual((await post(f.porta, '/api/sudo/rispondi', { id: m.id, password: '' }, 'buono')).status, 400);
      await post(f.porta, '/api/sudo/rispondi', { id: m.id, annulla: true }, 'buono');
      await attesa;
    } finally { f.srv.close(); }
  });

  function aiutante(porta) {
    return new Promise((ok) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'tools/sudo-telefono/chiedi.js')], {
        env: { PATH: process.env.PATH, SUDO_TELEFONO_PORTA: String(porta), CLAUDE_CODE_SESSION_ID: 'cid-1' },
      });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => ok({ code, out, err }));
    });
  }
  await t('B1 l\'aiutante di sudo: risposta → password + a capo su stdout, esce 0', async () => {
    const f = await avvia();
    try {
      const fine = aiutante(f.porta);
      const m = await primaRichiesta(f);
      assert.strictEqual(m.titolo, 'Apps', 'la sessione arriva dall\'ambiente');
      await post(f.porta, '/api/sudo/rispondi', { id: m.id, password: 'pw-prova' }, 'buono');
      const r = await fine;
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.out, 'pw-prova\n');
    } finally { f.srv.close(); }
  });
  await t('B2 annullata → esce 1, stdout vuoto, motivo chiaro su stderr; Machine spenta → esce 1', async () => {
    const f = await avvia();
    try {
      const fine = aiutante(f.porta);
      const m = await primaRichiesta(f);
      await post(f.porta, '/api/sudo/rispondi', { id: m.id, annulla: true }, 'buono');
      const r = await fine;
      assert.strictEqual(r.code, 1); assert.strictEqual(r.out, '');
      assert.ok(/cancelled on the phone/.test(r.err), r.err);
    } finally { f.srv.close(); }
    const r2 = await aiutante(1);   // porta 1: nessuno
    assert.strictEqual(r2.code, 1); assert.strictEqual(r2.out, '');
  });

  await t('E /hack: una pagina web (Origin, Sec-Fetch, Host diverso) non può bussare; nessuna casella', async () => {
    const f = await avvia();
    try {
      assert.strictEqual((await post(f.porta, '/api/sudo/chiedi', {}, null, { Origin: 'http://cattivo.example' })).status, 403);
      assert.strictEqual((await post(f.porta, '/api/sudo/chiedi', {}, null, { 'Sec-Fetch-Site': 'same-origin' })).status, 403);
      assert.strictEqual((await post(f.porta, '/api/sudo/chiedi', {}, null, { Host: 'cattivo.example:' + f.porta })).status, 403);
      assert.strictEqual(f.ricevuti.length, 0);
    } finally { f.srv.close(); }
  });

  await t('F /hack: col controllo VERO, chi non è figlio del sudo vero (l\'aiutante lanciato a mano, un curl) è rifiutato', async () => {
    const f = await avvia({ chiamante: require('../server/sudo-telefono').chiamanteVero });
    try {
      const r = await aiutante(f.porta);
      assert.strictEqual(r.code, 1); assert.strictEqual(r.out, '', 'nessuna password a chi non è sudo');
      assert.strictEqual((await post(f.porta, '/api/sudo/chiedi', {})).status, 403, 'nemmeno un POST diretto');
      assert.strictEqual(f.ricevuti.length, 0, 'e nessuna casella sullo schermo');
    } finally { f.srv.close(); }
  });

  await t('C il guscio: -A solo in sessione Claude senza terminale; fuori, sudo identico', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-guscio-'));
    try {
      const finto = path.join(dir, 'vero-sudo');
      fs.writeFileSync(finto, '#!/bin/sh\necho "ARGS:$*|ASKPASS:${SUDO_ASKPASS:-}"\ncase " $* " in *" falso "*) exit 1;; esac\n', { mode: 0o755 });
      const src = fs.readFileSync(path.join(ROOT, 'tools/sudo-telefono/sudo'), 'utf8');
      assert.ok(/^REALE=\/usr\/bin\/sudo$/m.test(src), 'il guscio punta a /usr/bin/sudo, fisso (niente variabili)');
      const guscio = path.join(ROOT, 'tools/sudo-telefono', '.prova-guscio-' + process.pid);
      fs.writeFileSync(guscio, src.replace(/^REALE=.*$/m, 'REALE=' + finto), { mode: 0o755 });
      try {
        const corri = (args, env) => execFileSync('setsid', ['-w', guscio].concat(args),
          { env: Object.assign({ PATH: process.env.PATH }, env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const askpass = path.join(ROOT, 'tools/sudo-telefono/chiedi.js');
        assert.strictEqual(corri(['pacman', '-Syu'], { CLAUDECODE: '1' }), `ARGS:-A pacman -Syu|ASKPASS:${askpass}`);
        assert.strictEqual(corri(['-u', 'root', 'ls'], { CLAUDECODE: '1' }), `ARGS:-A -u root ls|ASKPASS:${askpass}`);
        assert.strictEqual(corri(['-n', 'true'], { CLAUDECODE: '1' }), 'ARGS:-n true|ASKPASS:');
        assert.strictEqual(corri(['-S', 'true'], { CLAUDECODE: '1' }), 'ARGS:-S true|ASKPASS:');
        assert.strictEqual(corri(['-u', 'root', '-n', 'true'], { CLAUDECODE: '1' }), 'ARGS:-u root -n true|ASKPASS:', '-n dopo un\'opzione con valore');
        assert.strictEqual(corri(['-kn', 'true'], { CLAUDECODE: '1' }), 'ARGS:-kn true|ASKPASS:', 'flag uniti');
        assert.strictEqual(corri(['pacman', '-Syu'], {}), 'ARGS:pacman -Syu|ASKPASS:', 'fuori da Claude: identico');
        assert.strictEqual(corri(['whoami'], { SUDO_TELEFONO: '1' }), `ARGS:-A whoami|ASKPASS:${askpass}`, '«!sudo …» dalla chat');
        // 07/11: «sudo -n …» falliva muto e la sessione mandava il proprietario al PC.
        const r = require('child_process').spawnSync('setsid', ['-w', guscio, '-n', 'falso'],
          { env: { PATH: process.env.PATH, CLAUDECODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        assert.strictEqual(r.status, 1, 'il codice d\'uscita di sudo resta');
        assert.ok(/WITHOUT -n/.test(r.stderr), 'con -n fallito la sessione legge la strada giusta: ' + r.stderr);
      } finally { fs.rmSync(guscio, { force: true }); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t('D la pagina carica la casella dopo ws.js; ws.js le passa sudo_chiede e sudo_chiuso; il campo si svuota', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const iWs = html.indexOf('src="js/ws.js"'), iS = html.indexOf('src="js/sudo-telefono.js"');
    assert.ok(iWs > 0 && iS > iWs);
    const ws = fs.readFileSync(path.join(ROOT, 'public/js/ws.js'), 'utf8');
    assert.ok(/msg\.type === 'sudo_chiede' \|\| msg\.type === 'sudo_chiuso'[\s\S]{0,120}window\.sudoTelefono\(msg\)/.test(ws));
    const cl = fs.readFileSync(path.join(ROOT, 'public/js/sudo-telefono.js'), 'utf8');
    assert.ok(/campo\.value = '';/.test(cl), 'la password non resta nel campo');
    assert.ok(!/localStorage|sessionStorage|console\.log/.test(cl), 'niente salvataggi né log nella casella');
    const srv = fs.readFileSync(path.join(ROOT, 'server/sudo-telefono.js'), 'utf8');
    assert.ok(!/console\.log\([^)]*password/.test(srv), 'il server non scrive la password nel log');
  });

  console.log(rossi ? `sudo-telefono: ${rossi}/${n} ROSSI` : `sudo-telefono: ${n}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
})();
