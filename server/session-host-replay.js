/**
 * session-host-replay.js — Phase 5a MVP daemon replay.
 *
 * Fires on WS client join when the main server has NO live proc for the
 * session BUT the session-host daemon still holds a ring-buffer worth of
 * stdout. Addresses the "hard-crash" path: main server dies without writing
 * `interrupted` markers, rebooted main doesn't call resumeInterrupted for
 * these sessions, daemon buffer goes unread, client sees empty response box.
 *
 * Graceful-restart path (resumeInterrupted + sendMessage boot block in
 * index.js) is UNTOUCHED — that flow still re-spawns via the daemon's
 * doSpawn, which kills the orphan and wipes the buffer. We deliberately
 * do NOT replay for that path; it would double-deliver the same stream.
 *
 * Scope contract (see Phase 5a spec):
 *   - Replay only when USE_SESSION_HOST === '1'.
 *   - Replay only when manager.hasLiveProc(sid) === false.
 *   - Replay only when daemon list() reports this sid with bufferEntries > 0.
 *   - Idempotent per session per main-server lifetime: once fired, do not
 *     fire again for the same sid until the RemoteProc emits 'close' (which
 *     happens either on natural CLI exit OR a subsequent re-spawn that
 *     kicks the subscriber, OR a daemon disconnect).
 *
 * Dedup: we rely on the client-side 120+60 signature dedup (commit 0cacfc6)
 * to absorb any overlap between cached session text and replayed deltas.
 * We do NOT introduce a server-side dedup layer here.
 */

'use strict';

async function maybeReplaySession(sid, { manager, client, spawnStreamHandler, replayedSet, logger }) {
  const log = logger || console;
  try {
    // Guard 1: feature flag off → nothing to do.
    if (process.env.USE_SESSION_HOST !== '1') return false;

    // Guard 2: already replayed this lifetime → skip until 'close' clears it.
    if (replayedSet.has(sid)) return false;

    // Guard 3: main server has a live proc → daemon is either already streaming
    // to us (flag ON path) or we're on the local-spawn path. Either way, replay
    // would double-subscribe and duplicate output.
    if (manager.hasLiveProc && manager.hasLiveProc(sid)) return false;

    // Ask the daemon what it has. list() is retry-queue gated, so a brief
    // disconnect window won't blow up — it'll resolve once reconnected or
    // reject on the 5s retry timeout.
    let daemonSessions;
    try {
      daemonSessions = await client.list();
    } catch (err) {
      log.error && log.error('[replay] daemon list() failed:', err.message);
      return false;
    }
    const entry = Array.isArray(daemonSessions)
      ? daemonSessions.find((e) => e.sessionId === sid)
      : null;
    if (!entry) return false;
    if (!(entry.bufferEntries > 0)) return false;

    // Compounding-history gate (2026-04-20): if the main server already
    // persisted a complete assistant row for this turn (via finishMessage),
    // the daemon buffer is stale — replaying it would re-parse the CLI
    // stream-json and call finishMessage a SECOND time, appending a duplicate
    // assistant row. Each reopen would compound further.
    //
    // Skip replay when history tail looks complete. Preserve amnesia-killer
    // semantics: if the tail is missing, partial, or empty, replay MUST
    // still fire — that's the legitimate hard-crash recovery path where
    // finishMessage never got a chance to run.
    try {
      const session = manager.get ? manager.get(sid) : null;
      const history = session && Array.isArray(session.history) ? session.history : null;
      if (history && history.length > 0) {
        const tail = history[history.length - 1];
        const isCompleteAssistant =
          tail &&
          tail.role === 'assistant' &&
          tail.partial !== true &&
          typeof tail.content === 'string' &&
          tail.content.length > 0;
        if (isCompleteAssistant) {
          // History tail is complete; daemon buffer is stale leftover from a
          // turn we already persisted. Skip replay, claim the slot to prevent
          // re-attempt this lifetime, and ask the daemon to drop its buffer
          // so subsequent reopens don't keep re-triggering this same guard.
          replayedSet.add(sid);
          try {
            if (typeof client.purge === 'function') {
              client.purge(sid).catch((err) => {
                log.error && log.error('[replay] post-skip purge failed:', err.message);
              });
            }
          } catch (err) {
            log.error && log.error('[replay] post-skip purge threw:', err.message);
          }
          log.log && log.log('[replay] skipped for', sid.slice(0, 8),
            '— history tail complete, bufferEntries=', entry.bufferEntries);
          return false;
        }
      }
    } catch (err) {
      // Non-fatal: if the history inspection itself throws, fall through to
      // replay. Better to risk a duplicate than skip a legitimate recovery.
      log.error && log.error('[replay] history-tail check failed:', err.message);
    }

    // Crash-loop cap (2026-05-22 token-drain fix): a session that has already
    // been auto-recovered 3× without a completed turn is parked, not replayed
    // again. Without this, a session whose turns never finish is re-run on
    // every WS reconnect — each replay re-ingests the full (huge) transcript,
    // draining tokens. finishMessage() resets _resumeAttempts to 0 on any
    // successful completion, so a healthy session is never capped.
    const rawSession = manager.sessions && manager.sessions.get(sid);
    const attempts = (rawSession && rawSession._resumeAttempts) || 0;
    if (attempts >= 3) {
      replayedSet.add(sid); // claim slot for this lifetime — stop re-attempting
      log.log && log.log('[replay] capped for', sid.slice(0, 8),
        '— _resumeAttempts=', attempts, '(send a new message to retry)');
      return false;
    }

    // Claim the slot BEFORE awaiting resume so a second join in the same
    // tick can't double-subscribe.
    replayedSet.add(sid);
    if (rawSession) rawSession._resumeAttempts = attempts + 1;

    let proc;
    try {
      proc = await client.resume(sid);
    } catch (err) {
      replayedSet.delete(sid);
      log.error && log.error('[replay] daemon resume failed for', sid.slice(0, 8), err.message);
      return false;
    }

    // Adopt the RemoteProc into session-manager so future hasLiveProc checks
    // return true (prevents a second replay from firing while the first is
    // still streaming the buffer + live tail).
    try {
      if (manager.adoptReplayProc) manager.adoptReplayProc(sid, proc);
    } catch (err) {
      log.error && log.error('[replay] adoptReplayProc failed:', err.message);
      // Non-fatal — replay still works, second-join dedup weakens.
    }

    // Wire the stream handler so buffered + live stdout flows through the
    // same delta/tool_use/done pipeline as a fresh spawn. The daemon's
    // flushBufferTo fires immediately after ack, then keeps streaming live.
    try {
      spawnStreamHandler(proc, sid);
    } catch (err) {
      replayedSet.delete(sid);
      log.error && log.error('[replay] spawnStreamHandler threw:', err.message);
      return false;
    }

    // Release the idempotency slot when the RemoteProc closes — natural exit,
    // subsequent doSpawn that kills the orphan, or daemon disconnect. A
    // future join can then replay again if new buffer accumulates.
    proc.on('close', () => { replayedSet.delete(sid); });

    log.log && log.log('[replay] fired for', sid.slice(0, 8), 'bufferEntries=', entry.bufferEntries, 'exited=', entry.exited);
    return true;
  } catch (err) {
    replayedSet.delete(sid);
    (logger && logger.error ? logger.error : console.error)('[replay] unexpected error:', err.message);
    return false;
  }
}

module.exports = { maybeReplaySession };
