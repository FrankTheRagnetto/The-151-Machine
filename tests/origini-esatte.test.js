#!/usr/bin/env node
'use strict';
// [17/10/2026] Controllo di sicurezza /hack, punto 2: la Machine si fidava di
// un'origine guardando solo l'INIZIO del nome (server/index.js: startsWith
// 'http://10.', 'http://100.', 'http://192.168.'): «http://10.sito-cattivo.com»
// passava, e una pagina così poteva chiamare la Machine dal browser del proprietario.
// Adesso: un elenco ESATTO — le origini dell'app sul telefono e gli indirizzi
// veri di questa macchina con la sua porta.
const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

let mod = null;
try { mod = require(path.join(__dirname, '..', 'server', 'cors-origins.js')); } catch (e) { console.log('  (manca server/cors-origins.js: ' + e.message + ')'); }
ok(!!mod && typeof mod.buildAllowedOrigins === 'function' && typeof mod.isAllowedOrigin === 'function', 'c\'è il modulo con buildAllowedOrigins / isAllowedOrigin');

if (mod) {
  const finte = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    wlan0: [{ family: 'IPv4', address: '192.168.1.23', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
  };
  const set = mod.buildAllowedOrigins(3170, finte);
  const si = (o) => mod.isAllowedOrigin(o, set);
  // L'app sul telefono e il PC: come prima.
  ok(si('capacitor://localhost'), 'telefono: capacitor://localhost');
  ok(si('http://localhost') && si('https://localhost'), 'telefono: http(s)://localhost');
  ok(si('http://localhost:3170') && si('http://127.0.0.1:3170'), 'PC: localhost e 127.0.0.1 con la porta');
  ok(si('http://100.101.102.103:3170'), 'Tailscale: l\'indirizzo vero della macchina con la porta');
  ok(si('http://192.168.1.23:3170'), 'rete di casa: l\'indirizzo vero della macchina con la porta');
  // I nomi furbi di prima: fuori.
  ok(!si('http://10.sito-cattivo.com'), 'fuori: http://10.sito-cattivo.com');
  ok(!si('http://100.attacker.example'), 'fuori: http://100.attacker.example');
  ok(!si('http://192.168.evil.com'), 'fuori: http://192.168.evil.com');
  ok(!si('http://100.101.102.103.evil.com:3170'), 'fuori: un nome che comincia con l\'indirizzo vero');
  ok(!si('http://192.168.1.99:3170'), 'fuori: un altro apparecchio della rete di casa');
  ok(!si('http://100.101.102.103:9999'), 'fuori: l\'indirizzo giusto con un\'altra porta');
  ok(!si('https://example.com') && !si('null') && !si(''), 'fuori: siti qualsiasi, «null», vuoto');
}

const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
ok(!/origin\.startsWith\(/.test(idx), 'server/index.js: nessun controllo d\'origine col solo inizio del nome');
ok(/isAllowedOrigin\(origin, ALLOWED_ORIGINS\)/.test(idx), 'server/index.js: il CORS usa l\'elenco esatto');

console.log(`\norigini-esatte: ${pass} verdi, ${fail} rossi`);
process.exit(fail ? 1 : 0);
