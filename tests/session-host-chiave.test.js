#!/usr/bin/env node
'use strict';
// [17/10/2026] Controllo di sicurezza /hack, punto 1 (critico): il
// session-host — il servizio che fa partire Claude — non controllava nessuna
// chiave. Qualunque programma sul PC poteva collegarsi a 127.0.0.1:3172 e
// chiedergli di far partire un comando; forse anche una pagina web, con una
// richiesta HTTP le cui righe sono JSON. Adesso il primo messaggio di ogni
// collegamento deve essere {type:'hello', key} con la chiave del file
// ~/.151machine/session-host.key (solo il proprietario può leggerlo); altrimenti chiude.
// Prova: un session-host VERO, in una casa temporanea (HOME finta), su una
// porta libera data dal kernel — mai la 3172 della Machine viva.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-chiave-'));
const portaLibera = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// Un giro su un socket: manda le righe, raccoglie le risposte, dice se è stato chiuso.
function giro(port, righe, attesaMs = 700) {
  return new Promise((resolve) => {
    const out = []; let buf = ''; let chiuso = false;
    const s = net.createConnection({ host: '127.0.0.1', port }, () => { for (const r of righe) s.write(r); });
    s.setEncoding('utf8');
    s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { out.push(JSON.parse(l)); } catch { out.push({ raw: l }); } } } });
    s.on('close', () => { chiuso = true; });
    s.on('error', () => {});
    setTimeout(() => { try { s.destroy(); } catch {} resolve({ out, chiuso }); }, attesaMs);
  });
}

(async () => {
  const port = await portaLibera();
  const env = { ...process.env, HOME: casa, USERPROFILE: casa, SESSION_HOST_FORCE_TCP: '1', SESSION_HOST_PORT: String(port), SESSION_HOST_HELLO_MS: '400' };
  const host = spawn(process.execPath, [path.join(ROOT, 'server', 'session-host', 'index.js')], { env, stdio: 'ignore', detached: true });
  try {
    let pronto = false;
    for (let i = 0; i < 50 && !pronto; i++) { await tick(100); pronto = await new Promise((r) => { const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); r(true); }); s.on('error', () => r(false)); }); }
    ok(pronto, 'il session-host di prova si accende sulla sua porta (' + port + ')');

    const fileChiave = path.join(casa, '.151machine', 'session-host.key');
    let chiave = '';
    for (let i = 0; i < 20 && !chiave; i++) { try { chiave = fs.readFileSync(fileChiave, 'utf8').trim(); } catch { await tick(50); } }
    ok(chiave.length >= 32, 'la chiave nasce da sola in ~/.151machine/session-host.key');
    let modo = 0; try { modo = fs.statSync(fileChiave).mode & 0o777; } catch {}
    ok(modo === 0o600, 'e la legge solo il proprietario (permessi 600, visti ' + modo.toString(8) + ')');

    const senza = await giro(port, [JSON.stringify({ type: 'list', reqId: 'r1' }) + '\n']);
    ok(pronto && !senza.out.some((m) => m.type === 'ack'), 'senza chiave: «list» non riceve risposta');
    ok(pronto && senza.chiuso, 'senza chiave: il collegamento viene chiuso');

    const spawnSenza = await giro(port, [JSON.stringify({ type: 'spawn', reqId: 'r2', sessionId: 'x', args: ['--version'] }) + '\n']);
    ok(pronto && !spawnSenza.out.some((m) => m.type === 'ack'), 'senza chiave: «spawn» rifiutato (niente parte)');

    const web = await giro(port, ['POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\n\r\n' + JSON.stringify({ type: 'spawn', reqId: 'r3', sessionId: 'y', args: ['--version'] }) + '\n']);
    ok(pronto && !web.out.some((m) => m.type === 'ack') && web.chiuso, 'una richiesta da pagina web (HTTP con JSON dentro) viene chiusa senza far partire niente');

    const sbagliata = await giro(port, [JSON.stringify({ type: 'hello', key: 'x'.repeat(64) }) + '\n', JSON.stringify({ type: 'list', reqId: 'r4' }) + '\n']);
    ok(pronto && !sbagliata.out.some((m) => m.type === 'ack') && sbagliata.chiuso, 'chiave sbagliata: rifiutato e chiuso');

    const muto = await giro(port, [], 900);
    ok(pronto && muto.chiuso, 'chi si collega e tace viene chiuso dopo l\'attesa');

    const giusta = await giro(port, [JSON.stringify({ type: 'hello', key: chiave }) + '\n', JSON.stringify({ type: 'list', reqId: 'r5' }) + '\n']);
    const lista = giusta.out.find((m) => m.reqId === 'r5');
    ok(!!lista && lista.type === 'ack' && Array.isArray(lista.sessions), 'chiave giusta: «list» risponde come prima');
    ok(!giusta.chiuso, 'chiave giusta: il collegamento resta aperto');

    // Il client vero della Machine (session-host-client.js) entra da solo.
    const prima = { HOME: process.env.HOME, F: process.env.SESSION_HOST_FORCE_TCP, P: process.env.SESSION_HOST_PORT };
    process.env.HOME = casa; process.env.SESSION_HOST_FORCE_TCP = '1'; process.env.SESSION_HOST_PORT = String(port);
    try {
      const { SessionHostClient } = require(path.join(ROOT, 'server', 'session-host-client.js'));
      const c = new SessionHostClient();
      const r = await Promise.race([c.list(), tick(3000).then(() => null)]);
      ok(Array.isArray(r), 'il client della Machine manda la chiave da solo e «list» funziona');
      try { c.shutdown && c.shutdown(); } catch {}
      try { c.socket && c.socket.destroy(); } catch {}
    } finally {
      process.env.HOME = prima.HOME;
      if (prima.F === undefined) delete process.env.SESSION_HOST_FORCE_TCP; else process.env.SESSION_HOST_FORCE_TCP = prima.F;
      if (prima.P === undefined) delete process.env.SESSION_HOST_PORT; else process.env.SESSION_HOST_PORT = prima.P;
    }
  } finally {
    try { process.kill(-host.pid, 'SIGKILL'); } catch {}
    try { host.kill('SIGKILL'); } catch {}
    try { fs.rmSync(casa, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nsession-host-chiave: ${pass} verdi, ${fail} rossi`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch((e) => { console.error(e); process.exit(1); });
