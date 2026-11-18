'use strict';
// Gate for the classifier-fallback TRUNCATION path (the remaining half-message bug
// after 2c93cc3). When the auto classifier is down and the fallback flips to
// bypass, SdkSession.evictForModeChange must NOT silently truncate the turn the owner
// is waiting on: a FROZEN in-flight turn is tagged (_modeChangeRetry) and evicted
// so stream-handler re-runs it in bypass; a HEALTHY in-flight turn defers to its
// natural end (2c93cc3); an idle session just evicts. Pure — no SDK, no disk: we
// drive SdkSession.prototype.evictForModeChange against a hand-built `this`.
process.env.CLASSIFIER_FREEZE_MS = '45000';

const assert = require('assert');
const { SdkSession, FREEZE_WATCH_MS } = require('../server/sdk-engine');

const evictForModeChange = SdkSession.prototype.evictForModeChange;

// Minimal `this` with the exact fields the method reads/writes.
function fakeSession({ dead = false, turn = null, lastActivity = Date.now() } = {}) {
  const calls = { evict: [] };
  return {
    self: {
      dead,
      activeTurn: turn,
      lastActivity,
      _respawnAfterTurn: false,
      evict(reason) { calls.evict.push(reason); },
    },
    calls,
  };
}

// (a) FROZEN in-flight turn → tagged for retry AND evicted now ------------------
{
  const turn = { _closed: false };
  const { self, calls } = fakeSession({ turn, lastActivity: Date.now() - (FREEZE_WATCH_MS + 5000) });
  evictForModeChange.call(self);
  assert.strictEqual(turn._modeChangeRetry, true, '(a) frozen turn tagged for re-run');
  assert.deepStrictEqual(calls.evict, ['mode-change'], '(a) frozen turn evicted to respawn in bypass');
  assert.strictEqual(self._respawnAfterTurn, false, '(a) frozen turn does NOT defer');
}

// (b) HEALTHY in-flight turn → defer to onTurnEnd, never truncate (2c93cc3) -----
{
  const turn = { _closed: false };
  const { self, calls } = fakeSession({ turn, lastActivity: Date.now() }); // just active
  evictForModeChange.call(self);
  assert.strictEqual(turn._modeChangeRetry, undefined, '(b) healthy turn is NOT retry-tagged');
  assert.deepStrictEqual(calls.evict, [], '(b) healthy turn is NOT evicted mid-stream');
  assert.strictEqual(self._respawnAfterTurn, true, '(b) healthy turn defers its respawn');
}

// (c) idle session (no active turn) → evict now, nothing to retry ---------------
{
  const { self, calls } = fakeSession({ turn: null });
  evictForModeChange.call(self);
  assert.deepStrictEqual(calls.evict, ['mode-change'], '(c) idle session evicts to respawn');
  assert.strictEqual(self._respawnAfterTurn, false, '(c) idle session does not defer');
}

// (d) already-closed turn treated as no active turn ----------------------------
{
  const turn = { _closed: true };
  const { self, calls } = fakeSession({ turn, lastActivity: Date.now() - (FREEZE_WATCH_MS + 5000) });
  evictForModeChange.call(self);
  assert.strictEqual(turn._modeChangeRetry, undefined, '(d) closed turn is not retry-tagged');
  assert.deepStrictEqual(calls.evict, ['mode-change'], '(d) closed turn → plain evict');
}

// (e) dead session → no-op -----------------------------------------------------
{
  const turn = { _closed: false };
  const { self, calls } = fakeSession({ dead: true, turn });
  evictForModeChange.call(self);
  assert.deepStrictEqual(calls.evict, [], '(e) dead session does nothing');
  assert.strictEqual(turn._modeChangeRetry, undefined, '(e) dead session tags nothing');
}

console.log('sdk-mode-change-retry.test.js: PASS (a,b,c,d,e)');
