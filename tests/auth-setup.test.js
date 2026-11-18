'use strict';
// Gate for FIX 1: the /api/setup loopback lock.
// Before, `isLocal` treated the ENTIRE tailnet (100.x) as local-trusted, so any
// tailnet device could create the first owner password WITHOUT the pairing key.
// This test pins the contract on the REAL predicate (server/setup-auth.js — the
// exact module the handler calls) AND on an Express app that mounts the same guard
// so we assert the live 200 / 403 status codes:
//   • setup from loopback, no key            → allowed (200)
//   • setup from 100.x (tailnet), no key     → 403
//   • setup from 100.x with a valid key      → allowed (200)
// Plain node:test, no running 151 server, no disk, no SDK.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { isLoopback, setupAllowed } = require('../server/setup-auth');

const PAIRING_TOKEN = 'valid-token-123';

// --- Unit: the real predicate --------------------------------------------------

test('isLoopback: true only for real loopback, false for tailnet/LAN', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  // The bug: tailnet 100.x must NOT be treated as loopback.
  assert.equal(isLoopback('100.64.0.5'), false);
  assert.equal(isLoopback('::ffff:100.64.0.5'), false);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback(''), false);
});

test('setupAllowed: loopback needs no key; tailnet needs a valid key', () => {
  // loopback, no key → allowed
  assert.equal(setupAllowed('127.0.0.1', undefined, PAIRING_TOKEN), true);
  // tailnet, no key → denied
  assert.equal(setupAllowed('100.64.0.5', undefined, PAIRING_TOKEN), false);
  assert.equal(setupAllowed('100.64.0.5', '', PAIRING_TOKEN), false);
  // tailnet, wrong key → denied
  assert.equal(setupAllowed('100.64.0.5', 'nope', PAIRING_TOKEN), false);
  // tailnet, valid key → allowed
  assert.equal(setupAllowed('100.64.0.5', PAIRING_TOKEN, PAIRING_TOKEN), true);
});

// --- Integration: an Express app mounting the exact same guard ------------------
// Mirrors the /api/setup entry guard (server/index.js) so we assert real 403/200.

function buildApp() {
  const app = express();
  app.use(express.json());
  // Fake caller IP is injected via the x-test-ip header for deterministic testing;
  // the real handler reads req.ip / req.socket.remoteAddress.
  app.post('/api/setup', (req, res) => {
    const { pairingKey } = req.body || {};
    const ip = req.get('x-test-ip') || req.socket.remoteAddress || '';
    if (!setupAllowed(ip, pairingKey, PAIRING_TOKEN)) {
      return res.status(403).json({ error: 'Invalid pairing key — scan the QR code first' });
    }
    res.json({ ok: true });
  });
  return app;
}

function post(server, ip, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const { port } = server.address();
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/setup',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-test-ip': ip,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('POST /api/setup: loopback without key → 200', async () => {
  const server = buildApp().listen(0);
  try {
    const r = await post(server, '127.0.0.1', { password: 'abcd' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  } finally {
    server.close();
  }
});

test('POST /api/setup: tailnet 100.x without key → 403', async () => {
  const server = buildApp().listen(0);
  try {
    const r = await post(server, '100.64.0.5', { password: 'abcd' });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
  } finally {
    server.close();
  }
});

test('POST /api/setup: tailnet 100.x with valid key → 200', async () => {
  const server = buildApp().listen(0);
  try {
    const r = await post(server, '100.64.0.5', { password: 'abcd', pairingKey: PAIRING_TOKEN });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  } finally {
    server.close();
  }
});
