#!/usr/bin/env node
// SUDO_ASKPASS della Machine: chiede la password al proprietario sul telefono/schermo
// (server/sudo-telefono.js) e la scrive a sudo sullo stdout. Nient'altro la
// vede: niente file, niente log, niente argomenti. Esce 1 se non arriva.
'use strict';
const http = require('http');

// Il comando lo legge il server da sudo stesso (/proc del padre): qui solo la sessione.
const corpo = JSON.stringify({ sessione: process.env.CLAUDE_CODE_SESSION_ID || '' });
// Sempre il PC stesso; la porta si cambia solo per le prove.
const porta = Number(process.env.SUDO_TELEFONO_PORTA) || 3170;

const MOTIVI = {
  403: 'cancelled on the phone (or not asked by the real sudo)', 408: 'no answer within 2 minutes',
  503: 'no Machine screen is open to ask on', 429: 'too many open requests',
};
function esci(msg) { process.stderr.write(`sudo-telefono: ${msg}\n`); process.exit(1); }

const req = http.request({
  hostname: '127.0.0.1', port: porta, path: '/api/sudo/chiedi', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
  timeout: 130000,
}, (res) => {
  let dati = '';
  res.setEncoding('utf8');
  res.on('data', (d) => { dati += d; });
  res.on('end', () => {
    if (res.statusCode !== 200) esci(MOTIVI[res.statusCode] || `the Machine said ${res.statusCode}`);
    let pw = '';
    try { pw = JSON.parse(dati).password || ''; } catch (_) {}
    if (!pw) esci('empty answer');
    process.stdout.write(pw + '\n');
    process.exit(0);
  });
});
req.on('timeout', () => { req.destroy(); esci('no answer within 2 minutes'); });
req.on('error', () => esci('the Machine is not running on this PC'));
req.end(corpo);
