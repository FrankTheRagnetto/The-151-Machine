const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const transcribe = require('./transcribe');
const { logEvent } = require('./event-log');

// --- Trash (deleted-session recycle bin) ------------------------------------
// When the owner deletes a chat we don't drop it on the floor — we snapshot it to a
// trash directory FIRST (full JSON for revival + a readable .txt transcript for
// "what happened?" browsing). Lives on the box that owns the sessions (the PC,
// single source of truth); the Pi proxies /api/trash to it. No auto-purge —
// trash doubles as long-term history until the owner empties it himself.
const TRASH_DIR = process.env.SESSION_TRASH_DIR
  || path.join(os.homedir(), '.151machine', 'trash');

// Fleet action log (office model) — the single append-only log special agents read
// to catch up on each other's actions. We record a session CLOSE here. Path only;
// the actual call is fire-and-forget so logging can never break session teardown.
const FLEET_LOG_PY = path.join(os.homedir(), '.151machine', 'fleet', 'fleet-log.py');

// Fleet numbering (FLIP 2026-07-20): per-type counters are INCREMENTED at spawn
// and NEVER touched at deletion — a monotonic ticket, unique per session. CLAIM_PY
// (`claim.py <Type>`) is called ONCE per fleet session, the instant its type is
// known (team color at creation, or first user turn), to mint that number. The
// number is then STAMPED onto the session (agentType/agentNumber) and persisted,
// so the UI reads it off the session object with no counter race.
const CLAIM_PY = path.join(os.homedir(), '.151machine', 'fleet', 'claim.py');

// Fleet team-color → claim.py Type. The client PATCHes the team color right after
// createSession (setTeam), so this maps that color to the fleet Type and lets us
// mint the number at creation, before the first message is even sent.
// I tipi non sono scritti qui: sono i «super» del file delle squadre
// (server/squadre.js). Senza file nessuna sessione è numerata.
const squadre = require('./squadre');
function _fleetTeamType() { return squadre.tipiFleet(); }

// Fleet-hooks audit log (P4 2026-07-20): the two fire-and-forget spawns below
// (close-log + Raccoon autopsy) used to run stdio:'ignore', so a hook that failed
// to spawn or exited non-zero left NO trace — invisible debt. We now route each
// hook's stdout+stderr to this append-only log AND attach 'error'/'exit' listeners
// that record spawn failures and non-zero exits. Still fully best-effort: opening
// the fd, the spawn, and the listeners are all wrapped so teardown never throws.
const FLEET_HOOKS_LOG = path.join(os.homedir(), '.151machine', 'fleet', 'fleet-hooks.log');

// Fire a detached background hook (python3) whose success/failure is auditable.
// - stdout+stderr → FLEET_HOOKS_LOG (append) when the fd opens, else 'ignore'.
// - 'error'  → spawn itself failed (e.g. python3 missing): logged, never thrown.
// - 'exit'   → non-zero code / signal: logged. Zero exits stay silent.
// Detached + unref'd so it outlives teardown; the whole thing is caller-wrapped
// in try/catch too, so a logging failure can NEVER block or throw into teardown.
function _spawnHook(label, args) {
  let fd = 'ignore';
  try { fd = fs.openSync(FLEET_HOOKS_LOG, 'a'); } catch (_) { fd = 'ignore'; }
  const stamp = () => new Date().toISOString();
  const note = (msg) => {
    try { fs.appendFileSync(FLEET_HOOKS_LOG, `[${stamp()}] ${label}: ${msg}\n`); } catch (_) {}
  };
  const child = spawn('python3', args,
    { stdio: ['ignore', fd, fd], detached: true });
  child.on('error', (e) => note(`spawn error — ${e.message}`));
  child.on('exit', (code, signal) => {
    if (signal) note(`killed by signal ${signal}`);
    else if (code) note(`exited non-zero (${code})`);
  });
  child.unref();
  // The parent can close its copy of the fd; the child keeps its own.
  if (typeof fd === 'number') { try { fs.closeSync(fd); } catch (_) {} }
}

// Map a session's opening slash-command to its fleet TYPE (claim.py arg), or
// null if it isn't a fleet session. Real signal: scan history for the FIRST
// user message whose text starts with the skill command (same signal the UI's
// detectAgentSession uses). I comandi sono «/<chiave>» di ogni super del file
// delle squadre.
function _fleetCmdType() {
  return Object.entries(_fleetTeamType()).map(([k, tipo]) => ['/' + k, tipo]);
}
function detectFleetType(session) {
  const hist = (session && Array.isArray(session.history)) ? session.history : [];
  for (const e of hist) {
    if (e && e.role === 'user' && typeof e.content === 'string') {
      const t = e.content.trim();
      for (const pair of _fleetCmdType()) {
        if (t.indexOf(pair[0]) === 0) return pair[1];
      }
    }
  }
  return null;
}

// Phase 2 flag: route CLI spawns through the session-host daemon instead of
// forking them as children of this process. OFF by default — old path is
// unchanged. Flipping ON without the daemon running causes sendMessage() to
// throw (by design — we don't silently fall back to local spawn).
const USE_SESSION_HOST = process.env.USE_SESSION_HOST === '1';
// SESSION ENGINE REBUILD (step 2) flag: route message turns through the Claude
// Agent SDK engine (server/sdk-engine.js) instead of spawning the `claude -p`
// CLI. OFF by default — the legacy engine is fully intact and instantly
// restored by clearing this env var. Mirrors USE_SESSION_HOST.
const USE_SDK_ENGINE = process.env.USE_SDK_ENGINE === '1';
// Lazy-load the client so the module has zero side effect when the flag is off.
let sessionHostClient = null;
function getSessionHostClient() {
  if (!sessionHostClient) {
    sessionHostClient = require('./session-host-client').getClient();
  }
  return sessionHostClient;
}

// Resolve claude binary — Node spawn can't find it via bash PATH
const CLAUDE_BIN = path.join(process.env.HOME, '.local', 'bin', 'claude');

const MAX_HISTORY_PER_SESSION = 200;

// --- Atomic writes (durability, audit 2026-07 S1.1) --------------------------
// Direct fs.writeFile*(target) can leave a truncated/corrupt file if the
// process dies mid-write. Pattern copied from restart-intent.js: write to a
// .tmp sibling, then rename() — rename is atomic on the same filesystem, so
// the target is always either the old or the new complete content.
//
// [2026-08-21] PRIVATE TEMP PER WRITE. The temp name used to be the single fixed
// `<target>.tmp`, SHARED by every writer. Two overlapping saves (the debounced
// async save() and a saveSync() on shutdown/interrupt, or two async saves whose
// write→rename windows overlap) therefore aimed at the SAME temp file: writer A
// renamed it onto the target, and writer B's rename() then found nothing left to
// rename and died with ENOENT — the save was silently LOST. That is exactly the
// 114 × "[SESSION] Write error: ENOENT" recorded in the logs over 46 days.
// Giving each write its own temp (pid + monotonic counter + random) removes the
// shared name, so concurrent writers can never steal each other's file. The last
// rename() still wins atomically, which is the intended last-writer-wins.
let _tmpSeq = 0;
function tmpPathFor(targetPath) {
  _tmpSeq = (_tmpSeq + 1) % 1000000;
  return `${targetPath}.${process.pid}.${_tmpSeq}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}
function atomicWriteSync(targetPath, data) {
  const tmp = tmpPathFor(targetPath);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    // Don't leave an orphan temp behind; the error still propagates.
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}
function atomicWrite(targetPath, data, cb) {
  const tmp = tmpPathFor(targetPath);
  fs.writeFile(tmp, data, (err) => {
    if (err) { fs.unlink(tmp, () => {}); return cb(err); }
    fs.rename(tmp, targetPath, (rErr) => {
      if (rErr) fs.unlink(tmp, () => {});
      cb(rErr);
    });
  });
}

// --- Step 1 spending brake (SESSION ENGINE REBUILD ROADMAP) -----------------
// Pin a saner model and cap per-session token spend so one runaway chat can't
// drain the owner's whole plan. The cap LOGIC is engine-agnostic — it carries
// forward to the Agent-SDK engine in roadmap step 2 (the SDK turn's `usage`
// feeds the same addTokensUsed accumulator).
//   CLAUDE_MODEL      — LAST-RESORT model for spawned sessions, NOT an
//                       override: a session pin wins, then the interactive
//                       /model pick (~/.claude/settings.json "model", read at
//                       spawn time), then CLAUDE_MODEL, then the legacy
//                       'claude-opus-4-8' pin. A spawn
//                       also carries a fallback ladder (→ claude-opus-5 →
//                       claude-opus-4-8) retried automatically when the model
//                       on top is unavailable / usage-limited. All of this
//                       lives in ./model-fallback.js.
//   SESSION_TOKEN_CAP — hard ceiling on a session's lifetime token use; a
//                       backstop against pathological unbounded burn, set high
//                       enough never to bite a normal long chat. Env-tunable.
const { resolveModelChain, displayModelFor, ModelFallbackProc } = require('./model-fallback');
const SESSION_TOKEN_CAP = parseInt(process.env.SESSION_TOKEN_CAP, 10) || 10000000;

class SessionManager {
  constructor(storePath) {
    this.storePath = storePath || path.join(__dirname, 'sessions.json');
    // Rolling backup of the last good sessions.json — a parse-fail on the main
    // file must NOT silently wipe every chat; load() falls back to this.
    this.bakPath = this.storePath + '.bak';
    this.sessions = new Map();
    // Live stream state per session — not persisted, only exists while CLI is running
    this.streamBuffers = new Map(); // sessionId → { text, tools: [] }
    this._saveTimer = null;
    // [29/10/2026] Messaggi del proprietario scritti mentre il modello parla con aiutanti
    // in sottofondo vivi: aspettano qui che smetta di parlare (vedi
    // interjectionMustWait). Solo memoria: un riavvio uccide comunque gli aiutanti.
    this._waitingMessages = new Map(); // sessionId → [{ content, attachments, nonce }]
    this._deliverWaiting = null; // (sessionId, { content, attachments, nonce }) — ws-handler
    if (USE_SDK_ENGINE) {
      try { require('./sdk-engine').onTurnIdle((sid) => setImmediate(() => this.deliverWaiting(sid))); }
      catch (err) { console.warn('[SESSION] attesa dei messaggi non agganciata al motore:', err.message); }
    }
  }

  // [29/10/2026] Scrivere adesso interromperebbe il CLI e ucciderebbe gli aiutanti?
  // Prova: tests/scrivere-non-uccide-aiutanti.test.js.
  interjectionMustWait(id) {
    const session = this.sessions.get(id);
    if (!USE_SDK_ENGINE || !session || !session.process) return false;
    try { return require('./sdk-engine').interjectionMustWait(id) === true; } catch { return false; }
  }

  // Il messaggio resta da parte; il telefono l'ha già mostrato. Se era stato
  // impacchettato come interruzione (il telefono non ha saputo in tempo che
  // si aspetta), torna il testo del proprietario: niente è stato interrotto.
  queueWaitingMessage(id, { content, attachments, nonce } = {}) {
    let text = String(content || '');
    const m = text.match(/^\[INTERRUPTION:[^\]]*\]\n\n([\s\S]*?)\n\n\[Take note[^\]]*\]\s*$/);
    if (m) text = m[1];
    const list = this._waitingMessages.get(id) || [];
    list.push({ content: text, attachments: Array.isArray(attachments) ? attachments : [], nonce: nonce || null });
    this._waitingMessages.set(id, list);
    console.log(`[SESSION] ${id.slice(0, 8)}: messaggio dell'utente in attesa (il modello parla, aiutanti vivi) — ${list.length} in coda`);
  }

  hasWaitingMessages(id) {
    const l = this._waitingMessages.get(id);
    return !!(l && l.length);
  }

  setWaitingDeliverer(fn) { this._deliverWaiting = typeof fn === 'function' ? fn : null; }

  // Il modello ha smesso di parlare (turno chiuso, o in attesa degli aiutanti):
  // i messaggi in coda partono insieme, come un messaggio solo.
  deliverWaiting(id) {
    const list = this._waitingMessages.get(id);
    if (!list || !list.length || !this._deliverWaiting) return false;
    const session = this.sessions.get(id);
    if (!session) { this._waitingMessages.delete(id); return false; }
    if (session.process) {
      let idleHold = false;
      if (USE_SDK_ENGINE) { try { idleHold = require('./sdk-engine').isIdleHold(id); } catch {} }
      if (!idleHold) return false; // parla ancora: si riprova al prossimo segnale
    }
    this._waitingMessages.delete(id);
    const merged = {
      content: list.map((x) => x.content).join('\n\n'),
      attachments: [].concat(...list.map((x) => x.attachments)),
      nonce: list[0].nonce,
    };
    console.log(`[SESSION] ${id.slice(0, 8)}: il modello ha smesso di parlare — parte il messaggio in attesa (${list.length})`);
    try { this._deliverWaiting(id, merged); }
    catch (err) { console.error(`[SESSION] ${id.slice(0, 8)}: messaggio in attesa non partito:`, err.message); return false; }
    return true;
  }

  create({ title, workingDirectory, permissionMode } = {}) {
    const id = randomUUID();
    // PIN ALLA NASCITA: the session FIXES its model here, at
    // creation — the terminal /model pick is only the default for NEW sessions.
    // Changing /model later never retargets this session; only the topbar chip
    // picker (setModel) can. resolveModelChain() with no pin = current default.
    const bornModel = resolveModelChain()[0];
    const session = {
      id,
      title: title || 'Untitled',
      status: 'idle',
      created: new Date(),
      lastActivity: new Date(),
      lastMessage: '',
      workingDirectory: workingDirectory || process.cwd(),
      history: [],
      process: null,
      claudeSessionId: null, // CLI's own session ID — captured from first response
      permissionMode: permissionMode || 'plan',
      // The pin (source of truth for every spawn's primary model) + the display
      // model (what's ACTUALLY running — the fallback ladder may re-stamp
      // `model` mid-turn while the pin stays put, so the next turn re-tries the
      // pinned model first: ladder semantics unchanged).
      pinnedModel: bornModel,
      model: bornModel,
      team: null,
      contextTokens: 0,
      tokensUsed: 0,
      manuallyRenamed: false,
      autoTitled: false,
      // Hidden/ephemeral flag: Father's relay-created child sessions set this so
      // they never show in the sidebar "Other" list. In-memory
      // for the session's life — not persisted; a restart wipes the children too.
      hidden: false,
      // Fleet numbering (FLIP 2026-07-20): stamped once when the type is known
      // (setTeam at creation, or the first user turn). null on every non-fleet
      // session — backward-safe, they render exactly as before.
      agentType: null,
      agentNumber: null,
      _fleetStamped: false, // one-claim-per-lifetime latch (Fix 1)
      // Fix B: the user-editable label that renders AFTER the LOCKED "TYPE N"
      // prefix. null until the user renames a fleet session. The number lives in
      // agentNumber and is NEVER stored in this field, so an edit can't wipe it.
      agentLabel: null,
    };
    this.sessions.set(id, session);
    this.save();
    logEvent('session_open', { session: id, title: session.title });
    return this._serialize(session);
  }

  // Fleet numbering (FLIP 2026-07-21, Fix 1 — RIBALTA il coniatore): the SERVER is
  // now the single coiner. At a fleet session's first real use we SPAWN
  // `claim.py <Type>` (NO --peek), which takes the roster flock, INCREMENTS that
  // type's counter, records a roster entry, and prints "<Type> N". That N is
  // stamped on the card HERE — the server acts first, so it mints first. The agents'
  // bootstrap claim.py no longer increments; it --peeks the number the server has
  // already minted onto their card. Result: card N (server mint) == the number the
  // agent then speaks (agent peek) — the off-by-one (agent−1) is gone.
  // Best-effort: any failure returns null so it can NEVER break the
  // create/setTeam/sendMessage paths.
  _claimFleetNumber(type) {
    try {
      const out = require('child_process').execFileSync(
        'python3', [CLAIM_PY, type],
        { encoding: 'utf8', timeout: 8000 });
      const m = String(out).trim().match(/(\d+)\s*$/);
      return m ? parseInt(m[1], 10) : null;
    } catch (e) {
      console.error('[FLEET] claim (mint) failed for', type, '-', e.message);
      return null;
    }
  }

  // Stamp a fleet session's agentType + monotonic agentNumber ONCE, the instant
  // its type becomes known. Idempotent — a session that already carries a type is
  // never re-stamped (one ticket per session). Non-fleet sessions never call this.
  _stampFleet(session, type) {
    if (!session || !type) return;
    // ONE claim per session LIFETIME, ever. `_fleetStamped` is a persisted latch
    // (survives reload/restart), so a restart can NEVER trigger a second claim.py
    // increment for the same session — even if agentType somehow comes back null
    // after a reload. The old guard relied on agentType alone; if that field was
    // ever cleared, the next turn re-claimed and bumped the counter (43→44
    // bug). The latch closes that hole: minted exactly once. Checked FIRST so an
    // already-stamped session returns before the one-alive guard (it is itself the
    // live one and must never be blocked).
    if (session._fleetStamped) return;
    // Item 1 (2026-07-21): one-alive-per-type is now a HARD invariant for the
    // special singletons (every «super» of the team file). If a live, already-
    // stamped session of this same type exists, REJECT this duplicate spawn by
    // THROWING here — BEFORE we peek/claim a number or set the latch, so a blocked
    // duplicate consumes NO fleet number (no peek, no mint, no title). The throw
    // propagates out of sendMessage as a clean error the user sees.
    this._enforceOneAlivePerType(session, type);
    // Record the fleet TYPE (setTeam may have pre-set it for pinning, without a
    // number — see Fix I). Keep whatever's already there.
    session.agentType = session.agentType || type;
    // Fix I / FLIP 2026-07-21: the number is MINTED HERE via claim.py <Type> — at
    // first real use (the first user message), NOT at spawn/setTeam. The server is
    // the single coiner now: it increments the counter and stamps the fresh N on the
    // card. Mint ONLY if we don't already carry a number: a pre-latch seal
    // (abccaa15: agentNumber 45 already) or a restored session keeps its existing
    // number and is NEVER re-minted — so a restart can never bump the counter twice
    // (guarded here + by the _fleetStamped latch above). A fresh first-use session
    // mints once and latches.
    if (typeof session.agentNumber !== 'number') {
      const n = this._claimFleetNumber(session.agentType);
      session.agentNumber = (typeof n === 'number') ? n : null;
    }
    session._fleetStamped = true;
    // Fix B: the stamped ticket IS the session title ("WRITER 45"). The LOCKED
    // number can never be dropped by an edit; a user rename only sets agentLabel
    // (the suffix). We sync title even when manuallyRenamed is set (setTeam flips
    // it as an auto-title guard), so the card name == the editable title.
    if (!session.agentLabel) {
      session.title = this._fleetTitle(session.agentType, session.agentNumber, null);
    }
    this.save();
    // Fix 2 (2026-07-21): PUSH the freshly-stamped identity to all clients NOW, so
    // the fleet card shows its number/color immediately — no page reload needed.
    // Before, the card stayed blank until a full reload re-fetched /sessions. The
    // server wires `onFleetStamp` (index.js) to a WS broadcast carrying the stamped
    // agentType/agentNumber/title. Best-effort: a missing hook or a broadcast
    // failure can NEVER break the stamp / first-turn path.
    try {
      if (typeof this.onFleetStamp === 'function') {
        this.onFleetStamp({
          sessionId: session.id,
          agentType: session.agentType,
          agentNumber: session.agentNumber,
          title: session.title,
        });
      }
    } catch (_) { /* never throw into the first-turn path */ }
  }

  // Fleet invariant ENFORCE — HARD BLOCK for the special singletons (Item 1,
  // 2026-07-21, was DETECT-AND-LOG). The intended shape is at most ONE live
  // session per special agentType (one per «super» of the team file).
  // Called from _stampFleet BEFORE any number is peeked/claimed. If a
  // live, already-stamped peer of the same special type exists, we LOG the block
  // AND THROW — the duplicate spawn fails with a clear error and consumes no
  // fleet number. Non-special types (or a first-of-its-kind) pass through silently.
  _enforceOneAlivePerType(session, type) {
    const SPECIAL = new Set(Object.values(_fleetTeamType()).map((x) => String(x).toLowerCase()));
    const t = String(type || (session && session.agentType) || '').toLowerCase();
    if (!SPECIAL.has(t)) return; // only the special singletons are gated
    for (const s of this.sessions.values()) {
      if (!s || s.id === (session && session.id)) continue;
      if (!s._fleetStamped) continue;           // only a fully-claimed peer is "alive"
      if (String(s.agentType || '').toLowerCase() !== t) continue;
      const msg = `one-alive-per-type BLOCK: a live "${type}" already exists (${s.id}) — duplicate spawn of ${session.id} REJECTED, no fleet number consumed`;
      try { fs.appendFileSync(FLEET_HOOKS_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
      console.warn('[FLEET]', msg);
      const err = new Error(`A ${type} agent is already alive. Only one ${type} may run at a time — close the existing one first.`);
      err.code = 'FLEET_DUPLICATE';
      throw err;
    }
  }

  // Fix B: compose a fleet session's canonical title from the LOCKED "TYPE N"
  // prefix plus an optional user label. Single source of truth for the string so
  // the server and client render it identically.
  _fleetTitle(type, number, label) {
    const prefix = `${String(type).toUpperCase()}${(typeof number === 'number') ? ' ' + number : ''}`;
    const lab = (label == null) ? '' : String(label).trim();
    return lab ? `${prefix} ${lab}` : prefix;
  }

  // Fix B: strip a LOCKED "TYPE N" prefix (any casing) off an incoming title so
  // only the user's editable label survives — the number can never be edited away.
  _fleetStripPrefix(session, title) {
    let t = String(title || '').trim();
    if (!session || !session.agentType || typeof session.agentNumber !== 'number') return t;
    const re = new RegExp('^' + session.agentType + '\\s*' + session.agentNumber + '\\s*', 'i');
    return t.replace(re, '').trim();
  }

  get(id) {
    const session = this.sessions.get(id);
    return session ? this._serialize(session) : undefined;
  }

  list() {
    return Array.from(this.sessions.values())
      .sort((a, b) => (b.lastActivity || b.created) - (a.lastActivity || a.created))
      .map(s => this._serialize(s));
  }

  rename(id, title) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    // Fix B: on a FLEET session the "TYPE N" number is a LOCKED prefix. Whatever
    // the client sends, we strip any leading prefix and keep ONLY the remainder
    // as the editable label — the number in agentNumber is never touched, so an
    // edit (even setting the name to the plain type) can NEVER wipe it. The
    // stored title stays the canonical "TYPE N [label]" so card == title.
    if (session.agentType && typeof session.agentNumber === 'number') {
      const label = this._fleetStripPrefix(session, title);
      session.agentLabel = label || null;
      session.title = this._fleetTitle(session.agentType, session.agentNumber, session.agentLabel);
    } else {
      session.title = title;
    }
    session.manuallyRenamed = true;
    this.save();
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (session.process) {
      session.process.kill('SIGTERM');
      session.process = null;
    }
    // Tear down the warm SDK session (if any) so a closed chat leaves no
    // live process behind.
    if (USE_SDK_ENGINE) {
      try { require('./sdk-engine').evictWarmSession(id); }
      catch (e) { console.error('[SESSION] sdk evict failed:', e.message); }
    }
    this.sessions.delete(id);
    const uploadDir = path.join(__dirname, 'uploads', id);
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
    this.save();
  }

  closeAll() {
    for (const id of this.sessions.keys()) {
      try { this.close(id); } catch {}
    }
  }

  // User-initiated delete: snapshot to trash, THEN close. Distinct from close()
  // on purpose — close() is also used by closeAll()/shutdown and relay-cleanup,
  // which must NOT fill the trash. Only this method (wired to DELETE /api/sessions)
  // archives a copy first.
  trashAndClose(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    const messages = Array.isArray(session.history) ? session.history.length : 0;
    // Void: sessions with ≤1 message are pure noise (created, at most one turn —
    // e.g. a blocked-duplicate spawn that pushed one prompt then threw, or a
    // mis-opened card). VOID them (Item 2, 2026-07-21, was ==0): skip the trash
    // entirely (nothing worth recovering) and emit NO session_delete event, so
    // they never pollute Observatory stats or satisfaction. Straight to the void
    // via the plain close() path.
    if (messages <= 1) {
      // Item 2: a voided session must not hold onto a fleet number. The counter
      // is monotonic-never-reused (claim.py), so we RELEASE (audit ledger only,
      // counter untouched) rather than decrement — the server never mints on this
      // path (it only --peek's), so voiding here consumes no number by design. The
      // release call records the retirement for stamped fleet sessions; best-effort.
      if (session._fleetStamped && session.agentType) {
        try {
          _spawnHook('fleet-release', [CLAIM_PY, '--release', session.agentType]);
        } catch (_) { /* number-release ledger is best-effort */ }
      }
      this.close(id);
      return;
    }
    try { this._writeTrash(session); }
    catch (e) { console.error('[TRASH] snapshot failed for', id, '-', e.message); }
    // : the trash keeps the COMPLETE transcript too (every step, command and
    // result), beyond Claude Code's 30 days — copied now, in a separate process.
    if (session.claudeSessionId) {
      try { require('./trascritti').archiviaInSottofondo(session.claudeSessionId); }
      catch (e) { console.error('[TRASH] full transcript copy not started for', id, '-', e.message); }
    }
    logEvent('session_delete', {
      session: id,
      team: session.team || null,
      messages,
      tokens_lifetime: session.tokensUsed || 0,
    });
    // Fleet action log — record the close for the office model. Fire-and-forget,
    // detached + unref'd, stdio ignored: a logging failure must NEVER block or
    // throw into teardown. Mirrors the best-effort discipline in the py callers.
    try {
      _spawnHook('close-log', [FLEET_LOG_PY, 'append', session.team || 'session',
        'close', session.title || '(untitled)', id]);
    } catch (_) { /* logging is best-effort */ }
    // Fleet numbering (FLIP 2026-07-20): deletion NO LONGER touches any counter.
    // Numbers are monotonic tickets minted at spawn (see _stampFleet); a deleted
    // session simply retires its number, which is never reused. The old
    // `claim.py --release` delete-bump has been removed.
    //
    this.close(id);
  }

  _renderTranscript(s) {
    const fmt = (d) => { try { return new Date(d).toLocaleString(); } catch { return String(d); } };
    const L = [];
    L.push(`Title:    ${s.title || 'Untitled'}`);
    L.push(`Created:  ${fmt(s.created)}`);
    L.push(`Deleted:  ${fmt(s.deletedAt || Date.now())}`);
    L.push(`Session:  ${s.id}`);
    if (s.team) L.push(`Team:     ${s.team}`);
    L.push('='.repeat(64));
    const hist = Array.isArray(s.history) ? s.history : [];
    for (const h of hist) {
      const who = h.role === 'user' ? 'USER' : (h.role === 'assistant' ? 'CLAUDE' : (h.role || '?').toUpperCase());
      L.push('');
      L.push(`[${who}]`);
      if (h.thinking) L.push(`(thinking) ${h.thinking}`);
      L.push(typeof h.content === 'string' ? h.content : JSON.stringify(h.content));
      if (Array.isArray(h.tools) && h.tools.length) {
        const tnames = h.tools.map(t => (typeof t === 'string' ? t : (t && (t.name || t.tool)) || JSON.stringify(t)));
        L.push(`(tools used: ${tnames.join(', ')})`);
      }
      if (Array.isArray(h.attachments) && h.attachments.length) {
        const names = h.attachments.map(a => (a && (a.name || a.filename)) || a).join(', ');
        L.push(`(attachments: ${names})`);
      }
    }
    L.push('');
    return L.join('\n');
  }

  _writeTrash(session) {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const deletedAt = new Date().toISOString();
    // Full snapshot via the same serializer used for sessions.json, so a
    // restore is byte-faithful (history, claudeSessionId for SDK resume, team…).
    const snap = {
      id: session.id,
      title: session.title,
      created: (session.created instanceof Date ? session.created : new Date(session.created)).toISOString(),
      lastActivity: session.lastActivity ? (session.lastActivity instanceof Date ? session.lastActivity : new Date(session.lastActivity)).toISOString() : null,
      lastMessage: session.lastMessage,
      workingDirectory: session.workingDirectory,
      history: session.history || [],
      claudeSessionId: session.claudeSessionId || null,
      permissionMode: session.permissionMode || 'plan',
      team: session.team || null,
      contextTokens: session.contextTokens || 0,
      tokensUsed: session.tokensUsed || 0,
      manuallyRenamed: !!session.manuallyRenamed,
      autoTitled: !!session.autoTitled,
      // The model was NOT snapshotted before 2026-08-20, so every pre-existing
      // trash entry shows it as lost — irrecoverable, the history messages never
      // carried it. From here on a deleted session keeps its model, both for the
      // trash list and for a faithful restore.
      model: session.model || null,
      pinnedModel: session.pinnedModel || null,
      // Fleet numbering (FLIP 2026-07-20): preserve the stamped ticket so a
      // restore keeps the same number (never re-minted, never reused).
      agentType: session.agentType || null,
      agentNumber: (typeof session.agentNumber === 'number') ? session.agentNumber : null,
      agentLabel: session.agentLabel || null,
      _fleetStamped: !!session._fleetStamped,
      deletedAt,
    };
    atomicWriteSync(path.join(TRASH_DIR, `${session.id}.json`), JSON.stringify(snap, null, 2));
    atomicWriteSync(path.join(TRASH_DIR, `${session.id}.txt`), this._renderTranscript(snap));
  }

  listTrash() {
    if (!fs.existsSync(TRASH_DIR)) return [];
    const out = [];
    for (const f of fs.readdirSync(TRASH_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, f), 'utf-8'));
        out.push({
          id: snap.id,
          title: snap.title || 'Untitled',
          team: snap.team || null,
          deletedAt: snap.deletedAt,
          created: snap.created,
          messageCount: Array.isArray(snap.history) ? snap.history.length : 0,
          preview: snap.lastMessage || '',
          // null for entries deleted before the model was snapshotted — the
          // client renders those as "modello ignoto" rather than hiding them.
          model: snap.model || null,
        });
      } catch (e) { console.error('[TRASH] unreadable entry', f, '-', e.message); }
    }
    out.sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));
    return out;
  }

  getTrashTranscript(id) {
    const txt = path.join(TRASH_DIR, `${id}.txt`);
    if (!fs.existsSync(txt)) return null;
    return fs.readFileSync(txt, 'utf-8');
  }

  restoreTrash(id) {
    const jsonPath = path.join(TRASH_DIR, `${id}.json`);
    if (!fs.existsSync(jsonPath)) throw new Error(`Trash entry ${id} not found`);
    if (this.sessions.has(id)) throw new Error(`Session ${id} is already live`);
    const snap = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    let hist = Array.isArray(snap.history) ? snap.history : [];
    if (hist.length > MAX_HISTORY_PER_SESSION) hist = hist.slice(-MAX_HISTORY_PER_SESSION);
    this.sessions.set(id, {
      id,
      title: snap.title || 'Restored session',
      status: 'idle',
      created: new Date(snap.created || Date.now()),
      lastActivity: snap.lastActivity ? new Date(snap.lastActivity) : new Date(),
      lastMessage: snap.lastMessage || '',
      workingDirectory: snap.workingDirectory || process.env.HOME || process.cwd(),
      history: hist,
      process: null,
      claudeSessionId: snap.claudeSessionId || null,
      permissionMode: snap.permissionMode || 'plan',
      team: snap.team || null,
      contextTokens: snap.contextTokens || 0,
      tokensUsed: snap.tokensUsed || 0,
      manuallyRenamed: !!snap.manuallyRenamed,
      autoTitled: !!snap.autoTitled,
      // Restore the model the session actually ran on. Undefined (not null) for
      // pre-2026-08-20 entries so the normal resolve-chain default still applies.
      model: snap.model || undefined,
      pinnedModel: snap.pinnedModel || undefined,
      // Fleet numbering (FLIP 2026-07-20): restore the stamped ticket verbatim.
      agentType: snap.agentType || null,
      agentNumber: (typeof snap.agentNumber === 'number') ? snap.agentNumber : null,
      // Fix B: restore the editable label. Fix A: a restored fleet session that
      // already carries a number is sealed so the restore can never re-claim.
      agentLabel: snap.agentLabel || null,
      _fleetStamped: !!snap._fleetStamped || (!!snap.agentType && typeof snap.agentNumber === 'number'),
      _resumeAttempts: 0,
    });
    this.save();
    // Out of trash now that it's live again.
    try { this.purgeTrash(id); } catch {}
    logEvent('session_restore', {
      session: id,
      team: snap.team || null,
      messages: Array.isArray(hist) ? hist.length : 0,
    });
    return this._serialize(this.sessions.get(id));
  }

  purgeTrash(id) {
    let removed = false;
    for (const ext of ['.json', '.txt']) {
      const p = path.join(TRASH_DIR, `${id}${ext}`);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed = true; }
    }
    return removed;
  }

  // Kill all running processes without deleting sessions (for graceful shutdown)
  // Does NOT flush stream buffers to history — the client already has partial
  // text from deltas. Flushing would cause duplicates on reconnect because the
  // client's historyLength wouldn't account for the new entry.
  killAllProcesses() {
    for (const session of this.sessions.values()) {
      if (session.process) {
        this.clearStream(session.id);
        try { session.process.kill('SIGTERM'); } catch {}
        session.process = null;
        session.status = 'idle';
      }
    }
    if (USE_SDK_ENGINE) {
      try { require('./sdk-engine').shutdownAllWarm(); }
      catch (e) { console.error('[SESSION] sdk shutdown failed:', e.message); }
    }
  }

  // Async version: kills all processes and waits for them to exit (or timeout)
  // Returns a Promise that resolves when all children are confirmed dead
  killAllProcessesAsync(timeoutMs = 4000) {
    const promises = [];
    for (const session of this.sessions.values()) {
      if (session.process) {
        this.clearStream(session.id);
        const proc = session.process;
        const pid = proc.pid;
        session.process = null;
        session.status = 'idle';
        promises.push(new Promise((resolve) => {
          let resolved = false;
          const done = () => { if (!resolved) { resolved = true; resolve(); } };
          const timer = setTimeout(() => {
            try { process.kill(pid, 'SIGKILL'); } catch {}
            setTimeout(done, 500);
          }, timeoutMs - 500);
          proc.on('exit', () => { clearTimeout(timer); done(); });
          proc.on('error', () => { clearTimeout(timer); done(); });
          try { proc.kill('SIGTERM'); } catch { done(); }
        }));
      }
    }
    // Also tear down warm SDK sessions so the graceful shutdown leaves no
    // orphaned CLI children.
    if (USE_SDK_ENGINE) {
      try { promises.push(require('./sdk-engine').shutdownAllWarm()); }
      catch (e) { console.error('[SESSION] sdk shutdown failed:', e.message); }
    }
    return promises.length ? Promise.all(promises) : Promise.resolve();
  }

  // Il testo che il modello riceve per un messaggio del proprietario: allegati in testa, «!comandi» prima di tutto.
  // Uno solo per sendMessage e foldUserMessage.
  _promptFor(session, text, attachments = []) {
    let prompt = text;
    if (attachments.length > 0) {
      // Accept legacy shape (string path) and new shape ({path,name,mime,size}).
      // Always emit `[Attached file: <abs path>]` so Claude Code's Read tool
      // can pick it up unambiguously. For images we'd ideally inject a base64
      // image content block, but the Claude CLI `-p` flag only takes a text
      // string — there is no stdin path for structured content blocks today.
      // TODO(image-blocks): when the CLI supports structured input on stdin,
      // attach `{type:"image",source:{type:"base64",media_type,data}}` blocks
      // for mime.startsWith('image/') instead of relying on Read.
      const fileRefs = attachments.map(a => {
        const meta = (typeof a === 'string') ? { path: a, name: a.split(/[\\/]/).pop(), mime: '' } : a;
        const absPath = meta.path;
        const mime = (meta.mime || '').toLowerCase();
        const name = meta.name || absPath.split(/[\\/]/).pop();
        let line = `- ${name} (${mime || 'unknown'}): ${absPath}`;
        // For audio/video, inline the auto-transcript so Claude sees speech content.
        if (mime.startsWith('audio/') || mime.startsWith('video/')) {
          const cached = transcribe.readCachedTranscript(absPath);
          if (cached) {
            line += `\n  Transcript: """${cached}"""`;
          } else {
            line += `\n  Transcript: not available yet (whisper still processing)`;
          }
        }
        return line;
      }).join('\n');
      const header = `[The user attached the following file(s). You MUST invoke the Read tool on each absolute path below before answering — the user expects you to have actually read the contents:\n${fileRefs}\n]`;
      prompt = `${header}\n\n${text}`;
    }
    // «!comando» lanciati dal proprietario nella chat dopo l'ultimo messaggio: Claude
    // li vede ora, in testa (server/comando-chat.js).
    const comandiDiNico = require('./comando-chat').prendiPerClaude(session);
    if (comandiDiNico) prompt = `${comandiDiNico}\n\n${prompt}`;
    return prompt;
  }

  // [11/11/2026 ] il proprietario scrive mentre il modello parla con aiutanti vivi. Prima il messaggio aspettava
  // in memoria la FINE del turno (misurato l'11/11: 98 minuti, poi fuso col successivo; perso a ogni riavvio,
  // 10/11). Ora: subito nella cronologia (voce sua, col suo nonce, salvata) e subito nell'input del CLI con
  // priority 'next': entra nel turno in corso alla prossima pausa fra due strumenti, senza interrompere
  // (prova /tmp/prova-next 11/11: spinto a 8 s, piegato a 25 s nello stesso turno, aiutante vivo; il result
  // porta l'uuid del turno E quello piegato, resultIsForeign non lo scarta). Falso = non piegato: si usa la coda.
  foldUserMessage(id, { content, attachments, nonce } = {}) {
    const session = this.sessions.get(id);
    if (!session || !USE_SDK_ENGINE) return false;
    let text = String(content || '');
    const m = text.match(/^\[INTERRUPTION:[^\]]*\]\n\n([\s\S]*?)\n\n\[Take note[^\]]*\]\s*$/);
    if (m) text = m[1];
    const att = Array.isArray(attachments) ? attachments : [];
    const prompt = this._promptFor(session, text, att);
    let ok = false;
    try { ok = require('./sdk-engine').foldIntoTurn(id, prompt) === true; } catch { ok = false; }
    if (!ok) return false;
    const entry = { role: 'user', content: text, attachments: att, timestamp: Date.now() };
    if (nonce) entry.nonce = nonce;
    session.history.push(entry);
    session.lastActivity = new Date();
    this.saveSync();
    console.log(`[SESSION] ${id.slice(0, 8)}: messaggio dell'utente piegato nel turno in corso (next), niente attesa`);
    return true;
  }

  sendMessage(id, text, attachments = [], opts = {}) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (session.process) throw new Error(`Session ${id} is busy`);

    // Step 1 spending brake: hard-stop a session that has burned an absurd
    // amount of tokens over its life, so one runaway chat can't keep draining
    // the plan. Checked before any state mutation — a clean throw like the
    // 'is busy' guard above; the existing sendMessage error path surfaces it.
    if ((session.tokensUsed || 0) >= SESSION_TOKEN_CAP) {
      console.warn(`[BRAKE] Session ${id.slice(0, 8)} hit token cap (${session.tokensUsed} >= ${SESSION_TOKEN_CAP})`);
      throw new Error('This chat has reached its usage limit. Please start a new chat.');
    }

    if (/^\s*\/wrap\b/.test(String(text || ''))) { session.wrappedAt = Date.now(); } // : il proprietario chiude a mano

    // [29/10/2026] il proprietario scrive: il conto degli aiutanti fermati riparte da zero.
    if (USE_SDK_ENGINE) { try { require('./sdk-engine').clearStopped(id); } catch {} }
    session.status = 'busy';
    session.lastActivity = new Date();
    // Observatory: stamp turn start so finishMessage can compute latency + the
    // per-turn token delta. In-memory only (not persisted) — a turn that spans
    // a restart simply won't emit a timing event, which is correct.
    session._turnStart = Date.now();
    session._turnStartTokens = session.tokensUsed || 0;
    // opts.skipUserAppend: used by (1) the M9 vector-1 restart-resume path in
    // index.js, where the interrupted user message is ALREADY in history (kept,
    // sitting above the marked-interrupted partial). Skipping the push avoids a
    // duplicate user bubble so the continuation streams cleanly below the partial;
    // (2) the «!comando» auto-reply:
    // Claude answers by himself after the owner's command, with no «You» bubble.
    // Default (no opts) is byte-identical to before — every normal send appends.
    if (!opts.skipUserAppend) {
      const userEntry = { role: 'user', content: text, attachments, timestamp: Date.now() };
      // [NONCE-PERSIST 2026-08-15] Stamp the client's send-nonce on the durable
      // history entry (serialized verbatim by _serializeAll → sessions.json, and
      // saveSync below runs immediately). This is the truth anchor that lets
      // index.js reseed globalProcessedNonces at boot, so a client redelivery
      // with the ORIGINAL nonce after a server restart is skipped instead of
      // re-executed. Bonus: the client's `history` handler already seeds its
      // _renderedNonces from history-entry nonces (public/js/ws.js) — until now
      // the field never arrived. Absent nonce (relay children, older clients) ⇒
      // entry shape byte-identical to before.
      if (opts.nonce) userEntry.nonce = opts.nonce;
      session.history.push(userEntry);
    }
    // Fleet numbering (Fix I): claim the monotonic number at FIRST REAL USE — this
    // first user message — NOT at spawn. Trigger off the _fleetStamped latch (not
    // agentType), so it fires for BOTH: a team-launched session whose type setTeam
    // pre-recorded (agentType set, still unstamped, no number yet), AND a blank
    // session where someone typed a super agent's command (type detected from history here). The
    // latch guarantees it mints exactly once; non-fleet sessions cost only the
    // cheap history scan in detectFleetType.
    if (!session._fleetStamped) {
      const ft = session.agentType || detectFleetType(session);
      if (ft) this._stampFleet(session, ft);
    }
    // Save immediately so user message survives server restart
    this.saveSync();

    let prompt = this._promptFor(session, text, attachments);

    // NOTE (2026-08-15 phone long-message regression fix): the prompt is now
    // delivered to the engine via STDIN (see below, ~line 840) or the Agent SDK
    // appendPrompt — NEITHER has the ~32 KB CreateProcess/argv (`ENAMETOOLONG`)
    // limit that the old `-p <prompt>` argv delivery had. The former
    // spool-to-file guard (PROMPT_INLINE_LIMIT = 25000) belonged to that argv
    // era and, now that argv is gone, actively BROKE every message > 25 KB: it
    // silently REPLACED the user's real text with a stub telling the model to
    // Read a temp file, so from the phone a long message "did nothing" (the
    // model never saw the words, and on the SDK/relay engines the temp file
    // often wasn't even readable from the CLI host). Removed entirely — the full
    // message is delivered as-is. Stdin comfortably handles multi-MB payloads,
    // and the WS/express layers already cap ingress at 100 MB (index.js), so
    // there is no unbounded-input foot-gun to reintroduce here.

    if (process.env.DEBUG_PROMPT) console.log('[attach-srv] sendMessage final prompt (' + Buffer.byteLength(prompt, 'utf8') + 'B):\n' + prompt);

    // Claude CLI 2.1.x removed --permission-prompt-tool, so the MCP-based
    // permission broker no longer works. Use 'auto' mode — settings.json
    // deny rules still protect against catastrophic commands.
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    // Part-of-day label ONLY (no clock time) on purpose: this string goes into
    // the cached --append-system-prompt, so a precise stamp would change the
    // cached prefix and force a prompt-cache miss. A 4-bucket label changes at
    // most 4×/day, so an active session keeps the same cached prefix across a
    // whole morning/afternoon (the cache discount holds). Buckets for the owner:
    // night 00–06, morning 06–12, afternoon 12–18, evening 18–24.
    const _h = now.getHours();
    const timeStr = _h < 6 ? 'night' : _h < 12 ? 'morning' : _h < 18 ? 'afternoon' : 'evening';

    // Auto-memory (flag-gated by MEMORY_AUTO; lazy-required so OFF loads nothing,
    // wrapped so it can never throw into the spawn path). See server/memory-engine.js.
    let memPreface = '';
    if (process.env.MEMORY_AUTO) {
      try { memPreface = require('./memory-engine').getMemoryPreface(); } catch { memPreface = ''; }
    }

    // Self-writing skills (flag-gated by SKILLS_AUTO; lazy-required so OFF loads
    // nothing, wrapped so it can never throw into the spawn path). Injects an
    // INDEX of draft recipe names+descriptions only (progressive disclosure).
    // See server/skill-writer.js.
    let skillPreface = '';
    if (process.env.SKILLS_AUTO) {
      try { skillPreface = require('./skill-writer').getSkillIndexPreface(); } catch { skillPreface = ''; }
    }

    // RESTART_MEMORY: if this session was just resumed after a server restart,
    // inject a one-shot note telling the model what it had already done before
    // the restart (sourced from the restart banner + this session's action
    // journal). Reaches BOTH engines: _spawnClaude's SDK branch reads the note
    // back out of --append-system-prompt. One-shot: cleared after first use so
    // normal follow-up turns don't see it.
    let restartPreface = '';
    if (process.env.RESTART_MEMORY && session._restartNote) {
      try {
        const rj = require('./restart-journal');
        restartPreface = rj.formatNote(session._restartNote, rj.readTail(id));
        if (restartPreface) {
          // TEMPORARY (verification) — prove the note actually lands in context.
          console.log(`[RESTART-MEMORY] Injected resume note for ${id.slice(0, 8)}:\n${restartPreface}`);
        }
      } catch { restartPreface = ''; }
      delete session._restartNote; // one-shot
    }

    // Clickable-options producer. The client (public/js/chat.js parseAndRenderOptions)
    // turns a literal <options><option>…</option></options> block into tappable A/B/C
    // buttons, but nothing was ever instructing the model to EMIT that markup — so the
    // buttons almost never appeared (the model wrote plain "1A / 1B" prose instead).
    // Constant string ⇒ stays in the cached prompt prefix (no cache miss). Reaches the
    // SDK engine too (the SDK branch re-reads --append-system-prompt at _spawnClaude).
    const optionsPreface = ' When you end a turn by asking the user to choose between a small set of mutually-exclusive options (an A/B/C style decision), then IN ADDITION to your normal prose, append at the very end of the message a machine-parseable block wrapped EXACTLY like this: <options><option>first choice</option><option>second choice</option></options>. Put each choice in its own <option> tag, keep each label short, and make the label the exact text you want sent back if the user picks it. Emit this block ONLY when you are genuinely offering a discrete pick — never otherwise.';

    // Model chain resolved PER SPAWN from the session's OWN pin (2026-08-16):
    // the session fixed its model at creation (or via the chip picker /
    // setModel) and NEVER follows a later terminal /model change — that only
    // sets the default for NEW sessions. Legacy sessions (created pre-pin) are
    // pinned here on their first spawn to the model they last ran with
    // (persisted `model`), else to the current default. args carry the resolved
    // primary; the full chain rides along so _spawnClaude can retry with the
    // next model if the first is unavailable.
    if (!session.pinnedModel) {
      session.pinnedModel = session.model || resolveModelChain()[0];
    }
    const modelChain = resolveModelChain(session.pinnedModel);
    // Stamp the model on the session for the UI card. Primary of THIS spawn,
    // but shown as a PRECISE version (round #5, 1a) — modelChain[0] may be a
    // bare family alias ('opus'), which the CLI resolves to its newest; keep
    // the card on a real name ('claude-opus-5') meanwhile. The spawn args below
    // still hand the CLI the bare alias so it picks the true newest, and the
    // init line re-stamps whatever actually runs. If the fallback ladder later
    // wins with a different model, onModelChange (wired in _spawnClaude)
    // re-stamps `model`; the PIN stays put so the next turn re-tries it first.
    session.model = displayModelFor(modelChain[0]);

    const args = [
      '-p',
      '--model', modelChain[0],
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'auto',
      '--append-system-prompt', `Current date: ${dateStr}. Time of day: ${timeStr}.${memPreface}${skillPreface}${restartPreface}${optionsPreface}`,
    ];

    // First message: no session flag — let CLI create a new session
    // Subsequent messages: resume the CLI's own session
    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }

    const proc = this._spawnClaude({
      sessionId: id,
      args,
      cwd: session.workingDirectory,
      env: { ...process.env },
      stdinMode: 'pipe',
      modelChain,
    });

    session.process = proc;

    // Deliver the prompt via stdin. Previously passed as `-p <prompt>` argv,
    // which hit ENAMETOOLONG on Windows (the old host) once prompt + args neared 32 KB.
    // stdin has no such limit. Writing + ending synchronously after spawn is
    // safe: the daemon / Node pipe buffers until the child opens its read end.
    try {
      if (proc.stdin && typeof proc.stdin.write === 'function') {
        proc.stdin.write(prompt, 'utf8');
        if (typeof proc.stdin.end === 'function') proc.stdin.end();
      } else {
        console.error('[attach-srv] proc.stdin unavailable — prompt not delivered');
      }
    } catch (err) {
      console.error('[attach-srv] failed to write prompt to stdin:', err && err.message);
    }

    return { process: proc, session: this.sessions.get(id) };
  }

  // Phase 2: single spawn site, branches on USE_SESSION_HOST.
  // Flag OFF → child_process.spawn (identical args to the pre-Phase-2 call).
  // Flag ON  → session-host daemon via IPC. Returns a RemoteProc that
  //            duck-types ChildProcess for spawnStreamHandler in index.js.
  _spawnClaude({ sessionId, args, cwd, env, stdinMode, modelChain }) {
    // Ordered model ladder for this spawn (primary → fallbacks). sendMessage
    // passes it in; resolve here too (from the session's pin) so any future
    // caller is covered.
    const chain = (modelChain && modelChain.length)
      ? modelChain
      : resolveModelChain((this.sessions.get(sessionId) || {}).pinnedModel);
    // Keep session.model honest when the ladder falls back: re-stamp with the
    // model the retry actually uses, so the UI card shows what's really running.
    const onModelChange = (model) => {
      const s = this.sessions.get(sessionId);
      if (s) s.model = model;
    };
    // SESSION ENGINE REBUILD (step 2): the Agent-SDK engine. Behind
    // USE_SDK_ENGINE — when off, this branch is skipped and sdk-engine.js is
    // never even require()d, so the legacy path is provably unaffected.
    // startTurn() returns a per-turn ChildProcess-shaped handle backed by a
    // warm, persistent SDK session (sdk-engine.js owns its lifecycle).
    // Wrapped in ModelFallbackProc: on a model-unavailable startup failure the
    // dead warm session is deregistered by its own teardown, so the retry's
    // startTurn() transparently creates a fresh warm session on the next model.
    if (USE_SDK_ENGINE) {
      const sdkEngine = require('./sdk-engine');
      const session = this.sessions.get(sessionId);
      const aspIdx = args.indexOf('--append-system-prompt');
      const turnOpts = {
        sessionId,
        cwd,
        resume: (session && session.claudeSessionId) || null,
        appendSystemPrompt: aspIdx >= 0 ? args[aspIdx + 1] : null,
      };
      return new ModelFallbackProc({
        models: chain,
        onModelChange,
        spawnAttempt: (model) => sdkEngine.startTurn({ ...turnOpts, model }),
      });
    }
    if (USE_SESSION_HOST) {
      const client = getSessionHostClient();
      // client.spawn is async; we need a sync ChildProcess-shape return.
      // Create the RemoteProc eagerly, kick off spawn, surface failures via
      // 'error' event so spawnStreamHandler's proc.on('error', ...) catches
      // unreachable-daemon cases — no silent local fallback.
      const { RemoteProc } = require('./session-host-client');
      const proc = new RemoteProc(client, sessionId, stdinMode || 'ignore');
      // Register in client's proc map up front so daemon-initiated events
      // (stdout/stderr/exit) find their target.
      client.procs.set(sessionId, proc);
      client.spawn({ sessionId, args, cwd, env, stdinMode: stdinMode || 'ignore' })
        .then((spawned) => {
          // spawn() returns the same RemoteProc it registered; reuse our
          // handle's pid from the ack.
          proc.pid = spawned.pid;
        })
        .catch((err) => {
          // Emit on next tick so the caller has time to attach listeners.
          setImmediate(() => {
            proc.emit('error', err);
            proc._emitClose(1, null);
          });
        });
      return proc;
    }
    // Local CLI available — spawn directly, wrapped in the model ladder: each
    // attempt clones args with its own '--model' value, so `-p` argv and any
    // retry always agree on the model actually in use.
    if (fs.existsSync(CLAUDE_BIN)) {
      return new ModelFallbackProc({
        models: chain,
        onModelChange,
        spawnAttempt: (model) => {
          const a = args.slice();
          const mi = a.indexOf('--model');
          if (mi >= 0 && mi + 1 < a.length) a[mi + 1] = model;
          else a.push('--model', model);
          return spawn(CLAUDE_BIN, a, {
            cwd,
            env,
            stdio: [stdinMode || 'ignore', 'pipe', 'pipe'],
          });
        },
      });
    }

    // [2026-10-12] No local CLI used to mean «we're the Pi»: the session went
    // to the PC through PeerProc (server/peer-relay.js). The Machine no longer
    // runs on the Pi, so that branch is gone (history: git log -- server/peer-relay.js).
    // Nothing available — spawn will fail with a clear error
    return spawn(CLAUDE_BIN, args, {
      cwd,
      env,
      stdio: [stdinMode || 'ignore', 'pipe', 'pipe'],
    });
  }

  // Called by server when it sees a session_id in the CLI init event
  setClaudeSessionId(id, claudeSessionId) {
    const session = this.sessions.get(id);
    if (session && !session.claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
      this.save();
    }
  }

  // Clear stale CLI session ID so next message starts a fresh conversation
  clearClaudeSessionId(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.claudeSessionId = null;
      this.save();
    }
  }

  setTeam(id, team) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    session.team = team;
    // Fleet launches (_launchTeam) set a clean title (e.g. "Writer")
    // and then PATCH the team color through here. Mark the session so the
    // auto-titler skips it and leaves the clean title alone.
    session.manuallyRenamed = true;
    // Fix I: the team color identifies the fleet TYPE at CREATION, but we do NOT
    // mint the number here anymore. Minting at spawn/setTeam inflated the counters
    // (one number per throwaway session) because every throwaway session that got
    // team-tagged and then deleted-without-use still burned a number. Instead we
    // only RECORD the type (so the card can pin immediately), and defer the actual
    // number claim to first real use (the first user message → sendMessage →
    // _stampFleet). A session opened and deleted without ever being used never
    // reaches _stampFleet, so it claims NOTHING.
    const ft = _fleetTeamType()[team];
    if (ft) {
      session.agentType = session.agentType || ft;
      // Provisional title until the number is minted on first use; a real user
      // label (agentLabel) or an already-minted number is never clobbered.
      if (!session.agentLabel && typeof session.agentNumber !== 'number') {
        session.title = ft.toUpperCase();
      }
    }
    this.save();
  }

  // [12/11/2026 ] La sessione si è chiusa con l'agente Wrap: il resoconto che
  // il proprietario manderà alla sessione speciale porta con sé la domanda «la butto?».
  markWrapped(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.wrappedAt = Date.now();
    this.save();
  }

  setContextTokens(id, tokens) {
    const session = this.sessions.get(id);
    if (session) {
      session.contextTokens = tokens;
      // Don't save on every token update — debounced save handles it
    }
  }

  // Step 1 spending brake: accumulate the tokens a session has consumed across
  // its whole life. Fed by stream-handler from each turn's `result` usage.
  // Persisted in _serializeAll/load so the cap survives restarts — an
  // in-memory-only counter resets to 0 every boot and the cap becomes dead
  // code (cf. the _resumeAttempts gotcha, 2026-05-22 token drain).
  addTokensUsed(id, n) {
    const session = this.sessions.get(id);
    if (!session || !Number.isFinite(n) || n <= 0) return;
    session.tokensUsed = (session.tokensUsed || 0) + n;
    this.save();
  }

  // --- Stream buffer: tracks in-progress response so reconnecting clients can resume ---

  startStream(id) {
    this.streamBuffers.set(id, { text: '', tools: [], lastFlush: '' });
    // Detached-runs (flag DETACHED_RUNS): begin a fresh turn in the ordered
    // replay log — clears the previous turn's retained events while keeping the
    // monotonic seq counter running, so a stale prior `done` can't bleed into
    // this turn's replay. Inert/no-op when the flag is off.
    if (process.env.DETACHED_RUNS) {
      try { require('./stream-log').startTurn(id); } catch {}
    }
    // Periodic flush: save partial response to disk every 10s during streaming
    // so even a hard crash preserves most of the response
    const flushTimer = setInterval(() => {
      const buf = this.streamBuffers.get(id);
      if (!buf || buf.text === buf.lastFlush) return; // no new data
      buf.lastFlush = buf.text;
      const session = this.sessions.get(id);
      if (session) {
        // Update lastMessage preview for session list
        session.lastMessage = buf.text.slice(0, 100);
        session.lastActivity = new Date();
        this.save();
        // M9 Fase B vector 4 (RESTART_MEMORY-gated): ALSO durably persist the
        // FULL buf.text (not just the 100-char preview) to a per-session partial
        // file, so a HARD crash (SIGKILL/power — no graceful flush runs) can
        // still adopt the whole reply into history on the next boot. Inert +
        // zero disk I/O when the flag is off ⇒ byte-identical to before.
        if (process.env.RESTART_MEMORY) {
          try {
            require('./stream-partials').writePartial(id, buf.text, session.claudeSessionId);
          } catch {}
        }
      }
    }, 10000);
    this.streamBuffers.get(id)._flushTimer = flushTimer;
  }

  appendStreamText(id, text) {
    const buf = this.streamBuffers.get(id);
    if (buf) buf.text += text;
  }

  // [2026-10-04] Risposta rifatta dal controllo delle regole: il testo in corso
  // diventa «scartato» e il flusso riparte da vuoto (chi si ricollega a metà
  // vede la riga grigia + il seguito, non i due testi incollati).
  markStreamRedo(id, scartato) {
    const buf = this.streamBuffers.get(id);
    if (!buf) return;
    buf.text = '';
    buf.discarded = (buf.discarded || []).concat([scartato]);
  }

  addStreamTool(id, tool) {
    const buf = this.streamBuffers.get(id);
    if (buf) buf.tools.push(tool);
  }

  getStreamState(id) {
    return this.streamBuffers.get(id) || null;
  }

  clearStream(id) {
    const buf = this.streamBuffers.get(id);
    if (buf && buf._flushTimer) clearInterval(buf._flushTimer);
    this.streamBuffers.delete(id);
    // M9 Fase B vector 4 (RESTART_MEMORY-gated): the turn's live stream is done
    // (clean finish / stop / stale-retry) → drop the durable full-text partial so
    // it can never be adopted into history on a later boot. Inert when flag off.
    if (process.env.RESTART_MEMORY) {
      try { require('./stream-partials').clearPartial(id); } catch {}
    }
  }

  isSessionBusy(id) {
    const session = this.sessions.get(id);
    return session && session.process !== null;
  }

  // Phase 5a daemon replay: "do we currently have a non-closed proc tracked
  // for this session?" Reuses the same session.process slot that sendMessage
  // writes to — keeps one source of truth for liveness. A RemoteProc adopted
  // via adoptReplayProc below sets _closed = true when its 'close' event
  // fires, so we also check that to avoid treating a zombie handle as live.
  hasLiveProc(id) {
    const session = this.sessions.get(id);
    if (!session || !session.process) return false;
    // RemoteProc flips _closed on 'close'; ChildProcess doesn't have this
    // flag, so fall back to the process-is-null convention (close handler
    // in index.js sets session.process = null via finishMessage).
    if (session.process._closed === true) return false;
    return true;
  }

  // Phase 5a daemon replay: register a RemoteProc that the session-host
  // daemon gave us (via client.resume()) so subsequent hasLiveProc checks
  // see it. We do NOT call _spawnClaude — this proc already exists in the
  // daemon. On 'close' we null the slot so finishMessage's cleanup path
  // (called by spawnStreamHandler) stays consistent with a fresh spawn.
  adoptReplayProc(id, proc) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`adoptReplayProc: session ${id} not found`);
    session.process = proc;
    session.status = 'busy';
    session.lastActivity = new Date();
    // Match the "fresh spawn" invariant: finishMessage nulls session.process
    // when the stream closes. spawnStreamHandler's close handler already
    // calls finishMessage, so we don't need our own close listener here.
    // (replayedSet bookkeeping lives in session-host-replay.js.)
  }

  // [2026-09-30] Turno spontaneo del motore SDK: un lavoro in background è
  // finito e il modello è ripartito da solo (vedi sdk-engine.js, «TURNI CHE
  // NASCONO DA SOLI»). Nessun messaggio del proprietario da mettere in storia: si
  // adotta il turno come se fosse partito da sendMessage, così la chiusura
  // (finishMessage) scrive la risposta e libera lo slot come sempre.
  // false = non adottabile (sessione sparita o già occupata): il motore lo lascia cadere.
  adoptUnsolicitedTurn(id, proc) {
    const session = this.sessions.get(id);
    if (!session || session.process) return false;
    session.process = proc;
    session.status = 'busy';
    session.lastActivity = new Date();
    session._turnStart = Date.now();
    session._turnStartTokens = session.tokensUsed || 0;
    return true;
  }

  stopMessage(id, opts = {}) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    // [17/10/2026] Il tasto rosso (opts.stopBackground, source:'button' dal
    // client) ferma ANCHE i lavori in sottofondo che tengono la sessione in
    // WAITING — il proprietario: «se voglio fermarla la apro e premo il tasto rosso».
    // Lo stop di un messaggio scritto durante il lavoro non lo passa: quei
    // lavori continuano (regola del 01/10). Prova: tests/tasto-rosso-sottofondo.test.js.
    // [29/10/2026] Lo stop di un messaggio scritto mentre il modello parla con
    // aiutanti vivi NON interrompe: l'interrupt del CLI li ucciderebbe tutti.
    if (!opts.stopBackground && this.interjectionMustWait(id)) {
      console.log(`[SESSION] stop di ${id.slice(0, 8)} non eseguito: aiutanti vivi, il messaggio aspetta`);
      return false;
    }
    if (this.hasWaitingMessages(id)) setImmediate(() => this.deliverWaiting(id)); // tasto rosso: i messaggi in coda partono
    let bgStopped = 0;
    if (opts.stopBackground && USE_SDK_ENGINE) {
      try { bgStopped = require('./sdk-engine').stopBackgroundTasks(id) || 0; }
      catch (err) { console.warn(`[SESSION] stop: lavori in sottofondo di ${id.slice(0, 8)} non fermati:`, err.message); }
    }
    // ROUND CHAT bug 4 (2026-08-16): when the turn lives in the session-host
    // daemon and no proc has been (re-)adopted here — e.g. right after one of
    // today's 4 deploy restarts — `session.process` is null and the old code
    // silently did NOTHING while the daemon kept streaming. Best-effort kill by
    // session id so stop works even without an adopted proc handle.
    if (!session.process && process.env.DETACHED_RUNS) {
      let requested = false;
      try {
        const { getClient } = require('./session-host-client');
        getClient().kill(id).catch(() => {});
        requested = true;
        console.log(`[SESSION] stop: no adopted proc for ${id.slice(0, 8)} — forwarded kill to session-host daemon`);
      } catch (err) {
        console.warn(`[SESSION] stop: daemon kill forward failed for ${id.slice(0, 8)}:`, err.message);
      }
      if (session.status === 'busy') {
        session.status = 'idle';
        session.lastActivity = new Date();
        this.save();
      }
      this.clearStream(id);
      return requested || bgStopped > 0;
    }
    if (session.process) {
      // Save partial response before killing
      const buf = this.streamBuffers.get(id);
      // [2026-10-01] Turno «in attesa del background» col modello fermo: il proprietario
      // che scrive non ha fermato niente — la risposta di prima è completa e
      // il lavoro continua (il suo seguito arriverà come turno a sé).
      let idleHold = false;
      if (USE_SDK_ENGINE) { try { idleHold = require('./sdk-engine').isIdleHold(id); } catch {} }
      if (buf && buf.text) {
        session.history.push({
          role: 'assistant',
          content: idleHold ? buf.text : buf.text + '\n\n*[Stopped by user]*',
          tools: buf.tools || [],
          timestamp: Date.now(),
        });
        session.lastMessage = buf.text.slice(0, 100);
      }
      // Mark the process as user-killed so the stream handler's close event
      // knows to skip finishMessage/done (prevents the stale-done race condition
      // where an old close event nukes a newly spawned process).
      session.process._userKilled = true;
      session.process.kill('SIGTERM');
      session.process = null;
      session.status = 'idle';
      session.lastActivity = new Date();
      this.save();
      this.clearStream(id);
      return true;
    }
    this.clearStream(id);
    return bgStopped > 0; // nothing else was running — caller reports the truth to the client
  }

  finishMessage(id, fullResponse, tools = [], thinking = '', steps = [], discarded = []) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.process = null;
    session.status = 'idle';
    session._resumeAttempts = 0; // Reset crash-loop counter on successful completion
    session.lastActivity = new Date();
    session.lastMessage = fullResponse.slice(0, 100);
    const entry = { role: 'assistant', content: fullResponse, tools, timestamp: Date.now() };
    if (thinking) entry.thinking = thinking;
    // [2026-10-01] I passaggi intermedi (testo prima dell'ultimo strumento):
    // il client li mostra ripiegati, la risposta è solo `content`.
    if (Array.isArray(steps) && steps.length) entry.steps = steps;
    // [2026-10-04] Le versioni scartate dal controllo delle regole: il client
    // le mostra chiuse in una riga grigia sopra la risposta rifatta.
    if (Array.isArray(discarded) && discarded.length) entry.discarded = discarded;
    session.history.push(entry);
    if (session.history.length > MAX_HISTORY_PER_SESSION) {
      session.history = session.history.slice(-MAX_HISTORY_PER_SESSION);
    }
    // Observatory: one ground-truth record per completed turn — the workhorse
    // event. duration_ms = wall time since sendMessage; tokens = this turn's
    // delta (best-effort: if the `result` usage lands after this call it shows
    // on the next turn — acceptable for Phase 1). tool names only, deduped.
    const toolNames = (Array.isArray(tools) ? tools : [])
      .map(t => (typeof t === 'string' ? t : (t && (t.name || t.tool)) || null))
      .filter(Boolean);
    logEvent('turn', {
      session: id,
      team: session.team || null,
      duration_ms: session._turnStart ? (Date.now() - session._turnStart) : null,
      tokens: Math.max(0, (session.tokensUsed || 0) - (session._turnStartTokens || 0)),
      tools: toolNames,
      tool_count: toolNames.length,
      reply_chars: typeof fullResponse === 'string' ? fullResponse.length : 0,
    });
    delete session._turnStart;
    delete session._turnStartTokens;
    this.clearStream(id);
    this.save();
    // Ask the session-host daemon to drop its ring buffer + on-disk jsonl
    // for this sid now that the assistant row is persisted. Prevents Phase 5a
    // replay from re-parsing stale stream-json on the next WS reopen, which
    // would otherwise re-invoke finishMessage and compound a duplicate row
    // into history. Fire-and-forget; errors are logged by the client layer.
    // Guard with the flag so the OFF-path stays zero-side-effect.
    if (USE_SESSION_HOST) {
      try {
        const client = getSessionHostClient();
        if (client && typeof client.purge === 'function') {
          client.purge(id).catch((err) => {
            console.error('[SESSION] daemon purge failed for', id.slice(0, 8), err.message);
          });
        }
      } catch (err) {
        console.error('[SESSION] daemon purge dispatch threw:', err.message);
      }
    }
    // [29/10/2026] Turno chiuso: un messaggio del proprietario in attesa parte adesso
    // (setImmediate: dopo il «done»/idle che il tubo del flusso manda subito dopo).
    if (this.hasWaitingMessages(id)) setImmediate(() => this.deliverWaiting(id));
  }

  resumeInterrupted() {
    const resumed = [];
    for (const session of this.sessions.values()) {
      if ((session.status === 'busy' || session.status === 'wrapping') && !session.process) {
        session.status = 'idle';
      }
      if (session.status === 'interrupted') {
        if (session.claudeSessionId) {
          let lastUserMsg = null;
          for (let i = session.history.length - 1; i >= 0; i--) {
            if (session.history[i].role === 'user') {
              lastUserMsg = session.history[i];
              break;
            }
          }
          if (lastUserMsg) {
            session._pendingResume = {
              text: lastUserMsg.content,
              attachments: lastUserMsg.attachments || [],
            };
            resumed.push(session.id);
          } else {
            session.status = 'idle';
          }
        } else {
          session.status = 'idle';
          const last = session.history[session.history.length - 1];
          if (last && last.partial && !last.content.endsWith('\n\n*[Response interrupted — send another message to continue]*')) {
            last.content += '\n\n*[Response interrupted — send another message to continue]*';
            last.partial = false;
          }
        }
      }
    }
    this.save();
    return resumed;
  }

  getPendingResumes() {
    const pending = [];
    for (const session of this.sessions.values()) {
      if (session._pendingResume) {
        pending.push({
          id: session.id,
          text: session._pendingResume.text,
          attachments: session._pendingResume.attachments,
        });
      }
    }
    return pending;
  }

  clearPendingResume(id) {
    const session = this.sessions.get(id);
    if (session) delete session._pendingResume;
  }

  _serializeAll(gracefulExit = false) {
    const data = [];
    for (const s of this.sessions.values()) {
      const entry = {
        id: s.id,
        title: s.title,
        status: gracefulExit ? s.status : 'idle',
        created: s.created.toISOString(),
        lastActivity: s.lastActivity?.toISOString(),
        lastMessage: s.lastMessage,
        workingDirectory: s.workingDirectory,
        history: s.history,
        claudeSessionId: s.claudeSessionId,
        permissionMode: s.permissionMode || 'plan',
        team: s.team || null,
        contextTokens: s.contextTokens || 0,
        tokensUsed: s.tokensUsed || 0,
        manuallyRenamed: !!s.manuallyRenamed,
        autoTitled: !!s.autoTitled,
        peerSessionId: s.peerSessionId || null,
        // Model the session last spawned with (UI card label). Persisted so a
        // restart keeps the card truthful; load() restores it via its spread.
        model: s.model || null,
        // The session's model PIN (2026-08-16) — survives restarts so a session
        // keeps its birth/chip-picked model for life. load() restores via spread.
        pinnedModel: s.pinnedModel || null,
        // Guardia 1 (2026-08-10): marchio durevole del figlio relay del Father.
        // Persisti `ephemeral` così sopravvive al restart e la Guardia 2 in load()
        // può scartarlo (hidden da solo era in-memory → figli riapparivano).
        ephemeral: !!s.ephemeral,
        wrappedAt: s.wrappedAt || null, // : chiusa con Wrap, sopravvive al riavvio
        // Fleet numbering (FLIP 2026-07-20): persist the stamped ticket so it
        // survives reload. null on non-fleet sessions.
        agentType: s.agentType || null,
        agentNumber: (typeof s.agentNumber === 'number') ? s.agentNumber : null,
        // Fix B: persist the editable label (the suffix after the locked number).
        agentLabel: s.agentLabel || null,
        // Persist the one-claim-per-lifetime latch so a restart never re-claims.
        _fleetStamped: !!s._fleetStamped,
        // Persist the crash-loop counter. Without this it resets to undefined
        // on every boot, so the `_resumeAttempts >= 3` breaker in index.js can
        // never trip and an interrupted session is auto-resumed unbounded —
        // each resume re-ingests the full transcript (token drain, 2026-05-22).
        _resumeAttempts: s._resumeAttempts || 0,
        // [11/10/2026] Ultima volta che il proprietario l'ha aperta/letta da un apparecchio
        // (session_read): il telefono che torna in vita toglie le notifiche più vecchie.
        readAt: s.readAt || null,
      };
      // [12/11/2026 ] I messaggi del proprietario in coda (queueWaitingMessage: modello che parla, aiutanti vivi, non piegati)
      // stavano solo in memoria: un riavvio li perdeva (10/11 20:25:50 «1 in coda», riavvio 21:09, mai partiti). Si salvano
      // e load() li rimette in coda; partono a fine del turno ripreso, o al boot se la sessione è ferma (index.js).
      const attesa = this._waitingMessages && this._waitingMessages.get(s.id);
      if (attesa && attesa.length) entry.attesa = attesa.map((x) => ({ content: x.content, attachments: x.attachments || [], nonce: x.nonce || null }));
      data.push(entry);
    }
    return JSON.stringify(data, null, 2);
  }

  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const data = this._serializeAll();
        atomicWrite(this.storePath, data, (err) => {
          if (err) return console.error('[SESSION] Write error:', err.message);
          // Main write succeeded — mirror to the rolling .bak (last known-good).
          atomicWrite(this.bakPath, data, (bErr) => {
            if (bErr) console.error('[SESSION] Backup write error:', bErr.message);
          });
        });
      } catch (err) {
        console.error('[SESSION] Save error:', err.message);
      }
    }, 100);
  }

  saveSync() {
    // Cancel any pending debounced save — it would overwrite interrupted statuses with idle
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      const data = this._serializeAll(true);
      atomicWriteSync(this.storePath, data);
      // Mirror to the rolling .bak (last known-good) for parse-fail recovery.
      try { atomicWriteSync(this.bakPath, data); }
      catch (bErr) { console.error('[SESSION] Backup sync write error:', bErr.message); }
    } catch (err) {
      console.error('[SESSION] Sync save error:', err.message);
    }
  }

  load() {
    if (!fs.existsSync(this.storePath)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
    } catch (mainErr) {
      // Main file is corrupt. Do NOT return empty — that silently wipes every
      // chat. Try the rolling .bak (last known-good) before giving up.
      console.error(`[SESSION] !!! sessions.json parse FAILED (${mainErr.message}) — attempting .bak recovery`);
      try {
        if (!fs.existsSync(this.bakPath)) throw new Error('no .bak present');
        data = JSON.parse(fs.readFileSync(this.bakPath, 'utf-8'));
        console.error('[SESSION] !!! Recovered sessions from sessions.json.bak — chats preserved');
      } catch (bakErr) {
        console.error(`[SESSION] !!! .bak recovery also FAILED (${bakErr.message}) — starting empty`);
        return;
      }
    }
    try {
      for (const s of data) {
        // Guardia 2 (2026-08-10): REAP AL BOOT. Un figlio relay del Father
        // (ephemeral, o il vecchio marchio solo-hidden) NON va reinserito: dopo un
        // restart il suo processo CLI è morto (process:null) e il poller del Father
        // è finito, quindi il job è già perso. Scartandolo qui NON può mai
        // rirenderizzare nella sidebar, e la entry sparisce dal prossimo save().
        // Realizza l'intento già documentato ("a restart wipes the children").
        if (s.ephemeral || s.hidden) {
          console.log('[SESSION] Reap figlio relay al boot', String(s.id).slice(0, 8));
          continue;
        }
        // Enforce history limit on load (old sessions may exceed it)
        if (s.history && s.history.length > MAX_HISTORY_PER_SESSION) {
          s.history = s.history.slice(-MAX_HISTORY_PER_SESSION);
        }
        this.sessions.set(s.id, {
          ...s,
          created: new Date(s.created),
          lastActivity: s.lastActivity ? new Date(s.lastActivity) : new Date(s.created),
          status: s.status === 'interrupted' ? 'interrupted' : 'idle',
          process: null,
          team: s.team || null,
          contextTokens: s.contextTokens || 0,
          tokensUsed: s.tokensUsed || 0,
          manuallyRenamed: !!s.manuallyRenamed,
          autoTitled: !!s.autoTitled,
          deploy_marker: s.deploy_marker || null,
          wrappedAt: s.wrappedAt || null,
          peerSessionId: s.peerSessionId || null,
          _resumeAttempts: s._resumeAttempts || 0,
          // Fleet numbering (FLIP 2026-07-20): restore the stamped ticket.
          agentType: s.agentType || null,
          agentNumber: (typeof s.agentNumber === 'number') ? s.agentNumber : null,
          // Fix B: restore the editable label suffix.
          agentLabel: s.agentLabel || null,
          // Fix A: seal-on-load. The one-claim-per-lifetime latch (Fix 1) is
          // restored; additionally, ANY session that already carries a number
          // (agentType + agentNumber) is force-sealed here even if a pre-latch
          // save left _fleetStamped=false (e.g. abccaa15: number 45). A sealed
          // session can NEVER re-claim, so its number can never be bumped on a
          // restart — the number is minted exactly once, for life.
          _fleetStamped: !!s._fleetStamped || (!!s.agentType && typeof s.agentNumber === 'number'),
        });
        // [12/11/2026 ] la coda dei messaggi del proprietario salvata da _serializeAll torna in coda, non nella sessione
        const caricata = this.sessions.get(s.id);
        delete caricata.attesa;
        if (Array.isArray(s.attesa) && s.attesa.length) {
          this._waitingMessages.set(s.id, s.attesa.filter((x) => x && typeof x.content === 'string')
            .map((x) => ({ content: x.content, attachments: Array.isArray(x.attachments) ? x.attachments : [], nonce: x.nonce || null })));
          console.log(`[SESSION] ${String(s.id).slice(0, 8)}: ${s.attesa.length} messaggi dell'utente in coda ripresi dopo il riavvio`);
        }
      }
    } catch (err) {
      console.error('[SESSION] Load error:', err.message);
    }
  }

  _serialize(session) {
    return {
      id: session.id,
      title: session.title,
      status: session.process ? 'busy' : session.status,
      created: session.created,
      lastActivity: session.lastActivity,
      lastMessage: session.lastMessage,
      history: session.history,
      // Model shown on the session card. A session that never spawned yet gets
      // the CURRENT default (resolved fresh, so a /model change shows up on new
      // cards without a restart) — never empty.
      model: session.model || resolveModelChain()[0],
      team: session.team || null,
      contextTokens: session.contextTokens || 0,
      deploy_marker: session.deploy_marker || null,
      // Fleet numbering (FLIP 2026-07-20): ship the stamped ticket to the client
      // so fleetDisplayName reads it off the session (no counter race). null on
      // non-fleet sessions.
      agentType: session.agentType || null,
      agentNumber: (typeof session.agentNumber === 'number') ? session.agentNumber : null,
      // Fix B: ship the editable label so the client renders "TYPE N [label]"
      // with the number always intact. manuallyRenamed lets the client know a
      // fleet card carries a user label.
      agentLabel: session.agentLabel || null,
      manuallyRenamed: !!session.manuallyRenamed,
      // Expose the hidden flag so the client filters Father's children out of the
      // sidebar.
      hidden: !!session.hidden,
      // [2026-09-30] Lavori in background ancora vivi nel motore SDK: la card
      // dice «sta lavorando» anche a turno chiuso, finché non tornano.
      backgroundTasks: USE_SDK_ENGINE ? require('./sdk-engine').backgroundTaskCount(session.id) : 0,
      // [17/10/2026] Quali lavori, e se il turno li sta solo aspettando.
      ...(() => {
        if (!USE_SDK_ENGINE) return { backgroundTaskList: [], backgroundWaiting: false, backgroundStopped: 0 };
        const i = require('./sdk-engine').backgroundInfo(session.id);
        // [29/10/2026] + quanti aiutanti sono stati fermati: la card lo dice.
        return { backgroundTaskList: i.tasks, backgroundWaiting: i.waiting, backgroundStopped: i.stopped || 0 };
      })(),
      // [11/10/2026] Quando il proprietario l'ha letta l'ultima volta (ms, o null).
      readAt: session.readAt || null,
    };
  }

  // [11/10/2026] Un apparecchio ha aperto/letto la sessione (session_read).
  // Salvato su disco: un telefono ucciso da Samsung lo scopre al ritorno e
  // toglie la notifica che non aspetta più nessuno. Sessione assente = niente.
  markRead(id, at = Date.now()) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.readAt = at;
    // Il file delle sessioni porta tutte le storie: una lettura arriva a ogni
    // ritorno sulla pagina, il disco basta ogni 30 s (la memoria è sempre esatta,
    // e /api/sessions legge la memoria).
    if (!this._readSavedAt || at - this._readSavedAt > 30000) {
      this._readSavedAt = at;
      this.save();
    }
    return true;
  }

  // CHIP MODELLO (2026-08-16): re-pin an open session (special agents included) to a
  // new model, effective from its NEXT message. No live process is touched here
  // — and none needs to be: the CLI path spawns per turn with --model = pin,
  // and the SDK path compares the warm session's model at startTurn and
  // respawns it (resume preserved) when the pin changed. So the change reaches
  // the REAL process on the next turn, not just the label. A turn already in
  // flight finishes on its old model — never truncated.
  setModel(id, model) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    const m = String(model || '').trim();
    if (!m) throw new Error('Model required');
    session.pinnedModel = m;
    // FAMIGLIE (round #4/#5): the pin may be a bare family ('fable', 'opus') —
    // resolve it to the PRECISE newest id NOW so chip/card read a real version
    // immediately (round #5, 1a: click Opus → "Opus 5" at once, not "Opus" then
    // "Opus 4-8"). displayModelFor never returns a bare family for a known one;
    // the init line of the next turn re-stamps the exact running id
    // (noteRunningModel below). The PIN stays the bare family so every spawn
    // re-resolves to the family's current newest.
    session.model = displayModelFor(m);
    this.save();
    return this._serialize(session);
  }

  // FAMIGLIE (2026-08-16, round #4): stamped from the CLI/SDK `system:init`
  // line (stream-handler), which carries the model the process is ACTUALLY
  // running — the resolved id of a family alias included. Display-only: the
  // PIN is never touched here, so family pins keep re-resolving per spawn.
  noteRunningModel(id, model) {
    const session = this.sessions.get(id);
    const m = (typeof model === 'string') ? model.trim() : '';
    if (!session || !m || m === 'claude') return;
    if (session.model === m) return;
    session.model = m;
    this.save();
  }

  setDeployMarker(sessionId, marker) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.deploy_marker = marker;
    this.saveSync();
    return true;
  }

  consumeDeployMarker(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.deploy_marker) return null;
    const m = s.deploy_marker;
    delete s.deploy_marker;
    this.saveSync();
    return m;
  }
}

// [12/11/2026 ] Al riavvio a turno in corso il messaggio del proprietario è GIÀ nella conversazione del modello (letto
// prima del riavvio, o piegato nel turno): rimandarlo nudo lo faceva sembrare un doppione (10/11 21:09, sessione
// bc99ff5d). Riparte lo stesso testo con una riga che lo dice; se il modello non l'aveva ancora letto, lo legge ora.
function ripresaDopoRiavvio(text) {
  const t = String(text == null ? '' : text);
  if (t.startsWith(RIPRESA_TESTA)) return t;
  return RIPRESA_TESTA + '\n\n' + t;
}
const RIPRESA_TESTA = '[Server restart: the server restarted while you were working on this message from the user. It is the SAME message '
  + 'already in this conversation, not a new one and not a repeat: do not start over and do not mention a repeat. Check what '
  + 'you had already done and continue from where you were cut off; if you had not started on it yet, answer it now.]';
SessionManager.ripresaDopoRiavvio = ripresaDopoRiavvio;

module.exports = { SessionManager, TRASH_DIR };
