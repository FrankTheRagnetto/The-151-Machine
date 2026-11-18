/**
 * session-host-client.js — Phase 2 IPC client for the session-host daemon.
 *
 * Mirrors just enough of Node's ChildProcess surface that session-manager.js
 * can hand the returned object to server/index.js's spawnStreamHandler(proc, sid)
 * without code changes elsewhere. The remote proc exposes:
 *   - .stdout, .stderr : EventEmitter with 'data' + 'error' events
 *   - .stdin           : writable-ish stub (only real when stdinMode === 'pipe')
 *   - .on('close', cb) / .on('error', cb)
 *   - .kill(signal?)   : sends a 'kill' message to the daemon
 *   - .pid             : populated after spawn ack
 *
 * Protocol: JSON-line over named pipe \\.\pipe\151-session-host (or TCP fallback
 * 127.0.0.1:3172 if SESSION_HOST_FORCE_TCP=1, matching the daemon's flag).
 *
 * Reconnect: exponential backoff 200ms -> 5000ms. Each reconnect is logged.
 * Inflight requests during a disconnect reject with a 'session-host unreachable'
 * error — callers (session-manager with USE_SESSION_HOST=1) surface that up.
 * We never silently fall back to local spawn; the whole point of Phase 2 is
 * that sessions live in the daemon, so degrading to local would mask failures.
 *
 * stdio note: the daemon spawns the child with stdio:['pipe','pipe','pipe'].
 * session-manager.sendMessage pipes the prompt to the child's stdin (instead
 * of passing it via `-p <prompt>` argv) to dodge the Windows 32 KB
 * CreateProcess cap — see the ENAMETOOLONG comment in session-manager.js.
 * RemoteProc.stdin.end() forwards to the daemon via sendStdinEnd, which
 * closes the child's stdin so `claude -p` sees EOF and processes the prompt.
 */

'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const PIPE_PATH = '\\\\.\\pipe\\151-session-host';
const TCP_FALLBACK_HOST = '127.0.0.1';
const TCP_FALLBACK_PORT = parseInt(process.env.SESSION_HOST_PORT, 10) || 3172; // env: solo le prove

const RECONNECT_MIN_MS = 200;
const RECONNECT_MAX_MS = 5000;

// Module-level call counter so integration tests can assert "client never called"
// when the flag is OFF. Incremented by every public method.
let _callCount = 0;

class SessionHostClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.buf = '';
    this.pending = new Map(); // reqId -> { resolve, reject }
    this.procs = new Map();   // sessionId -> RemoteProc
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.shuttingDown = false;
    this._connectPromise = null;
    this._forceTcp = process.env.SESSION_HOST_FORCE_TCP === '1';
    // Phase 3b (2026-04-18): retry queue for spawn/list issued during a
    // disconnect window. Keeps the first session spawn after a full restart
    // from failing with "session-host unreachable" while the reconnect loop
    // (200ms -> 5s backoff) re-establishes the pipe. Only spawn/list are
    // safe to retry — stdin/kill target a specific live child, so a retry
    // after reconnect would act on the wrong (or no) process.
    this._retryQueue = [];
    this._queuePollTimer = null;
  }

  // Drive reconnect attempts while the retry queue has entries. Idempotent:
  // a single timer runs regardless of how many calls trigger it. Stops on
  // successful connect (drain happens via onConnect's _drainRetryQueue) or
  // when the queue empties (all entries timed out).
  _startQueuePolling() {
    if (this._queuePollTimer) return;
    const tick = () => {
      this._queuePollTimer = null;
      // Prune already-settled (timed out) entries.
      this._retryQueue = this._retryQueue.filter((e) => !e.settled);
      if (!this._retryQueue.length) return;
      if (this.connected) return; // onConnect drains
      if (this.shuttingDown) return;
      this._connect().catch(() => { /* next tick retries */ });
      this._queuePollTimer = setTimeout(tick, 250);
    };
    this._queuePollTimer = setTimeout(tick, 250);
  }

  // Drain the retry queue after a successful (re)connect. Each entry's
  // replay() re-issues the original _request; its embedded timeout clears
  // when the ack comes back. If the reconnect is too slow, the per-entry
  // timer has already rejected the caller.
  _drainRetryQueue() {
    if (!this._retryQueue.length) return;
    this._log('info', 'draining retry queue', { count: this._retryQueue.length });
    const queue = this._retryQueue;
    this._retryQueue = [];
    for (const entry of queue) {
      if (entry.settled) continue;
      try { entry.replay(); } catch (err) { entry.reject(err); }
    }
  }

  _log(level, msg, extra) {
    const line = `[session-host-client] ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');
    if (level === 'error') console.error(line);
    else console.log(line);
  }

  _connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const target = this._forceTcp
        ? { host: TCP_FALLBACK_HOST, port: TCP_FALLBACK_PORT }
        : PIPE_PATH;
      const socket = this._forceTcp
        ? net.createConnection(target)
        : net.createConnection(PIPE_PATH);
      socket.setEncoding('utf8');

      const onError = (err) => {
        socket.removeListener('connect', onConnect);
        this._connectPromise = null;
        reject(err);
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        // [17/10/2026] Prima riga: la chiave (il session-host chiude chi non la manda).
        let key = '';
        try { key = require('./session-host-key').loadOrCreateKey(); }
        catch (err) { this._log('error', 'session-host key unavailable', { err: err.message }); }
        socket.write(JSON.stringify({ type: 'hello', key }) + '\n');
        this.socket = socket;
        this.connected = true;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this._log('info', 'connected', { transport: this._forceTcp ? 'tcp' : 'pipe' });
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => this._onClose());
        socket.on('error', (err) => this._log('error', 'socket error', { err: err.message }));
        this._connectPromise = null;
        resolve();
        // Replay any spawn/list requests that were queued during the outage.
        // Done after resolve() so the reconnect-waiter unblocks first.
        try { this._drainRetryQueue(); } catch (err) {
          this._log('error', 'drain failed', { err: err.message });
        }
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    return this._connectPromise;
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    // Fail all pending requests — the daemon won't ack them anymore.
    for (const [, pending] of this.pending) {
      try { pending.reject(new Error('session-host connection closed')); } catch {}
    }
    this.pending.clear();
    // Signal exit to any remote procs that were running — the daemon might
    // still have them alive (sessions survive client disconnect per Phase 1
    // design), but our event stream is broken, so the consumer should treat
    // it as dead. On reconnect, session-manager would need to re-issue spawn;
    // Phase 3 can add 'resume' auto-recovery here.
    for (const [sid, proc] of this.procs) {
      proc._emitClose(1, null);
      this.procs.delete(sid);
    }
    if (this.shuttingDown) return;
    if (wasConnected) this._log('info', 'disconnected, will reconnect', { delay: this.reconnectDelay });
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    setTimeout(() => {
      this._log('info', 'reconnecting', { delay });
      this._connect().catch((err) => {
        this._log('error', 'reconnect failed', { err: err.message });
        // _onClose will be re-triggered by the failed socket, rescheduling.
      });
    }, delay);
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (err) {
        this._log('error', 'bad json from daemon', { line: line.slice(0, 200) });
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    const { type, reqId, sessionId } = msg;
    if (type === 'ack' || (type === 'error' && reqId)) {
      const p = this.pending.get(reqId);
      if (p) {
        this.pending.delete(reqId);
        if (type === 'ack') p.resolve(msg);
        else p.reject(new Error(msg.message || 'daemon error'));
      }
      return;
    }
    if (!sessionId) return;
    const proc = this.procs.get(sessionId);
    if (!proc) return;
    if (type === 'stdout') proc.stdout.emit('data', Buffer.from(msg.data, 'utf8'));
    else if (type === 'stderr') proc.stderr.emit('data', Buffer.from(msg.data, 'utf8'));
    else if (type === 'exit') {
      // Guard: if this proc hasn't received its spawn ack yet (pid is null),
      // this exit is from a previous spawn for the same sessionId — ignore it.
      if (proc.pid == null) {
        this._log('info', 'ignoring stale exit for unacked proc', { sessionId: sessionId.slice(0, 8) });
        return;
      }
      proc._emitClose(msg.code, msg.signal);
      this.procs.delete(sessionId);
    } else if (type === 'error') {
      proc.emit('error', new Error(msg.message || 'daemon stream error'));
    }
  }

  async _ensureConnected() {
    if (this.connected) return;
    await this._connect();
  }

  _send(obj) {
    if (!this.socket || !this.connected) {
      throw new Error('session-host unreachable');
    }
    this.socket.write(JSON.stringify(obj) + '\n');
  }

  _request(obj) {
    return new Promise((resolve, reject) => {
      const reqId = obj.reqId || randomUUID();
      obj.reqId = reqId;
      const send = () => {
        this.pending.set(reqId, { resolve, reject });
        try { this._send(obj); }
        catch (err) { this.pending.delete(reqId); reject(err); }
      };
      // Retry-queue gate: only for spawn/list, only while disconnected and
      // not shutting down. Mid-flight requests (already in `pending`) are
      // NOT re-queued on close — that's still the existing reject-on-close
      // behavior; the caller surfaces them and can retry from above.
      const retryable = (obj.type === 'spawn' || obj.type === 'list');
      if (retryable && !this.connected && !this.shuttingDown) {
        const entry = { settled: false, reject: null, replay: null };
        const timer = setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          reject(new Error('session-host unreachable'));
        }, 5000);
        entry.reject = (err) => {
          if (entry.settled) return;
          entry.settled = true;
          clearTimeout(timer);
          reject(err);
        };
        entry.replay = () => {
          if (entry.settled) return;
          entry.settled = true;
          clearTimeout(timer);
          send();
        };
        this._retryQueue.push(entry);
        this._log('info', 'queued for retry', { type: obj.type, queued: this._retryQueue.length });
        // Drive reconnects while requests are queued. _onClose's backoff only
        // fires AFTER a socket 'close'; for a cold queue (no prior socket yet)
        // we need our own poll loop. _startQueuePolling is idempotent.
        this._startQueuePolling();
        return;
      }
      send();
    });
  }

  /**
   * spawn({ sessionId, args, env, stdinMode })
   * Returns a Promise<RemoteProc> that looks like a ChildProcess to the caller.
   * stdinMode: 'ignore' (default) | 'pipe'. Passed through to the daemon
   *   for future honor; Phase 1 daemon always uses 'pipe' regardless.
   * cwd: optional working directory forwarded to the daemon.
   */
  async spawn({ sessionId, args, env, cwd, stdinMode }) {
    _callCount++;
    if (!sessionId) throw new Error('spawn requires sessionId');
    if (!Array.isArray(args)) throw new Error('spawn requires args[]');
    // Best-effort connect. If the daemon isn't listening yet, the retry-queue
    // gate inside _request below enqueues the spawn and replays on reconnect.
    try { await this._ensureConnected(); } catch (_) { /* fall through to queue */ }
    // Reuse existing RemoteProc if caller pre-registered one (session-manager
    // does this to keep a synchronous ChildProcess-shape return). Otherwise
    // create our own so direct callers of this API also work.
    let proc = this.procs.get(sessionId);
    if (!proc) {
      proc = new RemoteProc(this, sessionId, stdinMode || 'ignore');
      this.procs.set(sessionId, proc);
    }
    try {
      const ack = await this._request({
        type: 'spawn',
        sessionId,
        args,
        env: env || {},
        cwd: cwd || undefined,
        stdinMode: stdinMode || 'ignore',
      });
      proc.pid = ack.pid || null;
      return proc;
    } catch (err) {
      this.procs.delete(sessionId);
      throw err;
    }
  }

  async sendStdin(sessionId, data) {
    _callCount++;
    await this._ensureConnected();
    return this._request({ type: 'stdin', sessionId, data });
  }

  // Close the child's stdin (EOF). Needed when feeding a prompt to
  // `claude -p` via pipe: the CLI reads until EOF, so without this the
  // child hangs waiting for more input. See session-manager sendMessage.
  async sendStdinEnd(sessionId) {
    _callCount++;
    await this._ensureConnected();
    return this._request({ type: 'stdin', sessionId, data: '', end: true });
  }

  async kill(sessionId) {
    _callCount++;
    // If we're not connected, the daemon still holds the process; best-effort.
    // Throw so caller knows, rather than silently succeeding.
    await this._ensureConnected();
    return this._request({ type: 'kill', sessionId });
  }

  async list() {
    _callCount++;
    // Best-effort connect; retry-queue in _request handles disconnect window.
    try { await this._ensureConnected(); } catch (_) { /* fall through to queue */ }
    const ack = await this._request({ type: 'list' });
    return ack.sessions || [];
  }

  async resume(sessionId) {
    _callCount++;
    await this._ensureConnected();
    const proc = this.procs.get(sessionId) || new RemoteProc(this, sessionId, 'ignore');
    this.procs.set(sessionId, proc);
    await this._request({ type: 'resume', sessionId });
    return proc;
  }

  /**
   * Ask the daemon to drop its ring buffer + on-disk jsonl for `sessionId`.
   * Called from session-manager.finishMessage after the assistant row has
   * been persisted to session.history, so a subsequent WS reopen doesn't
   * trigger daemon replay against stale buffered stream-json (which would
   * re-parse the same turn and append a duplicate assistant row).
   *
   * Best-effort: if the daemon is unreachable we swallow the error — the
   * stale buffer is only a correctness issue on reopen, and the next purge
   * attempt (on the next finishMessage for this sid) will clean up.
   */
  async purge(sessionId) {
    _callCount++;
    if (!sessionId) throw new Error('purge requires sessionId');
    try { await this._ensureConnected(); }
    catch (err) {
      // Daemon down — nothing to purge right now; log and bail.
      this._log('info', 'purge skipped (daemon unreachable)', { sessionId: sessionId.slice(0, 8) });
      return { skipped: true, reason: err.message };
    }
    return this._request({ type: 'purge', sessionId });
  }

  shutdown() {
    this.shuttingDown = true;
    if (this._queuePollTimer) { clearTimeout(this._queuePollTimer); this._queuePollTimer = null; }
    // Reject anything still queued so callers unblock promptly.
    for (const entry of this._retryQueue) {
      if (!entry.settled) entry.reject(new Error('session-host client shutting down'));
    }
    this._retryQueue = [];
    if (this.socket) {
      try { this.socket.end(); } catch {}
    }
  }
}

/**
 * RemoteProc — ChildProcess-compatible facade backed by the daemon.
 * Satisfies the subset used by server/index.js: stdout/stderr 'data'+'error',
 * 'close' with (code), 'error' with (err), .kill(), .pid, .stdin.write/end.
 */
class RemoteProc extends EventEmitter {
  constructor(client, sessionId, stdinMode) {
    super();
    this._client = client;
    this._sessionId = sessionId;
    this._stdinMode = stdinMode;
    this._closed = false;
    this.pid = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    // stdin: for 'pipe' mode, writes go through the client. For 'ignore',
    // writes are no-ops (matches a ChildProcess spawned with stdio[0]='ignore'
    // where .stdin is null — but session-manager never calls .stdin when
    // using 'ignore', so a benign stub is safer than null).
    this.stdin = {
      write: (data) => {
        if (this._closed) return false;
        this._client.sendStdin(this._sessionId, data.toString('utf8')).catch((err) => {
          this.emit('error', err);
        });
        return true;
      },
      end: () => {
        if (this._closed || this.stdin.destroyed) return;
        this.stdin.destroyed = true;
        this._client.sendStdinEnd(this._sessionId).catch((err) => {
          this.emit('error', err);
        });
      },
      destroyed: false,
    };
  }

  kill(_signal) {
    if (this._closed) return true;
    this._client.kill(this._sessionId).catch((err) => {
      // Kill failures mostly mean "already dead" — log but don't throw.
      console.error('[session-host-client] kill failed', err.message);
    });
    return true;
  }

  _emitClose(code, signal) {
    if (this._closed) return;
    this._closed = true;
    this.stdin.destroyed = true;
    // Match ChildProcess: both 'exit' and 'close' fire. server/index.js only
    // listens for 'close', but emit both to be safe.
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

// Singleton — the main server process only needs one client.
let _instance = null;
function getClient() {
  if (!_instance) _instance = new SessionHostClient();
  return _instance;
}

module.exports = {
  getClient,
  SessionHostClient,
  RemoteProc,
  PIPE_PATH,
  TCP_FALLBACK_HOST,
  TCP_FALLBACK_PORT,
  // Test hook: read-only accessor so integration tests can assert zero calls
  // when USE_SESSION_HOST is unset.
  _getCallCount: () => _callCount,
  _resetCallCount: () => { _callCount = 0; },
};
