/**
 * 151-session-host — Phase 1 daemon
 *
 * Purpose: Own all Claude CLI child processes so the main 151-machine UI/API
 * server can be restarted (via pm2) without dropping active chats. The main
 * server will talk to us via local IPC in Phase 2.
 *
 * IPC: Windows named pipe at \\.\pipe\151-session-host.
 *      JSON-line protocol (one JSON object per line, '\n' delimited).
 *
 * Fallback: If the named pipe fails to bind (or a connection test from
 * test-client.js never completes), we auto-fall-back to 127.0.0.1:3172 with
 * a key from ~/.151machine/session-host.key (server/session-host-key.js), sent
 * as the first message {type:'hello', key} (17/10/2026). See README in
 * test-client for how that path is exercised. The fallback is documented
 * in ops-151-server.md.
 *
 * Inbound message types:
 *   { type: 'spawn',  reqId, sessionId, args: [...], env: {...}, cwd?: string }
 *   { type: 'stdin',  sessionId, data: string, end?: boolean }
 *   { type: 'kill',   reqId, sessionId }
 *   { type: 'list',   reqId }
 *   { type: 'resume', reqId, sessionId }   // attach to existing stream
 *   { type: 'purge',  reqId, sessionId }   // drop ring buffer + on-disk jsonl
 *
 * Outbound message types:
 *   { type: 'ack',    reqId, ok: true, ... }
 *   { type: 'error',  reqId, message }
 *   { type: 'stdout', sessionId, data }
 *   { type: 'stderr', sessionId, data }
 *   { type: 'exit',   sessionId, code, signal }
 *
 * Sessions survive client disconnect. A new client can 'resume' to reattach.
 * Per-session ring buffer is capped at RING_BUFFER_MAX bytes (~2MB) and also
 * at RING_BUFFER_MAX_ENTRIES (5000 entries, matching sessionMessageQueue in
 * the main server — see ops-151-server.md note from 2026-04-13).
 *
 * This file DUPLICATES the CLI spawn pattern from server/session-manager.js
 * intentionally (Phase 1 — we un-duplicate in Phase 2).
 */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const persist = require('./buffer-persistence');
const { loadOrCreateKey, keyMatches } = require('../session-host-key');

// ----- config --------------------------------------------------------------

const PIPE_PATH = '\\\\.\\pipe\\151-session-host';
const TCP_FALLBACK_HOST = '127.0.0.1';
const TCP_FALLBACK_PORT = parseInt(process.env.SESSION_HOST_PORT, 10) || 3172; // env: solo le prove
// [17/10/2026] Chi si collega ha questo tempo per presentarsi con la chiave.
const HELLO_TIMEOUT_MS = parseInt(process.env.SESSION_HOST_HELLO_MS, 10) || 5000;
let HOST_KEY = null; // letta (o creata) all'avvio, in main()

const SERVER_DIR = path.resolve(__dirname, '..');       // .../server
const LOGS_DIR = path.join(SERVER_DIR, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'session-host.log');

// Ring buffer limits per session (see ops-151-server.md — 2026-04-13 queue overflow note)
const RING_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // ~2MB
const RING_BUFFER_MAX_ENTRIES = 5000;

// Claude binary — mirrors session-manager.js exactly
const CLAUDE_BIN = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.local', 'bin',
  process.platform === 'win32' ? 'claude.exe' : 'claude'
);

// ----- logging -------------------------------------------------------------

function ensureLogsDir() {
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
}
ensureLogsDir();

function log(level, msg, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra || {}),
  }) + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  // Also mirror to stdout/stderr so pm2 picks it up
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

// ----- state ---------------------------------------------------------------

/**
 * sessions: sessionId -> {
 *   proc: ChildProcess,
 *   buffer: Array<{ stream: 'stdout'|'stderr', data: string }>,
 *   bufferBytes: number,
 *   exited: boolean,
 *   exitInfo: { code, signal } | null,
 *   subscribers: Set<ClientConn>,
 * }
 */
const sessions = new Map();

/**
 * clients: Set<ClientConn>
 * ClientConn: { socket, buf: string, subs: Set<sessionId>, alive: boolean }
 */
const clients = new Set();

// ----- helpers -------------------------------------------------------------

function safeSend(conn, obj) {
  if (!conn || !conn.alive) return;
  try {
    conn.socket.write(JSON.stringify(obj) + '\n');
  } catch (err) {
    log('error', 'send failed', { err: err.message });
  }
}

function broadcastToSubscribers(sessionId, obj) {
  const s = sessions.get(sessionId);
  if (!s) return;
  for (const conn of s.subscribers) safeSend(conn, obj);
}

function pushToBuffer(session, stream, data) {
  session.buffer.push({ stream, data });
  session.bufferBytes += Buffer.byteLength(data, 'utf8');
  // Trim by byte budget first, then by entry cap
  while (session.bufferBytes > RING_BUFFER_MAX_BYTES && session.buffer.length > 1) {
    const dropped = session.buffer.shift();
    session.bufferBytes -= Buffer.byteLength(dropped.data, 'utf8');
  }
  while (session.buffer.length > RING_BUFFER_MAX_ENTRIES) {
    const dropped = session.buffer.shift();
    session.bufferBytes -= Buffer.byteLength(dropped.data, 'utf8');
  }
  // Phase 6: mirror to disk so a joint crash of daemon+main doesn't lose
  // buffered stdout. Async + batched inside the persister; never blocks the
  // pipe path. Only persist when we actually know the sid.
  if (session._sid) persist.append(session._sid, stream, data);
}

async function flushBufferTo(conn, sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  // Phase 6: drain any pending disk writes so post-crash replay sees the
  // freshest bytes. Non-blocking from the persister's side (fsp.appendFile),
  // and sessions rarely have more than a few KB pending at any moment.
  try { await persist.flushNow(sessionId); } catch {}
  for (const entry of s.buffer) {
    safeSend(conn, { type: entry.stream, sessionId, data: entry.data });
  }
  if (s.exited && s.exitInfo) {
    safeSend(conn, { type: 'exit', sessionId, ...s.exitInfo });
  }
}

// ----- spawn logic (duplicated from session-manager.js — Phase 1) ----------

function doSpawn({ sessionId, args, env, cwd }) {
  // Main server reuses one sessionId per conversation — a second message for
  // the same UI session arrives here after the previous child has exited.
  // GC the stale record (matches the TODO on the 'exit' handler below) so the
  // fresh spawn can reuse the same id. Only reject if a live proc is still
  // attached (double-spawn while busy — a real bug upstream).
  const existing = sessions.get(sessionId);
  if (existing) {
    if (!existing.exited) {
      // The client reconnected after a pipe disconnect and is re-spawning a
      // session the daemon still owns. Kill the orphaned process so the fresh
      // spawn can take over. This is safe: the main server already signalled
      // clients that the session ended (via _emitClose during _onClose), so
      // no consumer is waiting on the old stream.
      log('warn', 'doSpawn: killing orphaned live session to allow re-spawn', { sessionId });
      try { existing.proc.kill('SIGTERM'); } catch {}
      // Windows SIGTERM is emulated — hard-kill after 2 s if still alive.
      const pid = existing.proc.pid;
      setTimeout(() => {
        if (!existing.exited && pid) {
          try { process.platform === 'win32' ? require('child_process').exec(`taskkill /F /T /PID ${pid}`, () => {}) : process.kill(pid, 'SIGKILL'); } catch {}
        }
      }, 2000);
      existing.exited = true; // prevent double-kill
    }
    // Detach old proc's listeners so its async exit/error doesn't broadcast
    // through the NEW session's subscribers (race: old child dies after the
    // new session record is in the map → broadcastToSubscribers routes the
    // stale exit to the new proc's client, which prematurely closes it).
    if (existing.proc) existing.proc.removeAllListeners();
    // Drop buffers + subscribers; the client has already consumed the prior
    // stream via 'exit' event and is starting a new turn.
    for (const conn of existing.subscribers) conn.subs.delete(sessionId);
    sessions.delete(sessionId);
    // Phase 6: purge on-disk buffer so the new child starts clean. Matches
    // RAM behavior (the `sessions.delete` above wipes the RAM ring).
    persist.purge(sessionId).catch(() => {});
  }

  // args come from the client verbatim — we trust the caller to pass the
  // same --output-format stream-json / --verbose / --permission-mode flags
  // that session-manager.js currently uses. The daemon is agnostic to the
  // CLI's flag surface.
  const mergedEnv = { ...process.env, ...(env || {}) };
  const workDir = cwd || process.env.USERPROFILE || process.cwd();

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: workDir,
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],  // stdin is 'pipe' here so clients CAN send stdin;
                                      // session-manager.js uses 'ignore' — Phase 2 client
                                      // chooses per-call.
    windowsHide: true,
  });

  const session = {
    _sid: sessionId,   // Phase 6: tag for persist.append (pushToBuffer uses this)
    proc,
    buffer: [],
    bufferBytes: 0,
    exited: false,
    exitInfo: null,
    subscribers: new Set(),
  };
  sessions.set(sessionId, session);

  // Line-buffered stdout/stderr. Claude CLI stream-json emits one JSON per
  // line; the main server parses those upstream. We forward each chunk as it
  // arrives AND keep a running buffer for resume.
  const forward = (stream) => (chunk) => {
    const data = chunk.toString('utf8');
    pushToBuffer(session, stream, data);
    broadcastToSubscribers(sessionId, { type: stream, sessionId, data });
  };
  proc.stdout.on('data', forward('stdout'));
  proc.stderr.on('data', forward('stderr'));

  proc.on('exit', (code, signal) => {
    session.exited = true;
    session.exitInfo = { code, signal };
    broadcastToSubscribers(sessionId, { type: 'exit', sessionId, code, signal });
    log('info', 'session exited', { sessionId, code, signal });
    // Session record lingers so a late resume can still see exit info.
    // A cleanup pass could GC these — Phase 2 concern.
  });

  proc.on('error', (err) => {
    log('error', 'spawn error', { sessionId, err: err.message });
    broadcastToSubscribers(sessionId, { type: 'error', sessionId, message: err.message });
  });

  log('info', 'spawned', { sessionId, pid: proc.pid, args });
  return { pid: proc.pid };
}

function doStdin(sessionId, data, end) {
  const s = sessions.get(sessionId);
  if (!s || s.exited) throw new Error(`session ${sessionId} not running`);
  if (!s.proc.stdin || s.proc.stdin.destroyed) throw new Error(`session ${sessionId} stdin unavailable`);
  if (data !== undefined && data !== null && data !== '') s.proc.stdin.write(data);
  // end=true signals EOF to the child (needed for `claude -p` which reads
  // the prompt from stdin until close).
  if (end) { try { s.proc.stdin.end(); } catch {} }
}

function doKill(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`session ${sessionId} not found`);
  if (s.exited) return { alreadyExited: true };
  try { s.proc.kill('SIGTERM'); } catch (err) { throw new Error('kill failed: ' + err.message); }
  // Windows SIGTERM is emulated — schedule a hard kill if it doesn't die.
  const pid = s.proc.pid;
  setTimeout(() => {
    if (!s.exited && pid) {
      try {
        process.platform === 'win32' ? require('child_process').exec(`taskkill /F /T /PID ${pid}`, () => {}) : process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }, 2000);
  return { killSent: true };
}

/**
 * Drop the in-memory ring buffer AND the on-disk jsonl for a session.
 * Called after the main server has finalized an assistant turn into its
 * persisted history — the daemon buffer is then stale and replaying it on
 * a subsequent reopen would compound a duplicate assistant row into history.
 *
 * Separate from `kill`: kill ends the CLI child and keeps the buffer so a
 * late client can still read the tail. `purge` drops buffer only; if a live
 * proc is still attached we leave it alone and just wipe state that replay
 * would key off (the common case for purge is post-exit anyway, and the
 * main server only calls purge from finishMessage which fires after exit).
 */
function doPurge(sessionId) {
  const s = sessions.get(sessionId);
  // Always hit disk — persist.purge handles missing files as ENOENT no-ops.
  persist.purge(sessionId).catch((err) => {
    log('error', 'persist.purge failed', { sessionId, err: err.message });
  });
  if (!s) return { existed: false };
  // Clear subscribers' cross-reference so they don't try to flush a dead buffer.
  for (const conn of s.subscribers) conn.subs.delete(sessionId);
  s.buffer = [];
  s.bufferBytes = 0;
  // Only drop the session record if the proc is already exited. A live proc
  // still needs a home for forward() to push into — we can't wipe the map
  // entry from under it. Rare case since finishMessage waits for close.
  if (s.exited) {
    sessions.delete(sessionId);
  }
  return { existed: true, exited: !!s.exited };
}

function doList() {
  const out = [];
  for (const [id, s] of sessions.entries()) {
    out.push({
      sessionId: id,
      pid: s.proc ? s.proc.pid : null,    // null for Phase 6 hydrated-from-disk sessions
      exited: s.exited,
      exitInfo: s.exitInfo,
      bufferBytes: s.bufferBytes,
      bufferEntries: s.buffer.length,
      subscribers: s.subscribers.size,
    });
  }
  return out;
}

// ----- client connection handling ------------------------------------------

function onConnection(socket, transport) {
  const conn = {
    socket,
    buf: '',
    subs: new Set(),
    alive: true,
    authed: false,
  };
  clients.add(conn);
  log('info', 'client connected', { transport });

  socket.setEncoding('utf8');

  // [17/10/2026] /hack punto 1: prima di tutto la chiave. Il primo messaggio
  // deve essere {type:'hello', key}; qualunque altra cosa (un comando, una
  // richiesta HTTP da una pagina web, una chiave sbagliata, il silenzio)
  // chiude il collegamento senza eseguire niente.
  const rifiuta = (why) => {
    log('error', 'client refused', { transport, why });
    try { socket.destroy(); } catch {}
  };
  const helloTimer = setTimeout(() => { if (!conn.authed) rifiuta('no hello in time'); }, HELLO_TIMEOUT_MS);
  if (helloTimer.unref) helloTimer.unref();

  socket.on('data', (chunk) => {
    if (!conn.alive) return;
    conn.buf += chunk;
    if (!conn.authed && conn.buf.length > 4096) { rifiuta('oversized hello'); return; }
    let idx;
    while ((idx = conn.buf.indexOf('\n')) >= 0) {
      const line = conn.buf.slice(0, idx).trim();
      conn.buf = conn.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (err) {
        if (!conn.authed) { rifiuta('not a hello'); return; }
        safeSend(conn, { type: 'error', message: 'invalid json: ' + err.message });
        continue;
      }
      if (!conn.authed) {
        if (!msg || msg.type !== 'hello' || !keyMatches(msg.key, HOST_KEY)) {
          safeSend(conn, { type: 'error', message: 'unauthorized' });
          rifiuta(msg && msg.type === 'hello' ? 'wrong key' : 'not a hello');
          return;
        }
        conn.authed = true;
        clearTimeout(helloTimer);
        safeSend(conn, { type: 'ack', reqId: msg.reqId, ok: true, hello: true });
        continue;
      }
      handleMessage(conn, msg);
    }
  });

  const cleanup = () => {
    if (!conn.alive) return;
    conn.alive = false;
    clients.delete(conn);
    // Unsubscribe from any sessions — but do NOT kill them. Sessions
    // survive client disconnect. A new client can 'resume' to reattach.
    for (const sid of conn.subs) {
      const s = sessions.get(sid);
      if (s) s.subscribers.delete(conn);
    }
    log('info', 'client disconnected', { transport });
  };
  socket.on('close', cleanup);
  socket.on('end', cleanup);
  socket.on('error', (err) => {
    log('error', 'socket error', { err: err.message, transport });
    cleanup();
  });
}

function handleMessage(conn, msg) {
  const { type, reqId } = msg;
  try {
    switch (type) {
      case 'spawn': {
        const { sessionId, args, env, cwd } = msg;
        if (!sessionId || !Array.isArray(args)) throw new Error('spawn needs sessionId and args[]');
        const result = doSpawn({ sessionId, args, env, cwd });
        // Auto-subscribe the spawner to this session's stream.
        const s = sessions.get(sessionId);
        if (s) { s.subscribers.add(conn); conn.subs.add(sessionId); }
        safeSend(conn, { type: 'ack', reqId, ok: true, sessionId, pid: result.pid });
        break;
      }
      case 'stdin': {
        const { sessionId, data, end } = msg;
        doStdin(sessionId, data, end);
        safeSend(conn, { type: 'ack', reqId, ok: true });
        break;
      }
      case 'kill': {
        const { sessionId } = msg;
        const r = doKill(sessionId);
        safeSend(conn, { type: 'ack', reqId, ok: true, ...r });
        break;
      }
      case 'list': {
        safeSend(conn, { type: 'ack', reqId, ok: true, sessions: doList() });
        break;
      }
      case 'purge': {
        const { sessionId } = msg;
        if (!sessionId) throw new Error('purge needs sessionId');
        const r = doPurge(sessionId);
        safeSend(conn, { type: 'ack', reqId, ok: true, ...r });
        break;
      }
      case 'resume': {
        const { sessionId } = msg;
        const s = sessions.get(sessionId);
        if (!s) throw new Error(`session ${sessionId} not found`);
        s.subscribers.add(conn);
        conn.subs.add(sessionId);
        safeSend(conn, { type: 'ack', reqId, ok: true, sessionId, exited: s.exited });
        // Flush buffered output so the resuming client catches up. Async
        // (disk flush + stream) — errors logged, never crash the handler.
        flushBufferTo(conn, sessionId).catch((err) => {
          log('error', 'flushBufferTo failed', { sessionId, err: err.message });
        });
        break;
      }
      default:
        throw new Error('unknown type: ' + type);
    }
  } catch (err) {
    safeSend(conn, { type: 'error', reqId, message: err.message });
  }
}

// ----- server boot ---------------------------------------------------------

function startPipeServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => onConnection(socket, 'pipe'));
    server.on('error', (err) => {
      log('error', 'pipe server error', { err: err.message });
      reject(err);
    });
    server.listen(PIPE_PATH, () => {
      log('info', 'listening on pipe', { path: PIPE_PATH });
      resolve(server);
    });
  });
}

function startTcpServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => onConnection(socket, 'tcp'));
    server.on('error', (err) => {
      log('error', 'tcp server error', { err: err.message });
      reject(err);
    });
    server.listen(TCP_FALLBACK_PORT, TCP_FALLBACK_HOST, () => {
      log('info', 'listening on tcp (fallback)', { host: TCP_FALLBACK_HOST, port: TCP_FALLBACK_PORT });
      resolve(server);
    });
  });
}

/**
 * Phase 6: rehydrate buffers from disk so a joint daemon+main crash doesn't
 * erase in-flight stdout. Each hydrated session gets a skeleton record with
 * `proc: null`, `exited: true` — live streaming is gone (the real child died
 * with the daemon), but `resume` will replay buffered bytes and emit exit.
 * Replay from the main server (session-host-replay.js) only fires when
 * bufferEntries > 0 AND manager.hasLiveProc === false, which matches this
 * post-crash shape exactly.
 */
function hydrateFromDisk() {
  try {
    persist._setLogger({
      log: (...a) => log('info', a.join(' ')),
      error: (...a) => log('error', a.join(' ')),
    });
    persist.cleanupOld();
    const hydrated = persist.hydrateAll();
    for (const [sid, entries] of hydrated.entries()) {
      let bufferBytes = 0;
      for (const e of entries) bufferBytes += Buffer.byteLength(e.data, 'utf8');
      sessions.set(sid, {
        _sid: sid,
        proc: null,                      // daemon died with the child; no live pipe
        buffer: entries,                 // already in { stream, data } shape
        bufferBytes,
        exited: true,
        exitInfo: { code: null, signal: 'daemon-crash' },
        subscribers: new Set(),
      });
      log('info', 'hydrated session from disk', { sessionId: sid, entries: entries.length, bytes: bufferBytes });
    }
    if (hydrated.size) log('info', 'hydration complete', { count: hydrated.size });
  } catch (err) {
    log('error', 'hydrateFromDisk failed', { err: err.message });
  }
}

async function main() {
  hydrateFromDisk();
  // [17/10/2026] Senza chiave non entra nessuno (fail closed): meglio una
  // Machine che non parla col session-host di una porta aperta a tutti.
  try { HOST_KEY = loadOrCreateKey(); }
  catch (err) { log('error', 'session-host key unavailable — every client will be refused', { err: err.message }); }
  const forceTcp = process.env.SESSION_HOST_FORCE_TCP === '1';

  let server;
  let transport = 'pipe';
  if (forceTcp) {
    server = await startTcpServer();
    transport = 'tcp';
  } else {
    try {
      server = await startPipeServer();
    } catch (err) {
      log('error', 'pipe bind failed, falling back to tcp', { err: err.message });
      server = await startTcpServer();
      transport = 'tcp';
    }
  }

  log('info', 'session-host ready', {
    transport,
    pipe: transport === 'pipe' ? PIPE_PATH : null,
    tcp: transport === 'tcp' ? `${TCP_FALLBACK_HOST}:${TCP_FALLBACK_PORT}` : null,
    pid: process.pid,
    hasKey: !!HOST_KEY,
  });

  const shutdown = (sig) => {
    log('info', 'shutdown signal', { sig });
    try { server.close(); } catch {}
    // Kill any running children so we don't orphan them.
    for (const [sid, s] of sessions.entries()) {
      if (!s.exited && s.proc) {
        try { s.proc.kill('SIGTERM'); } catch {}
      }
    }
    // Phase 6: drain pending disk writes so the next boot sees every byte.
    // Best-effort — don't block exit past 500ms even if flush is slow.
    persist.drainAndStop().catch(() => {});
    // Give them a moment to die, then exit.
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log('error', 'uncaughtException', { err: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (err) => {
    log('error', 'unhandledRejection', { err: String(err) });
  });
}

if (require.main === module) {
  main().catch((err) => {
    log('error', 'fatal startup', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { PIPE_PATH, TCP_FALLBACK_HOST, TCP_FALLBACK_PORT };
