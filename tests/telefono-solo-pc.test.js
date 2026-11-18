#!/usr/bin/env node
'use strict';
/**
 * telefono-solo-pc.test.js — l'app del telefono parla solo col PC.
 *
 * «there's nothing left for the Raspberry Pi to do in the 151 machine … So why
 * does the Raspberry even matter at this point?» Strada C: la pagina, le chat e
 * tutto il resto arrivano dal PC; PC spento, addormentato o dietro Mullvad = la
 * copia dentro l'app (OfflineBridge) con le sessioni archiviate sul telefono.
 * L'intrattenimento ha la sua app (151 Entertainment), che parla col Pi da sé.
 *
 * Leggi:
 *   A. server.url = il PC sulla rete Tailscale, porta 3170. Nessun altro indirizzo.
 *   B. La copia di riserva segue server.url, mai un indirizzo scritto a mano.
 *   C. versionCode sale insieme (un APK con un indirizzo nuovo è una consegna nuova).
 * Run: node tests/telefono-solo-pc.test.js (raccolto da `npm test`). Nessuna rete.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } }

const cfg = JSON.parse(rd('app/capacitor.config.json'));
const u = new URL(cfg.server.url);
ok(!!u.hostname && u.hostname !== 'localhost', 'A. il telefono carica dal PC (' + u.hostname + ')');
ok(u.port === '3170' && u.protocol === 'http:', 'A. porta 3170 della Machine');
ok(!/raspberry/i.test(JSON.stringify(cfg)), 'A. nessun indirizzo del Pi nella configurazione');

const J = 'app/android/app/src/main/java/com/the151universe/machine/';
const java = fs.readdirSync(path.join(ROOT, J)).filter((f) => f.endsWith('.java')).map((f) => rd(J + f)).join('\n');
ok(/bridge\.getServerUrl\(\)/.test(rd(J + 'OfflineBridge.java')), 'B. la copia di riserva segue server.url');
ok(!/[\w-]*raspberry[\w-]*\.[\w.-]+|\b100\.\d+\.\d+\.\d+/i.test(java.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), 'B. nessun indirizzo del Pi scritto nel codice nativo');

const vc = +(rd('app/android/app/build.gradle').match(/versionCode (\d+)/) || [])[1];
ok(vc >= 19, 'C. versionCode della prima APK col PC (' + vc + ')');

console.log('\n' + pass + ' ok, ' + fail + ' falliti');
process.exit(fail ? 1 : 0);
