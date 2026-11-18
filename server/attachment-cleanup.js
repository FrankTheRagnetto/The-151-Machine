'use strict';

/**
 * M9 · pezzo 4 — orphan attachment sweep (boot-time).
 *
 * A server restart mid-upload can leave a PARTIAL file in
 * <attachments_dir>/<sid>/ (multer streams straight to the final path; a
 * process kill skips multer's own error-cleanup). Left alone these truncated
 * files masquerade as attachments and bloat disk.
 *
 * SAFE by construction: an attachment can only be referenced in a session's
 * history AFTER its upload fully succeeded (the client awaits the upload
 * response before sending the chat message). So any file NOT referenced by any
 * session history is either a partial orphan or a completed-but-never-sent
 * upload — and in BOTH cases the client still holds the local blob and
 * re-uploads on the next send. Therefore deleting unreferenced files loses
 * nothing. Files referenced in history (incl. interrupted turns queued for
 * auto-resume, whose user message is already in history) are always kept.
 *
 * PC-ONLY: the caller must gate this to the box with the local CLI. On the Pi
 * (which proxies all sessions to the PC and forwards attachments to it) the
 * local session set is not the source of truth, so a reference sweep there
 * could wrongly delete forwarded files.
 */

const fs = require('fs');
const path = require('path');

function collectReferencedPaths(manager, trashDir, draftPaths) {
  const referenced = new Set();
  const addFrom = (list) => {
    if (!Array.isArray(list)) return;
    for (const att of list) {
      if (att && typeof att.path === 'string' && att.path) {
        referenced.add(path.resolve(att.path));
      }
    }
  };
  for (const session of manager.sessions.values()) {
    if (Array.isArray(session.history)) {
      for (const msg of session.history) {
        if (msg && msg.attachments) addFrom(msg.attachments);
      }
    }
    // Belt-and-suspenders: a queued resume carries the last user message's
    // attachments (already in history, but include explicitly in case it was
    // pruned by the history cap).
    if (session._pendingResume && session._pendingResume.attachments) {
      addFrom(session._pendingResume.attachments);
    }
  }
  // TRASHED (revivable) sessions ALSO reference attachment files: their history
  // is snapshotted to <trashDir>/<id>.json and a restore brings the images back.
  // Without this, the boot sweep would delete an attachment referenced ONLY by a
  // trashed session, silently breaking images on restore. Making the sweep read
  // trash too can only ever make it MORE conservative (never delete extra).
  if (trashDir) {
    let entries;
    try { entries = fs.readdirSync(trashDir); } catch { entries = []; }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(trashDir, f), 'utf-8'));
        if (Array.isArray(snap.history)) {
          for (const msg of snap.history) {
            if (msg && msg.attachments) addFrom(msg.attachments);
          }
        }
      } catch { /* skip an unreadable trash entry — never abort the whole sweep */ }
    }
  }
  // M9 Fase C · Vettore 6: attachments uploaded-on-add and still sitting in a
  // client draft (never sent → not yet in any history) are "alive". The client
  // persists only the ref (no local blob), so it CANNOT re-upload after a reload;
  // the file must survive the boot sweep. draft-attachments.js records these paths.
  if (draftPaths && typeof draftPaths.forEach === 'function') {
    draftPaths.forEach((p) => {
      if (typeof p === 'string' && p) referenced.add(path.resolve(p));
    });
  }
  return referenced;
}

/**
 * @returns {{ removed: number, bytes: number }}
 */
function sweepOrphans({ manager, attachmentsDir, trashDir, draftPaths }) {
  const result = { removed: 0, bytes: 0 };
  if (!attachmentsDir || !fs.existsSync(attachmentsDir)) return result;

  const referenced = collectReferencedPaths(manager, trashDir, draftPaths);

  let sidDirs;
  try {
    sidDirs = fs.readdirSync(attachmentsDir, { withFileTypes: true });
  } catch (e) {
    console.error('[ATTACH-CLEANUP] readdir failed:', e.message);
    return result;
  }

  for (const sidEnt of sidDirs) {
    if (!sidEnt.isDirectory()) continue;
    const sidDir = path.join(attachmentsDir, sidEnt.name);
    let files;
    try {
      files = fs.readdirSync(sidDir, { withFileTypes: true });
    } catch { continue; }
    for (const fEnt of files) {
      if (!fEnt.isFile()) continue;
      const abs = path.resolve(sidDir, fEnt.name);
      if (referenced.has(abs)) continue; // in-use — never touch
      try {
        const st = fs.statSync(abs);
        fs.rmSync(abs, { force: true });
        result.removed += 1;
        result.bytes += st.size || 0;
      } catch (e) {
        console.error('[ATTACH-CLEANUP] rm failed for', abs, e.message);
      }
    }
  }
  return result;
}

module.exports = { sweepOrphans, collectReferencedPaths };
