'use strict';
// Gate for P3.2 attachment retention: the boot sweep must KEEP a file that is
// referenced ONLY by a TRASHED (revivable) session, and REMOVE a true orphan.
// This proves the trash-awareness fix (collectReferencedPaths reading trashDir)
// makes the sweep strictly more conservative — it can never delete a file a
// restore would need. Plain node, no framework.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepOrphans } = require('../server/attachment-cleanup');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
try {
  const attDir = path.join(tmp, 'attachments');
  const trashDir = path.join(tmp, 'trash');
  fs.mkdirSync(attDir, { recursive: true });
  fs.mkdirSync(trashDir, { recursive: true });

  // File A: referenced only by a TRASHED session → must be KEPT.
  const sidTrash = 'sess-trashed';
  fs.mkdirSync(path.join(attDir, sidTrash), { recursive: true });
  const keptFile = path.join(attDir, sidTrash, '111_photo.jpg');
  fs.writeFileSync(keptFile, 'KEEP');
  fs.writeFileSync(path.join(trashDir, `${sidTrash}.json`), JSON.stringify({
    id: sidTrash,
    history: [{ role: 'user', content: 'here', attachments: [{ path: keptFile, name: 'photo.jpg' }] }],
  }));

  // File B: referenced by a LIVE session → must be KEPT.
  const sidLive = 'sess-live';
  fs.mkdirSync(path.join(attDir, sidLive), { recursive: true });
  const liveFile = path.join(attDir, sidLive, '222_doc.pdf');
  fs.writeFileSync(liveFile, 'LIVE');

  // File C: referenced by NOBODY (true orphan) → must be REMOVED.
  const sidOrphan = 'sess-orphan';
  fs.mkdirSync(path.join(attDir, sidOrphan), { recursive: true });
  const orphanFile = path.join(attDir, sidOrphan, '333_junk.bin');
  fs.writeFileSync(orphanFile, 'ORPHAN');

  // Fake manager: one live session referencing File B.
  const manager = {
    sessions: new Map([[sidLive, {
      history: [{ role: 'user', content: 'x', attachments: [{ path: liveFile, name: 'doc.pdf' }] }],
    }]]),
  };

  const res = sweepOrphans({ manager, attachmentsDir: attDir, trashDir });

  assert.strictEqual(fs.existsSync(keptFile), true, 'trash-referenced file must be KEPT');
  assert.strictEqual(fs.existsSync(liveFile), true, 'live-referenced file must be KEPT');
  assert.strictEqual(fs.existsSync(orphanFile), false, 'true orphan must be REMOVED');
  assert.strictEqual(res.removed, 1, 'exactly one file removed (the orphan)');

  // Guard: without trashDir the OLD behaviour would delete the trash-referenced
  // file — confirm the parameter is what protects it.
  fs.writeFileSync(orphanFile, 'ORPHAN2'); // recreate orphan for a clean 2nd run
  const res2 = sweepOrphans({ manager, attachmentsDir: attDir /* no trashDir */ });
  assert.strictEqual(fs.existsSync(keptFile), false, 'without trashDir the trash file is (wrongly) swept — proves the fix matters');
  assert.strictEqual(res2.removed >= 1, true, 'orphan still removed in legacy mode');

  console.log('attachment-cleanup.test.js: PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
