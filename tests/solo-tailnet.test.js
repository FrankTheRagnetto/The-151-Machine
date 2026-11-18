#!/usr/bin/env node
'use strict';
// LA MACHINE RISPONDE SOLO AL PC E AL TAILSCALE DI il proprietario
//
// Prima: il server ascoltava su '::' porta 3170 e rispondeva a chiunque lo
// raggiungesse (anche il Wi-Fi di casa); a fermare gli estranei c'era solo la
// parola d'accesso. Adesso c'è un muro PRIMA di ogni rotta, dei file statici e
// dell'upgrade WebSocket (server/solo-tailnet.js): passa solo l'indirizzo vero
// del socket se è loopback o Tailscale; tutti gli altri 403 / socket chiuso.
// E la parola non c'è più: a chi passa il muro POST /api/login dà il gettone.
//
//   A. eAmmesso su una tabella di indirizzi (puro);
//   B. il muro su un server http vero in questo processo, con l'indirizzo del
//      socket finto (LAN → 403 su / e /api/sessions, upgrade WS chiuso, log
//      una riga sola; loopback e Tailscale passano; X-Forwarded-For non conta);
//   C. il cablaggio in server/index.js: il muro è il PRIMO app.use, l'upgrade
//      lo chiama per primo, /api/login non confronta più nessuna parola;
//   D. il server VERO (l'istanza usa-e-getta del cancello, tools/gate-istanza.sh):
//      da loopback il gettone arriva senza parola e funziona; dall'indirizzo
//      LAN di questa macchina / , /api/sessions, /api/login → 403 e l'upgrade
//      WS non diventa mai 101.
//   + correzioni /hack (12/11): l'indirizzo LOCALE del socket (Tailscale solo
//      se entrato da tailscale0, loopback solo da loopback), l'Host (DNS
//      rebinding) e l'Origin su /api/login e WS;
//   E. whisper (3171/3173) solo su 127.0.0.1.
// Puro rispetto alla Machine viva: non bussa mai alla 3170.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let n = 0, rossi = 0;
async function t(nome, fn) {
  n++;
  try { await fn(); console.log('  ✓ ' + nome); }
  catch (e) { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); }
}

let mod = {};
try { mod = require(path.join(ROOT, 'server', 'solo-tailnet.js')); }
catch (e) { console.log('  (server/solo-tailnet.js non si carica: ' + e.message + ')'); }
const { eAmmesso, creaMuro, socketAmmesso } = mod;

const AMMESSI = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.101.102.104', '::ffff:100.101.102.103', 'fd7a:115c:a1e0::1',
  '127.255.0.9', '100.64.0.0', '100.127.255.255', '0:0:0:0:0:0:0:1', 'fd7a:115c:a1e0:ab12:4843:cd96:6253:84b'];
const RIFIUTATI = ['192.168.1.10', '::ffff:192.168.1.10', '10.0.0.2', '100.63.255.255', '100.128.0.1', '8.8.8.8', 'fe80::1',
  '', null, undefined, '::', 'localhost', '::ffff:10.0.0.2', 'fd7a:115c:a1e1::1', '172.17.0.1', '1.127.0.0.1'];

(async () => {
  console.log('A) eAmmesso, la tabella');
  await t('eAmmesso esiste', () => assert.strictEqual(typeof eAmmesso, 'function'));
  for (const a of AMMESSI) await t(`ammesso  ${a}`, () => assert.strictEqual(eAmmesso(a), true));
  for (const a of RIFIUTATI) await t(`rifiutato ${JSON.stringify(a)}`, () => assert.strictEqual(eAmmesso(a), false));

  await t('socketAmmesso: Tailscale solo se entrato da tailscale0, loopback solo da loopback', () => {
    assert.strictEqual(typeof socketAmmesso, 'function', 'socketAmmesso non c\'è');
    const TS = ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'];
    assert.strictEqual(socketAmmesso('::ffff:100.101.102.104', '::ffff:100.101.102.103', TS), true);
    assert.strictEqual(socketAmmesso('fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::1234:5678', TS), true);
    assert.strictEqual(socketAmmesso('100.101.102.104', '192.168.1.32', TS), false, '100.x dal Wi-Fi (CGNAT/hotspot) passa');
    assert.strictEqual(socketAmmesso('::ffff:100.101.102.104', '::ffff:192.168.1.32', TS), false);
    assert.strictEqual(socketAmmesso('127.0.0.1', '127.0.0.1', TS), true);
    assert.strictEqual(socketAmmesso('::1', '::1', TS), true);
    assert.strictEqual(socketAmmesso('127.0.0.1', '192.168.1.32', TS), false, 'loopback con locale non loopback passa');
    assert.strictEqual(socketAmmesso('192.168.1.10', '192.168.1.32', TS), false);
  });

  console.log('\nB) il muro su un server http vero, indirizzi del socket simulati');
  await t('creaMuro esiste', () => assert.strictEqual(typeof creaMuro, 'function'));
  if (typeof creaMuro === 'function') {
    const righe = [];
    const NOME = 'my-pc.example.ts.net';
    const muro = creaMuro({
      tailscale: { ip: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'], nomi: ['my-pc', NOME] },
      origini: new Set([`http://${NOME}:3170`, 'capacitor://localhost', 'http://127.0.0.1:3170']),
      log: (r) => righe.push(r),
    });
    let finto = null; // { r, l }: gli indirizzi che il prossimo socket «ha»
    const srv = http.createServer((req, res) => muro.http(req, res, () => { res.statusCode = 200; res.end('dentro'); }));
    srv.prependListener('connection', (sock) => {
      if (!finto) return;
      Object.defineProperty(sock, 'remoteAddress', { value: finto.r, configurable: true });
      Object.defineProperty(sock, 'localAddress', { value: finto.l, configurable: true });
    });
    const upgradeVisti = [];
    srv.on('upgrade', (req, sock) => {
      if (!muro.upgrade(req, sock)) { upgradeVisti.push('chiuso'); return; }
      upgradeVisti.push('passato');
      sock.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const porta = srv.address().port;
    const chiedi = (p, intest) => new Promise((ok) => {
      const req = http.request({ host: '127.0.0.1', port: porta, path: p, agent: false, headers: intest || {} }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok({ s: res.statusCode, b }));
      });
      req.on('upgrade', (res, sock) => { sock.destroy(); ok({ s: res.statusCode }); });
      req.on('error', (e) => ok({ s: 0, e: e.code || e.message }));
      req.end();
    });
    const WS = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };

    finto = { r: '192.168.1.10', l: '192.168.1.32' };
    await t('LAN 192.168.1.10 → 403 su /', async () => { const r = await chiedi('/'); assert.strictEqual(r.s, 403); assert.ok(/Not on your Tailscale/.test(r.b)); });
    await t('LAN 192.168.1.10 → 403 su /api/sessions', async () => assert.strictEqual((await chiedi('/api/sessions')).s, 403));
    await t('LAN con X-Forwarded-For: 127.0.0.1 → 403 lo stesso (le intestazioni non contano)', async () =>
      assert.strictEqual((await chiedi('/', { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '100.101.102.104' })).s, 403));
    await t('LAN → upgrade WS chiuso, mai 101', async () => {
      const r = await chiedi('/ws?token=x', WS);
      assert.notStrictEqual(r.s, 101); assert.strictEqual(upgradeVisti[upgradeVisti.length - 1], 'chiuso');
    });
    await t('il log non s\'inonda: 4 rifiuti dallo stesso indirizzo = 1 riga (indirizzo e percorso)', () => {
      const mie = righe.filter((r) => r.includes('192.168.1.10'));
      assert.strictEqual(mie.length, 1, JSON.stringify(righe));
      assert.ok(/192\.168\.1\.10/.test(mie[0]) && /\//.test(mie[0]));
    });
    finto = { r: '::ffff:192.168.1.10', l: '::ffff:192.168.1.32' };
    await t('LAN in forma IPv6 (::ffff:192.168.1.10) → 403', async () => assert.strictEqual((await chiedi('/')).s, 403));
    finto = { r: '100.101.102.104', l: '192.168.1.32' };
    await t('A: un 100.x arrivato dal Wi-Fi (locale 192.168.1.32, CGNAT/hotspot) → 403', async () => assert.strictEqual((await chiedi('/')).s, 403));
    finto = { r: '127.0.0.1', l: '192.168.1.32' };
    await t('A: «loopback» con indirizzo locale non loopback → 403', async () => assert.strictEqual((await chiedi('/')).s, 403));
    finto = { r: '::ffff:100.101.102.104', l: '::ffff:100.101.102.103' };
    await t('Tailscale 100.101.102.104 entrato da tailscale0 → passa', async () => assert.strictEqual((await chiedi('/api/sessions', { Host: NOME + ':3170' })).s, 200));
    await t('Tailscale → upgrade WS con l\'Origin dell\'app Android passa (101)', async () =>
      assert.strictEqual((await chiedi('/ws', { ...WS, Host: NOME + ':3170', Origin: `http://${NOME}:3170` })).s, 101));
    finto = null;
    await t('loopback vero → passa', async () => assert.strictEqual((await chiedi('/')).s, 200));
    await t('B: Host «evil.example» da loopback → 403 (DNS rebinding)', async () => assert.strictEqual((await chiedi('/', { Host: 'evil.example' })).s, 403));
    await t('B: Host «evil.example:3170» da loopback → 403', async () => assert.strictEqual((await chiedi('/', { Host: 'evil.example:3170' })).s, 403));
    await t('B: Host buoni passano (localhost:3170, [::1]:3170, my-pc, nome Tailscale, 100.101.102.103)', async () => {
      for (const h of ['localhost:3170', '[::1]:3170', 'my-pc', NOME + ':3170', NOME + '.', '100.101.102.103:3170', '[fd7a:115c:a1e0::1234:5678]:3170']) {
        assert.strictEqual((await chiedi('/', { Host: h })).s, 200, 'Host ' + h);
      }
    });
    await t('B: WS con Origin «http://evil.example» da loopback → chiuso', async () => {
      const r = await chiedi('/ws', { ...WS, Origin: 'http://evil.example' });
      assert.notStrictEqual(r.s, 101); assert.strictEqual(upgradeVisti[upgradeVisti.length - 1], 'chiuso');
    });
    await t('B: WS senza Origin, o con Origin ammessa → 101', async () => {
      assert.strictEqual((await chiedi('/ws', WS)).s, 101);
      assert.strictEqual((await chiedi('/ws', { ...WS, Origin: 'capacitor://localhost' })).s, 101);
    });
    await t('B: richiestaAmmessa (per /api/login): Origin evil → no; assente / app Android / capacitor → sì', () => {
      const req = (origin, host) => ({ socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' }, headers: { host: host || '127.0.0.1:3170', ...(origin ? { origin } : {}) } });
      assert.strictEqual(muro.richiestaAmmessa(req('http://evil.example')), false);
      assert.strictEqual(muro.richiestaAmmessa(req()), true);
      assert.strictEqual(muro.richiestaAmmessa(req(`http://${NOME}:3170`, NOME + ':3170')), true);
      assert.strictEqual(muro.richiestaAmmessa(req('capacitor://localhost')), true);
      assert.strictEqual(muro.richiestaAmmessa(req(undefined, 'evil.example')), false);
    });
    await new Promise((r) => srv.close(r));
  }

  await t('l\'origine dell\'app Android è in ALLOWED_ORIGINS (con i nomi Tailscale)', () => {
    const { buildAllowedOrigins } = require(path.join(ROOT, 'server', 'cors-origins.js'));
    const set = buildAllowedOrigins(3170, {}, ['my-pc.example.ts.net', 'fd7a:115c:a1e0::1234:5678']);
    assert.ok(set.has('http://my-pc.example.ts.net:3170'));
    assert.ok(set.has('http://[fd7a:115c:a1e0::1234:5678]:3170'));
    assert.ok(set.has('capacitor://localhost') && set.has('https://localhost'));
  });

  console.log('\nC) il cablaggio in server/index.js');
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  await t('il muro è il PRIMO app.use, subito dopo express()', () => {
    const dopo = idx.slice(idx.indexOf('const app = express();'));
    const primo = dopo.match(/app\.use\(([^)]*)\)/);
    assert.ok(primo && primo[1].trim() === 'muro.http', 'primo app.use: ' + (primo && primo[1]));
  });
  await t('il muro riceve i dati Tailscale del PC e ALLOWED_ORIGINS coi nomi Tailscale', () => {
    assert.ok(/const TAILSCALE_PC = leggiTailscale\(\);/.test(idx));
    assert.ok(/buildAllowedOrigins\(PORT, undefined, \[\.\.\.TAILSCALE_PC\.ip, \.\.\.TAILSCALE_PC\.nomi\]\)/.test(idx));
    assert.ok(/creaMuro\(\{ tailscale: TAILSCALE_PC, origini: ALLOWED_ORIGINS \}\)/.test(idx));
  });
  await t('l\'upgrade WS chiama il muro per primo', () => {
    const m = idx.match(/server\.on\('upgrade', \(req, socket, head\) => \{([\s\S]*?)\n\}\);/);
    assert.ok(m, 'handler upgrade non trovato');
    const prima = m[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))[0];
    assert.ok(/if \(!muro\.upgrade\(req, socket\)\) return;/.test(prima), 'prima riga: ' + prima);
  });
  await t('/api/login non confronta più nessuna parola, e ricontrolla muro + Origin', () => {
    const m = idx.match(/app\.post\('\/api\/login', \(req, res\) => \{([\s\S]*?)\n\}\);/);
    assert.ok(m, '/api/login non trovato');
    assert.ok(!/scryptSync|req\.body\.password|Wrong password/.test(m[1]), 'la rotta confronta ancora una password');
    assert.ok(/muro\.richiestaAmmessa\(req\)/.test(m[1]));
  });
  await t('nessuna X-Forwarded nel muro, nessun trust proxy', () => {
    const muroSrc = fs.readFileSync(path.join(ROOT, 'server', 'solo-tailnet.js'), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/x-forwarded|x-real-ip/i.test(muroSrc));
    assert.ok(!/trust proxy/.test(idx));
  });

  console.log('\nD) il server VERO (istanza usa-e-getta, mai la 3170)');
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !eAmmessoSicuro(i.address))
    .map((i) => i.address)[0];
  // il nome Tailscale finto entra dalla porta prevista (MACHINE_TAILSCALE_NAMES): la prova non dipende dal PC
  const corpo = `
    export MACHINE_TAILSCALE_NAMES=my-pc.example.ts.net
    gate_istanza_accendi >/dev/null 2>&1 || { echo "ACCENSIONE-FALLITA"; tail -5 "$GATE_ISTANZA_LOG" 2>/dev/null; exit 1; }
    P="$GATE_ISTANZA_PORTA"
    RISP=$(curl -s -m 5 -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$P/api/login")
    TOK=$(printf '%s' "$RISP" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')
    [ -n "$TOK" ] && echo "LOOP-GETTONE=si" || echo "LOOP-GETTONE=no"
    echo "LOOP-SESSIONI=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "http://127.0.0.1:$P/api/sessions")"
    echo "EVIL-HOST=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$P/")"
    echo "EVIL-LOGIN=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Origin: http://evil.example' -d '{}' "http://127.0.0.1:$P/api/login")"
    echo "BUONA-LOGIN=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Origin: http://my-pc.example.ts.net:$P" -d '{}' "http://127.0.0.1:$P/api/login")"
    echo "EVIL-WS=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.example' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://127.0.0.1:$P/ws?token=$TOK")"
    echo "BUONA-WS=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "Origin: http://127.0.0.1:$P" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://127.0.0.1:$P/ws?token=$TOK")"
    echo "LOOP-WS=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://127.0.0.1:$P/ws?token=$TOK")"
    if [ -n "${lan || ''}" ]; then
      L="http://${lan}:$P"
      echo "LAN-RADICE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$L/")"
      echo "LAN-SESSIONI=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "$L/api/sessions")"
      echo "LAN-LOGIN=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$L/api/login")"
      echo "LAN-WS=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$L/ws?token=$TOK")"
    fi
    gate_istanza_spegni
  `;
  const r = spawnSync('bash', ['-c', `set -uo pipefail\ncd "${ROOT}"\n. tools/gate-istanza.sh\n${corpo}`], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const val = (k) => { const m = out.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
  await t('l\'istanza si accende', () => assert.ok(!/ACCENSIONE-FALLITA/.test(out) && val('LOOP-GETTONE') !== null, out.slice(-400)));
  await t('loopback: POST /api/login senza parola → gettone', () => assert.strictEqual(val('LOOP-GETTONE'), 'si', out.slice(-300)));
  await t('loopback: quel gettone apre /api/sessions (200)', () => assert.strictEqual(val('LOOP-SESSIONI'), '200'));
  // (101 è solo «il muro lascia passare»: il gettone del WS si controlla dopo
  // l'upgrade, in ws-handler, che chiude con 4001 se è cattivo.)
  await t('loopback: l\'upgrade WS passa il muro (101)', () => assert.strictEqual(val('LOOP-WS'), '101'));
  await t('B vero: Host «evil.example» da loopback → 403', () => assert.strictEqual(val('EVIL-HOST'), '403'));
  await t('B vero: /api/login con Origin «http://evil.example» → 403', () => assert.strictEqual(val('EVIL-LOGIN'), '403'));
  await t('B vero: /api/login con l\'Origin dell\'app Android (nome Tailscale) → 200', () => assert.strictEqual(val('BUONA-LOGIN'), '200'));
  await t('B vero: WS con Origin «http://evil.example» → mai 101', () => assert.ok(val('EVIL-WS') !== '101' && val('EVIL-WS') !== null, 'EVIL-WS=' + val('EVIL-WS')));
  await t('B vero: WS con Origin della pagina (http://127.0.0.1:porta) → 101', () => assert.strictEqual(val('BUONA-WS'), '101'));
  if (!lan) {
    console.log('  ⚠ nessuna interfaccia LAN su questa macchina: la parte LAN del server vero non si può fare qui (la copre B)');
  } else {
    console.log(`  · indirizzo LAN di questa macchina: ${lan}`);
    await t(`LAN ${lan} → 403 su /`, () => assert.strictEqual(val('LAN-RADICE'), '403'));
    await t(`LAN ${lan} → 403 su /api/sessions (anche col gettone buono)`, () => assert.strictEqual(val('LAN-SESSIONI'), '403'));
    await t(`LAN ${lan} → 403 su /api/login (niente gettone)`, () => assert.strictEqual(val('LAN-LOGIN'), '403'));
    await t(`LAN ${lan} → upgrade WS chiuso, mai 101`, () => assert.ok(val('LAN-WS') !== '101' && val('LAN-WS') !== null, 'LAN-WS=' + val('LAN-WS')));
  }

  console.log('\nE) whisper solo su loopback (3171 WS, 3173 HTTP)');
  await t('whisper-service/server.py ascolta su 127.0.0.1, non su 0.0.0.0', () => {
    const py = fs.readFileSync(path.join(ROOT, 'whisper-service', 'server.py'), 'utf8');
    assert.ok(/^HOST = "127\.0\.0\.1"$/m.test(py), 'HOST non è 127.0.0.1');
    assert.ok(!/^HOST = "0\.0\.0\.0"/m.test(py));
    assert.ok(/web\.TCPSite\(runner, HOST, HTTP_PORT\)/.test(py) && /_make_reusable_socket\(HOST, PORT\)/.test(py), 'una delle due porte non usa HOST');
  });
  await t('i clienti di whisper bussano a 127.0.0.1', () => {
    assert.ok(/const WHISPER_HTTP_HOST = '127\.0\.0\.1';/.test(fs.readFileSync(path.join(ROOT, 'server', 'transcribe.js'), 'utf8')));
    assert.ok(/127\.0\.0\.1/.test(fs.readFileSync(path.join(ROOT, 'tools', 'whisper-watchdog.sh'), 'utf8')));
  });

  console.log(`\n${n - rossi}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
})();

// Per scegliere l'indirizzo LAN serve sapere cosa è Tailscale anche quando il
// modulo non c'è (prova sul codice di ieri): stessa regola, scritta a mano.
function eAmmessoSicuro(a) {
  if (typeof eAmmesso === 'function') return eAmmesso(a);
  const o = String(a).split('.').map(Number);
  return net.isIPv4(a) && (o[0] === 127 || (o[0] === 100 && o[1] >= 64 && o[1] <= 127));
}
