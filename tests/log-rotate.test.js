'use strict';
// Gate for P3.2 log rotation: an over-cap file rolls to <file>.1 and a fresh
// file is written; an under-cap file is untouched. Plain node, no framework.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotateIfLarge } = require('../server/log-rotate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
try {
  const f = path.join(tmp, 'events.jsonl');

  // 1) Over-cap file rotates.
  fs.writeFileSync(f, 'x'.repeat(1000));
  const rotated = rotateIfLarge(f, 500);
  assert.strictEqual(rotated, true, 'over-cap file should rotate');
  assert.strictEqual(fs.existsSync(f), false, 'original removed after rotate');
  assert.strictEqual(fs.existsSync(f + '.1'), true, 'previous generation kept as .1');
  fs.appendFileSync(f, 'new\n'); // the append that follows rotation
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'new\n', 'fresh file after rotate');

  // 2) Second rotation overwrites the old .1 (only ONE generation retained).
  fs.writeFileSync(f, 'y'.repeat(1000));
  rotateIfLarge(f, 500);
  assert.strictEqual(fs.readFileSync(f + '.1', 'utf-8'), 'y'.repeat(1000), '.1 overwritten by newer gen');

  // 3) Under-cap file untouched.
  fs.writeFileSync(f, 'small');
  const rotated3 = rotateIfLarge(f, 500);
  assert.strictEqual(rotated3, false, 'under-cap file should NOT rotate');
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'small', 'under-cap file preserved');

  // 4) Missing file never throws.
  assert.strictEqual(rotateIfLarge(path.join(tmp, 'nope.log'), 10), false, 'missing file is a no-op');

  console.log('log-rotate.test.js: PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
