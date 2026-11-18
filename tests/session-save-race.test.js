'use strict';

/**
 * Regression test for the session-save ENOENT race (round affidabilità 2026-08-21).
 *
 * THE BUG: server/session-manager.js wrote every atomic save through ONE fixed
 * temp name, `<target>.tmp`, shared by every writer. The debounced async save()
 * and a saveSync() (shutdown / interrupt) therefore aimed at the same file:
 *   writer A: writeFile(t) ......... rename(t -> target)   ✓
 *   writer B: writeFile(t) ..................... rename(t -> target)   ✗ ENOENT
 * B's temp had already been renamed away by A, so B's save was LOST. The
 * production logs hold 114 × "[SESSION] Write error: ENOENT" over 46 days.
 *
 * THE FIX: each write gets a private temp (pid + counter + random), so writers
 * can never steal each other's file. Last rename() still wins — that is the
 * intended last-writer-wins, and it is now always a COMPLETE document.
 *
 * Part 1 demonstrates the OLD shared-temp scheme really does produce ENOENT.
 * Part 2 hammers the REAL SessionManager and requires zero write errors plus a
 * final store that still parses.
 *
 * Plain node, no deps: node tests/session-save-race.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sessrace-'));

// ---------------------------------------------------------------------------
// Part 1 — the OLD scheme, verbatim, must still lose a write to ENOENT.
// This is what proves the diagnosis (and that Part 2 is testing something real).
// ---------------------------------------------------------------------------
function oldAtomicWrite(targetPath, data, cb) {
  const tmp = targetPath + '.tmp';            // <-- the shared name: the bug
  fs.writeFile(tmp, data, (err) => {
    if (err) return cb(err);
    fs.rename(tmp, targetPath, cb);
  });
}

function part1() {
  return new Promise((resolve) => {
    console.log('\nPart 1 — old shared-temp scheme (expected to break)');
    const target = path.join(TMPDIR, 'old.json');
    const payload = JSON.stringify({ blob: 'x'.repeat(200000) });
    const N = 40;
    let done = 0;
    let enoent = 0;
    for (let i = 0; i < N; i++) {
      oldAtomicWrite(target, payload, (err) => {
        if (err && err.code === 'ENOENT') enoent++;
        if (++done === N) {
          ok(enoent > 0,
            `shared temp loses writes to ENOENT (${enoent}/${N} failed) — bug reproduced`);
          resolve();
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Part 2 — the REAL SessionManager under concurrent save() + saveSync().
// ---------------------------------------------------------------------------
// The exact production interleaving: save() schedules a DEBOUNCED async write
// (100 ms). Once that timer fires, writeFile() is in flight — and saveSync()
// does NOT cancel an in-flight write, it only clears the pending timer. So a
// shutdown/interrupt saveSync() lands its renameSync() right inside the async
// writer's writeFile→rename window. With one shared temp name the sync writer
// carries the temp away and the async rename() dies with ENOENT.
const SESSIONS = 100;
const MSGS = 150;          // MAX_HISTORY_PER_SESSION is 200 — stay under it
const FILLER = 'x'.repeat(800);
const DEBOUNCE_MS = 100;   // session-manager save() debounce

function part2() {
  return new Promise((resolve) => {
    console.log('\nPart 2 — real SessionManager, concurrent save() + saveSync()');
    const { SessionManager } = require('../server/session-manager');

    const store = path.join(TMPDIR, 'sessions.json');
    const mgr = new SessionManager(store);

    // Payload big enough that the async writeFile→rename window stays open long
    // enough for the sync writers to barge in (~20 MB ≈ tens of ms).
    for (let i = 0; i < SESSIONS; i++) {
      const s = mgr.create({ title: 'race session ' + i, workingDirectory: TMPDIR });
      s.history = [];
      for (let h = 0; h < MSGS; h++) {
        s.history.push({ role: 'assistant', content: FILLER + h });
      }
    }

    // Capture the manager's own error reporting — the exact channel the 114
    // production failures came out of.
    const writeErrors = [];
    const realError = console.error;
    console.error = (...args) => {
      const line = args.join(' ');
      if (/^\[SESSION\]/.test(line)) writeErrors.push(line);
      else realError.apply(console, args);
    };

    let round = 0;
    const ROUNDS = 5;

    function runRound() {
      if (round++ >= ROUNDS) return finish();
      mgr.save();                       // arms the debounced async write
      setTimeout(() => {                // by now writeFile() is in flight
        const storm = setInterval(() => mgr.saveSync(), 1);
        setTimeout(() => {
          clearInterval(storm);
          setTimeout(runRound, 150);    // let the async write settle
        }, 80);
      }, DEBOUNCE_MS + 2);
    }

    function finish() {
      console.error = realError;

      ok(writeErrors.length === 0,
        'no [SESSION] write errors under concurrent writers' +
        (writeErrors.length ? ` — got ${writeErrors.length}: ` + writeErrors[0] : ''));

      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(store, 'utf-8')); } catch (e) { parsed = e; }
      ok(Array.isArray(parsed), 'store still parses as a complete JSON array');
      ok(Array.isArray(parsed) && parsed.length === SESSIONS,
        `store holds all ${SESSIONS} sessions (nothing truncated)`);

      // No orphan temp files left behind by any writer.
      const orphans = fs.readdirSync(TMPDIR).filter(f => f.endsWith('.tmp'));
      ok(orphans.length === 0, 'no orphan .tmp files left (' + orphans.length + ')');

      resolve();
    }

    runRound();
  });
}

(async () => {
  await part1();
  await part2();
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
