'use strict';
// Gate for the dictation guard (restart/deploy round 2026-08-16, punto 4).
// Contract of server/restart-readiness.js:
//   (a) idle → ready
//   (b) an active recorder blocks readiness; stop / connection-drop clears it
//   (c) a stale recorder (no heartbeat past STALE_MS) auto-expires — a dead
//       phone can never wedge deploys
//   (d) in-flight transcriptions block readiness; end clears (never negative)
//   (e) waitUntilReady resolves as soon as the guard clears, and resolves
//       (ready:false) at maxWaitMs instead of hanging forever
// Plain node, no framework.

const assert = require('assert');
const readiness = require('../server/restart-readiness');

// (a) idle
let s = readiness.snapshot();
assert.strictEqual(s.ready, true, 'fresh module must be ready');

// (b) recording blocks; stop clears
const wsA = { id: 'a' };
readiness.noteRecording(wsA, true);
s = readiness.snapshot();
assert.strictEqual(s.ready, false);
assert.strictEqual(s.recording, 1);
readiness.noteRecording(wsA, false);
assert.strictEqual(readiness.snapshot().ready, true, 'stop must clear');

// (b2) connection drop clears
readiness.noteRecording(wsA, true);
readiness.dropConnection(wsA);
assert.strictEqual(readiness.snapshot().ready, true, 'ws close must clear');

// (c) stale expiry — backdate the heartbeat past STALE_MS via a fake timer
const realNow = Date.now;
readiness.noteRecording(wsA, true);
Date.now = () => realNow() + readiness.STALE_MS + 1000;
try {
  s = readiness.snapshot();
  assert.strictEqual(s.ready, true, 'stale recorder must auto-expire');
  assert.strictEqual(s.recording, 0);
} finally {
  Date.now = realNow;
}

// (d) transcriptions
readiness.beginTranscribe();
readiness.beginTranscribe();
s = readiness.snapshot();
assert.strictEqual(s.ready, false);
assert.strictEqual(s.transcribing, 2);
readiness.endTranscribe();
readiness.endTranscribe();
readiness.endTranscribe(); // extra end must not go negative
s = readiness.snapshot();
assert.strictEqual(s.ready, true);
assert.strictEqual(s.transcribing, 0);

// (e) waitUntilReady — clears mid-wait
(async () => {
  readiness.beginTranscribe();
  setTimeout(() => readiness.endTranscribe(), 120);
  const t0 = Date.now();
  const snap = await readiness.waitUntilReady({ maxWaitMs: 5000, pollMs: 50 });
  assert.strictEqual(snap.ready, true, 'must resolve ready once cleared');
  assert.ok(Date.now() - t0 < 2000, 'must resolve promptly after clear');

  // (e2) timeout path
  readiness.beginTranscribe();
  const snap2 = await readiness.waitUntilReady({ maxWaitMs: 200, pollMs: 50 });
  assert.strictEqual(snap2.ready, false, 'timeout must resolve not-ready, not hang');
  readiness.endTranscribe();

  console.log('restart-readiness OK');
})().catch((e) => { console.error(e); process.exit(1); });
