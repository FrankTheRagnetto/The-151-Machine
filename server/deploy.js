'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const restartControl = require('./restart-control');

const RESTART_LOCK_PATH = path.join(__dirname, '..', 'tmp', 'restart.lock');
const RESTART_LOCK_TTL_MS = 60 * 1000;

function isRestartLockHeld() {
  try {
    const raw = fs.readFileSync(RESTART_LOCK_PATH, 'utf8');
    const { pid, ts } = JSON.parse(raw);
    if (!pid || !ts) return false;
    if (Date.now() - ts > RESTART_LOCK_TTL_MS) return false;
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); } catch { return false; }
    return true;
  } catch {
    return false;
  }
}

function acquireRestartLock(caller) {
  try {
    fs.mkdirSync(path.dirname(RESTART_LOCK_PATH), { recursive: true });
    fs.writeFileSync(
      RESTART_LOCK_PATH,
      JSON.stringify({ pid: process.pid, ts: Date.now(), startedAt: Date.now(), caller: caller || '-' })
    );
    return true;
  } catch (e) {
    console.warn('[LOCK] acquireRestartLock failed:', e.message);
    return false;
  }
}

function releaseRestartLock() {
  try { fs.unlinkSync(RESTART_LOCK_PATH); } catch {}
}

(function clearStaleRestartLockOnBoot() {
  try {
    const raw = fs.readFileSync(RESTART_LOCK_PATH, 'utf8');
    const { pid, ts } = JSON.parse(raw);
    const stale = !pid || !ts || (Date.now() - ts > RESTART_LOCK_TTL_MS);
    let alive = false;
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (stale || !alive) {
      fs.unlinkSync(RESTART_LOCK_PATH);
      console.log('[BOOT] Cleared stale restart.lock');
    }
  } catch {}
})();

process.on('exit', releaseRestartLock);

function createDeployHandler({ manager, wss, restartIntent, closeServersAndExit, serverState, getPluginManager }) {
  let deployInProgress = false;
  let DEPLOY_IN_PROGRESS = false;

  function plannedShutdown(reason) {
    if (serverState.shutdownInProgress) return;
    if (isRestartLockHeld()) {
      try {
        const { pid } = JSON.parse(fs.readFileSync(RESTART_LOCK_PATH, 'utf8'));
        if (pid !== process.pid) {
          console.log(`[SHUTDOWN] ${reason} — skipped, restart already in flight (pid ${pid})`);
          return;
        }
      } catch {}
    }
    acquireRestartLock();
    serverState.shutdownInProgress = true;
    global.__151_shutting_down = true; // restart-journal guard (see stream-handler clean-close)
    console.log(`[SHUTDOWN] ${reason} — notifying clients, saving state`);

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try { client.send(JSON.stringify({ type: 'server_restarting' })); } catch {}
      }
    });

    setTimeout(() => {
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          try { client.close(4100, 'deploy'); } catch {}
        }
      });
    }, 500);

    const useSessionHost = process.env.USE_SESSION_HOST === '1';
    const useSdk = process.env.USE_SDK_ENGINE === '1';

    for (const [id, session] of manager.sessions) {
      const buf = manager.getStreamState(id);
      if (buf && buf.text) {
        session.history.push({
          role: 'assistant',
          content: buf.text,
          tools: buf.tools || [],
          partial: true,
        });
        session.lastMessage = buf.text.slice(0, 100);
        console.log(`[SHUTDOWN] Saved partial response for ${id.slice(0, 8)} (${buf.text.length} chars)`);
      }
      const wasBusy = session.status === 'busy' || !!session.process;
      if (useSdk) {
        // The warm SDK query() is ABORTED on shutdown — it does NOT survive the
        // restart like the legacy session-host daemon child does. So a session
        // that was mid-turn must be marked 'interrupted' here, otherwise
        // resumeInterrupted() skips it on boot and the whole restart-recovery
        // chain (amnesia breaker + auto post-deploy verify) never engages —
        // leaving the deploying session frozen and silent. Root-cause fix for
        // "deploy bounced my session and it never reported back".
        if (wasBusy) session.status = 'interrupted';
        session.process = null;
      } else if (useSessionHost) {
        if (session.process) session.process = null;
      } else if (wasBusy) {
        session.status = 'interrupted';
      }
    }

    if (useSessionHost) {
      console.log('[SHUTDOWN] USE_SESSION_HOST=1 — leaving CLI children alive in daemon');
      manager.saveSync();
      closeServersAndExit(0, 0, 2000);
      return;
    }

    console.log('[SHUTDOWN] USE_SESSION_HOST=0 — killing CLI children (legacy path)');
    manager.killAllProcessesAsync(3000).then(() => {
      console.log('[SHUTDOWN] All child processes terminated');
      manager.saveSync();
      closeServersAndExit(0, 0, 2000);
    }).catch(() => {
      console.log('[SHUTDOWN] Child kill failed, forcing exit');
      manager.saveSync();
      closeServersAndExit(0, 1, 1000);
    });
  }

  function deployRoute(req, res) {
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!ip.match(/^(::1|::ffff:127\.|127\.)/)) {
      return res.status(403).json({ error: 'Deploy is localhost-only' });
    }

    if (DEPLOY_IN_PROGRESS) {
      return res.status(409).json({ error: 'deploy_in_progress' });
    }
    DEPLOY_IN_PROGRESS = true;

    const { mode: reqMode, session_id, commit_msg, files_changed } = req.body || {};
    const mode = reqMode || 'hot';

    const ua = req.get('user-agent') || '-';
    const referer = req.get('referer') || '-';
    const caller = req.get('x-caller') || '-';
    const remote = (req.socket && req.socket.remoteAddress) || '-';
    console.log(`[DEPLOY] Request from ip=${ip} ua=${ua} referer=${referer} caller=${caller} mode=${mode} remote=${remote}`);

    if (deployInProgress) {
      console.log('[DEPLOY] Rejected — deploy already in progress');
      return res.status(409).json({ error: 'deploy_in_progress' });
    }
    deployInProgress = true;

    if (mode === 'full') {
      // ── Zero-change restart guard (hardcode enforcement) ──────────────────
      // A full deploy must NEVER bounce the server when the code is identical
      // to what's already running. This stops any session — regardless of what
      // it types — from re-firing a deploy and restarting everyone for nothing
      // (the redundant-restart loop that also silenced live sessions). Content-
      // based: recompute the code hash and compare to the running one; trust the
      // bytes, not the file list. `force:true` overrides (deliberate re-push).
      const force = !!(req.body && req.body.force);
      const filesArr = Array.isArray(files_changed) ? files_changed : [];
      let codeUnchanged = false;
      try {
        const freshHash = require('./build-hash').computeCodeHash();
        if (freshHash && serverState.CODE_HASH && freshHash === serverState.CODE_HASH) {
          codeUnchanged = true;
        }
      } catch (e) {
        console.warn('[DEPLOY] code-hash compare failed, allowing restart:', e.message);
      }
      if (!force && codeUnchanged && filesArr.length === 0) {
        console.log('[DEPLOY] Refused full restart — code byte-identical to running build, 0 files (no-op). Pass force:true to override.');
        deployInProgress = false;
        DEPLOY_IN_PROGRESS = false;
        return res.json({
          status: 'noop',
          reason: 'no_code_change',
          message: 'Zero files changed and code is identical to the running build — restart skipped.',
        });
      }

      if (isRestartLockHeld()) {
        let holder = '-';
        try { holder = fs.readFileSync(RESTART_LOCK_PATH, 'utf8'); } catch {}
        console.log('[DEPLOY] Rejected — restart.lock held:', holder);
        deployInProgress = false;
        DEPLOY_IN_PROGRESS = false; // [12/10/2026] prima restava true: ogni deploy dopo era 409 fino al riavvio
        return res.status(409).json({ error: 'deploy_in_progress', holder });
      }
      acquireRestartLock(ua);
      if (session_id) {
        try {
          let commitSha = 'unknown';
          try {
            commitSha = require('child_process')
              .execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') })
              .toString().trim();
          } catch {}
          manager.setDeployMarker(session_id, {
            ts: new Date().toISOString(),
            mode: 'full',
            commit_sha: commitSha,
            commit_msg: commit_msg || '',
            files_changed: files_changed || [],
          });
        } catch (e) {
          console.error('[DEPLOY] marker write failed:', e.message);
        }
      }
      console.log('[DEPLOY] Full restart requested');
      const detailBits = [`${mode} deploy via /api/deploy`];
      if (commit_msg) detailBits.push(String(commit_msg).slice(0, 120));
      if (Array.isArray(files_changed) && files_changed.length) {
        detailBits.push(`${files_changed.length} file(s) changed`);
      }
      if (caller && caller !== '-') detailBits.push(`caller=${caller}`);
      res.json({ status: 'restarting' });
      // Through the single funnel: it ARMS the post-deploy verify marker (keyed
      // to session_id) before plannedShutdown runs, so the deploying session
      // auto-reports on boot. (restart-control writes the restart-intent too.)
      setTimeout(() => restartControl.restart({
        actor: 'deploy-endpoint',
        reason: 'Deploy',
        sessionId: session_id || null,
        intent: commit_msg ? `deploy: ${String(commit_msg).slice(0, 120)}` : 'deploy via /api/deploy',
        detail: detailBits.join(' | ') || null,
      }), 1000);
      return;
    }

    console.log('[DEPLOY] Hot reload — clearing static cache');

    try { if (getPluginManager) getPluginManager()?.syncClientFiles(); } catch (e) {
      console.warn('[DEPLOY] plugin sync failed:', e.message);
    }

    // Bump the per-boot nonce so deploy.sh sees /api/build-hash change (its
    // "restart landed" signal even though this is a hot reload, no restart).
    serverState.BUILD_HASH = crypto.randomBytes(4).toString('hex');
    const buildHash = serverState.BUILD_HASH;
    // Re-read the content-stable CODE_HASH (deploy.sh rewrote build-hash.txt
    // before this request) so the freshly-synced JS/CSS gets a new ?v= and the
    // client reload trigger fires for this real change.
    try { serverState.CODE_HASH = require('./build-hash').computeCodeHash(); } catch {}
    const codeHash = serverState.CODE_HASH;
    // A deploy is the ONLY thing allowed to move DEPLOY_HASH — that is what
    // makes it a "new code went live" signal instead of a "someone saved a
    // file" signal. Clients that were disconnected through this deploy (phone
    // backgrounded) see the change on their next WS join and reload then.
    serverState.DEPLOY_HASH = codeHash;
    console.log('[DEPLOY] New BUILD_HASH:', buildHash, 'CODE_HASH:', codeHash);

    const hotMsg = JSON.stringify({ type: 'hot_reload', buildHash, codeHash, deployHash: codeHash });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try { client.send(hotMsg); } catch {}
      }
    });

    DEPLOY_IN_PROGRESS = false;
    res.json({ status: 'hot_reload', buildHash, codeHash });
    deployInProgress = false;
  }

  return { plannedShutdown, deployRoute };
}

module.exports = {
  RESTART_LOCK_PATH,
  isRestartLockHeld,
  acquireRestartLock,
  releaseRestartLock,
  createDeployHandler,
};
