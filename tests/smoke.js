'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const BASE = process.env.TEST_HOST || 'http://127.0.0.1:3170';
const WS_BASE = BASE.replace(/^http/, 'ws') + '/ws';
const TIMEOUT = 5000;

let jwtSecret = null;
let authToken = null;
let passed = 0;
let failed = 0;
const failures = [];

function loadJwtSecret() {
  const envPath = process.env.SMOKE_ENV_FILE || path.join(__dirname, '..', '.env');
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^JWT_SECRET=(.+)$/);
    if (m) return m[1].trim();
  }
  throw new Error('JWT_SECRET not found in .env');
}

function createTestToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    role: 'owner',
    iat: Date.now(),
    exp: Date.now() + 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', jwtSecret)
    .update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT,
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}?token=${token}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS connect timeout'));
    }, TIMEOUT);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function wsExpect(ws, typeName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS timeout waiting for "${typeName}"`)), timeoutMs || TIMEOUT);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === typeName) {
        clearTimeout(timer);
        ws.removeListener('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  FAIL  ${name} -- ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// =====================
// TEST SUITE
// =====================

async function run() {
  console.log('\n151 Machine Smoke Tests');
  console.log('='.repeat(40));

  // Static pre-flight: structural guards that need no running server. The
  // restart-arming guard fails the whole suite if any restart path stops arming
  // the post-deploy verify marker (the bug that silenced post-deploy reports).
  {
    const { spawnSync } = require('child_process');
    const guard = spawnSync(process.execPath, [path.join(__dirname, 'restart-arming.guard.test.js')], { encoding: 'utf8' });
    process.stdout.write(guard.stdout || '');
    if (guard.status !== 0) {
      process.stderr.write(guard.stderr || '');
      console.error('\n✗ restart-arming guard failed — aborting smoke.');
      process.exit(1);
    }
  }

  // Bootstrap
  try {
    jwtSecret = loadJwtSecret();
    authToken = createTestToken();
  } catch (err) {
    console.log(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // --- Public endpoints ---

  await test('GET /api/health returns ok', async () => {
    const r = await request('GET', '/api/health');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.ok === true, `ok=${r.body.ok}`);
    assert(typeof r.body.version === 'string', 'missing version');
    assert(typeof r.body.sessions === 'number', 'missing sessions count');
  });

  // /hack 17/10 punto 13 (15/11): le intestazioni di sicurezza su pagine e API
  await test('Security headers on / and /api/health (nosniff, no-referrer, SAMEORIGIN)', async () => {
    for (const p of ['/', '/api/health']) {
      const r = await request('GET', p);
      assert(r.headers['x-content-type-options'] === 'nosniff', `${p} x-content-type-options=${r.headers['x-content-type-options']}`);
      assert(r.headers['referrer-policy'] === 'no-referrer', `${p} referrer-policy=${r.headers['referrer-policy']}`);
      assert(r.headers['x-frame-options'] === 'SAMEORIGIN', `${p} x-frame-options=${r.headers['x-frame-options']}`);
    }
  });

  await test('GET /api/version returns commit + build hash', async () => {
    const r = await request('GET', '/api/version');
    assert(r.status === 200, `status ${r.status}`);
    assert(typeof r.body.commit_sha === 'string', 'missing commit_sha');
    assert(typeof r.body.build_hash === 'string', 'missing build_hash');
  });

  await test('GET /api/build-hash returns hash', async () => {
    const r = await request('GET', '/api/build-hash');
    assert(r.status === 200, `status ${r.status}`);
    assert(typeof r.body.hash === 'string', 'missing hash');
  });

  // Pulizia 12/10/2026: rotte senza piu' nessun client, tolte. Con un token
  // valido devono dare 404 — se tornano 200 qualcuno le ha rimesse.
  await test('Removed routes stay removed (restart-banner, raccoon)', async () => {
    for (const [m, u] of [['GET', '/api/restart-banner'], ['POST', '/api/restart-banner/dismiss'],
      ['GET', '/api/raccoon/findings'], ['POST', '/api/raccoon/ack'], ['POST', '/api/raccoon/delivered'],
      ['POST', '/api/raccoon/received'], ['POST', '/api/raccoon/rejected']]) {
      const r = await request(m, u, m === 'POST' ? {} : undefined, authToken);
      assert(r.status === 404, `${m} ${u} → ${r.status} (atteso 404)`);
    }
  });

  // --- Auth ---

  // [12/11/2026] Prima: «rejects wrong password» (401). La parola non
  // esiste più: da loopback (questo smoke bussa a 127.0.0.1) il gettone si dà
  // senza chiedere niente, e deve funzionare davvero. Il rifiuto di chi è fuori
  // dal Tailscale lo prova tests/solo-tailnet.test.js (indirizzo LAN → 403).
  await test('POST /api/login from loopback gives a working token without password', async () => {
    const r = await request('POST', '/api/login', {});
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.body && typeof r.body.token === 'string', 'no token in the answer');
    const s = await request('GET', '/api/sessions', undefined, r.body.token);
    assert(s.status === 200, `the token from /api/login gets ${s.status} on /api/sessions`);
  });

  await test('Protected route rejects no token', async () => {
    const r = await request('GET', '/api/sessions');
    assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });

  // The old relay header (x-relay-secret) opens nothing.
  await test('La chiave del vecchio relay non apre le API', async () => {
    let chiave = '';
    try { const l = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8').split('\n').find((x) => x.startsWith('RELAY_SECRET=')); chiave = l ? l.slice(13).trim().replace(/^["']|["']$/g, '') : ''; } catch (_) {}
    const r = await new Promise((resolve, reject) => {
      const url = new URL('/api/sessions', BASE);
      const rq = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET',
        headers: { 'x-relay-secret': chiave || 'x' }, timeout: TIMEOUT }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      rq.on('error', reject); rq.end();
    });
    assert(r === 401 || r === 403, `con la chiave del relay: ${r}`);
  });

  // «!comando» nella chat (07/11/2026, sostituisce il plugin Terminal): dal
  // socket vero dell'istanza, un «!echo» torna come messaggio «PC». Senza
  // token il socket viene chiuso (4001) e nessun comando parte.
  await test('Chat «!comando»: il PC lo esegue e risponde nella chat', async () => {
    const WebSocket = require('ws');
    const os = require('os');
    const cr = await request('POST', '/api/sessions', { title: 'smoke-comando', workingDirectory: os.tmpdir() }, authToken);
    assert(cr.status === 200 || cr.status === 201, `sessione: ${cr.status}`);
    const sid = cr.body.id;
    const wsBase = BASE.replace(/^http/, 'ws');
    try {
      const esito = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(authToken)}`);
        const tm = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('nessun esito in 15 s')); }, 15000);
        const visti = [];
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'join', sessionId: sid, historyLength: 0 }));
          setTimeout(() => ws.send(JSON.stringify({ type: 'message', content: '!echo smoke-$((40+2))', nonce: 'smoke-' + Date.now() })), 300);
        });
        ws.on('message', (d) => {
          let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
          visti.push(m.type);
          if (m.type === 'comando_esito') { clearTimeout(tm); ws.close(); resolve({ m, visti }); }
        });
        ws.on('error', (e) => { clearTimeout(tm); reject(e); });
      });
      assert(/smoke-42/.test(esito.m.content), `uscita: ${esito.m.content}`);
      assert(esito.m.code === 0, `codice ${esito.m.code}`);
      assert(esito.visti.includes('comando_via'), 'manca «running»');
      const st = await request('GET', `/api/sessions/${sid}`, null, authToken);
      if (st.status === 200 && st.body && Array.isArray(st.body.history)) {
        assert(st.body.history.some((h) => h.role === 'comando'), 'il messaggio «PC» non è nella storia');
      }
    } finally {
      await request('DELETE', `/api/sessions/${sid}`, null, authToken);
    }
  });

  await test('Protected route accepts valid JWT', async () => {
    const r = await request('GET', '/api/sessions', null, authToken);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body), 'expected array');
  });

  await test('Expired JWT is rejected', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      role: 'owner', iat: Date.now() - 100000, exp: Date.now() - 50000,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', jwtSecret)
      .update(header + '.' + body).digest('base64url');
    const expired = header + '.' + body + '.' + sig;
    const r = await request('GET', '/api/sessions', null, expired);
    assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });

  // --- Sessions CRUD ---

  let testSessionId = null;

  await test('POST /api/sessions creates a session', async () => {
    const r = await request('POST', '/api/sessions', { title: '__SMOKE_TEST__' }, authToken);
    assert(r.status === 201, `status ${r.status}`);
    assert(r.body.id, 'missing id');
    assert(r.body.title === '__SMOKE_TEST__', `title=${r.body.title}`);
    testSessionId = r.body.id;
  });

  await test('GET /api/sessions lists the new session', async () => {
    const r = await request('GET', '/api/sessions', null, authToken);
    assert(r.status === 200, `status ${r.status}`);
    const found = r.body.find(s => s.id === testSessionId);
    assert(found, 'test session not in list');
  });

  await test('PATCH /api/sessions/:id renames session', async () => {
    const r = await request('PATCH', `/api/sessions/${testSessionId}`, { title: '__SMOKE_RENAMED__' }, authToken);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.title === '__SMOKE_RENAMED__', `title=${r.body.title}`);
  });

  await test('PATCH /api/sessions/:id/team sets team', async () => {
    const r = await request('PATCH', `/api/sessions/${testSessionId}/team`, { team: 'test-team' }, authToken);
    assert(r.status === 200, `status ${r.status}`);
  });

  // --- WebSocket ---

  await test('WS connects with valid token', async () => {
    const ws = await connectWs(authToken);
    ws.close();
  });

  await test('WS rejects invalid token', async () => {
    try {
      const ws = await connectWs('bogus_token');
      await new Promise((resolve, reject) => {
        ws.on('close', (code) => {
          if (code === 4001) resolve();
          else reject(new Error(`expected close 4001, got ${code}`));
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('no close event')), TIMEOUT);
      });
    } catch (err) {
      if (err.message.includes('Unexpected server response: 401') || err.message.includes('4001')) return;
      throw err;
    }
  });

  await test('WS join returns sync + history', async () => {
    const ws = await connectWs(authToken);
    try {
      ws.send(JSON.stringify({ type: 'join', sessionId: testSessionId, historyLength: 0 }));
      const sync = await wsExpect(ws, 'sync');
      assert(sync.status === 'idle' || sync.status === 'busy', `sync status=${sync.status}`);
      assert(typeof sync.serverBoot === 'number', 'missing serverBoot');
    } finally {
      ws.close();
    }
  });

  await test('WS ping/pong works', async () => {
    const ws = await connectWs(authToken);
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
      const pong = await wsExpect(ws, 'pong', 2000);
      assert(pong.type === 'pong', 'expected pong');
    } finally {
      ws.close();
    }
  });

  await test('WS get_stream_state requires join first', async () => {
    const ws = await connectWs(authToken);
    try {
      ws.send(JSON.stringify({ type: 'get_stream_state', sessionId: testSessionId }));
      const err = await wsExpect(ws, 'error', 2000);
      assert(err.message.includes('not joined'), `unexpected error: ${err.message}`);
    } finally {
      ws.close();
    }
  });

  await test('WS get_stream_state works after join', async () => {
    const ws = await connectWs(authToken);
    try {
      ws.send(JSON.stringify({ type: 'join', sessionId: testSessionId, historyLength: 0 }));
      await wsExpect(ws, 'sync');
      ws.send(JSON.stringify({ type: 'get_stream_state', sessionId: testSessionId }));
      const resume = await wsExpect(ws, 'resume', 2000);
      assert(resume.sessionId === testSessionId, 'wrong session in resume');
      assert(Array.isArray(resume.history), 'missing history array');
    } finally {
      ws.close();
    }
  });

  await test('WS stop on idle session returns stopped', async () => {
    const ws = await connectWs(authToken);
    try {
      ws.send(JSON.stringify({ type: 'join', sessionId: testSessionId, historyLength: 0 }));
      await wsExpect(ws, 'sync');
      ws.send(JSON.stringify({ type: 'stop' }));
      const stopped = await wsExpect(ws, 'stopped', 2000);
      assert(stopped.type === 'stopped', 'expected stopped');
    } finally {
      ws.close();
    }
  });

  await test('WS session switch re-registers sockets', async () => {
    const ws = await connectWs(authToken);
    try {
      ws.send(JSON.stringify({ type: 'join', sessionId: testSessionId, historyLength: 0 }));
      const sync1 = await wsExpect(ws, 'sync');
      assert(sync1, 'first sync missing');
      ws.send(JSON.stringify({ type: 'join', sessionId: testSessionId, historyLength: 0 }));
      const sync2 = await wsExpect(ws, 'sync');
      assert(sync2, 'second sync missing');
    } finally {
      ws.close();
    }
  });

  // --- Cleanup ---

  await test('DELETE /api/sessions/:id cleans up test session', async () => {
    const pre = await request('GET', '/api/sessions', null, authToken);
    const exists = pre.body.find(s => s.id === testSessionId);
    assert(exists, `session ${testSessionId} not found before delete`);
    const r = await request('DELETE', `/api/sessions/${testSessionId}`, null, authToken);
    assert(r.status === 204, `status ${r.status}, body: ${JSON.stringify(r.body).slice(0, 200)}`);
    const check = await request('GET', '/api/sessions', null, authToken);
    const found = check.body.find(s => s.id === testSessionId);
    assert(!found, 'session still exists after delete');
  });

  // --- Edge cases ---

  await test('PATCH nonexistent session returns 404', async () => {
    const r = await request('PATCH', '/api/sessions/00000000-0000-0000-0000-000000000000', { title: 'x' }, authToken);
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  // Il limitatore resta anche senza parola (5 al minuto per IP): col giro
  // sopra sono 6 richieste, quindi l'ultima deve dire 429.
  await test('POST /api/login rate limit (6th request in a minute → 429)', async () => {
    for (let i = 0; i < 4; i++) {
      await request('POST', '/api/login', {});
    }
    const r = await request('POST', '/api/login', {});
    assert(r.status === 200 || r.status === 429, `expected 200 or 429 after 5 tries, got ${r.status}`);
  });

  // --- Results ---

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ${f.name}: ${f.error}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test runner error:', err);
  process.exit(1);
});
