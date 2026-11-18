'use strict';

// Size-cap log rotation — 1 generation, zero-config, never throws.
//
// Several append-only stores under ~/.151machine (events.jsonl,
// client-log.jsonl) have no cap and grow forever (slow disk-fill). This helper
// keeps them bounded WITHOUT losing recent data: call rotateIfLarge(file, max)
// right BEFORE appending a line. If the file is at/over `max`, it is renamed to
// `<file>.1` (atomically replacing any prior `.1`), leaving a fresh empty file
// for the append that follows. Exactly ONE previous generation is retained.
//
// Fire-and-forget safe: any error (missing file, race with a concurrent
// rotate/append, permission) is swallowed — a rotation failure must never break
// the hot path it guards. On POSIX rename() atomically overwrites the target,
// so no unlink race window.
const fs = require('fs');

function rotateIfLarge(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return false;
    fs.renameSync(file, file + '.1');
    return true;
  } catch {
    // No file yet, or another writer already rotated it — nothing to do.
    return false;
  }
}

module.exports = { rotateIfLarge };
