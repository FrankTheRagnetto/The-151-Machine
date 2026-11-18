'use strict';

// =============================================================================
// SESSION ENGINE REBUILD — Step 2: the Claude Agent SDK engine.
// =============================================================================
// Runs ALONGSIDE the legacy `claude -p` engine, selected by USE_SDK_ENGINE in
// session-manager.js (mirrors USE_SESSION_HOST). Flag OFF -> this module is
// never even require()d; the legacy engine is fully intact and instant to
// restore. The flag flip is separately gated and code-reviewed.
//
// INCREMENT 2.2 — warm / persistent sessions:
//   A session keeps ONE long-lived `query()` in streaming-input mode. Each
//   user turn is pushed into that query's input generator; the warm process
//   stays alive between turns, so the transcript is NOT re-ingested per
//   message (turn 2+ reads context from the prompt cache — the efficiency win).
//   The SDK emits one `result` per turn = the turn boundary.
//
// ADAPTER, not rewrite: SdkTurnProc duck-types a ChildProcess for one turn and
//   re-serialises each SDK message to a stdout JSON line. The SDK message JSON
//   already matches the CLI `--output-format stream-json` shape, so
//   spawnStreamHandler, the WS protocol AND the Step-1 token brake
//   (`result.usage` -> addTokensUsed) are all untouched.
//
// LIFECYCLE (the risk area — handled deliberately):
//   - idle eviction: a warm session with no turn for SDK_SESSION_IDLE_MS is
//     torn down (RAM / orphan guard); the next message transparently re-creates
//     it, resuming the conversation via claudeSessionId.
//   - hard cap: at most SDK_MAX_WARM concurrent warm sessions (LRU-evicted).
//   - crash detection: if the warm query ends/crashes, the session is marked
//     dead and dropped; the next startTurn() re-creates it (transparent).
//   - no orphans: evict()/shutdown abort the query (kills the CLI child);
//     session-manager hooks + SIGTERM/exit guards cover server restart.
//
// AUTH: ANTHROPIC_API_KEY/AUTH_TOKEN are stripped from the spawned CLI's env
//   so it authenticates via the ~/.claude OAuth subscription, never the
//   pay-per-token API. The model pin (CLAUDE_MODEL) is passed through.
// =============================================================================

const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');
const crypto = require('crypto');
const childProcess = require('child_process');

const SDK_SESSION_IDLE_MS = parseInt(process.env.SDK_SESSION_IDLE_MS, 10) || 600000; // 10 min
const SDK_MAX_WARM = parseInt(process.env.SDK_MAX_WARM, 10) || 8;

// [2026-10-01] UN MESSAGIO SOLO PER «ASPETTO E TI DICO» (ordine del proprietario).
// Il giro del 30/09 faceva nascere la risposta del lavoro in background come
// SECONDO messaggio, e il primo («sto aspettando») chiudeva il turno: suono,
// «risposta pronta», notifica — per una risposta che non c'era ancora. Ora un
// `result` che arriva con lavori in background vivi NON chiude il turno: il
// turno resta «in attesa» (card «sta lavorando», nessun suono), e quando il
// CLI riaccende il modello il seguito si attacca allo STESSO messaggio.
// Tetti, perché un lavoro in background può non finire mai (un server di
// sviluppo lanciato in background): passato il tetto il messaggio si chiude
// come prima, e un eventuale seguito tardivo nasce come turno spontaneo.
const BG_HOLD_AGENT_MS = parseInt(process.env.SDK_BG_HOLD_AGENT_MS, 10) || 60 * 60 * 1000; // agenti/workflow
const BG_HOLD_OTHER_MS = parseInt(process.env.SDK_BG_HOLD_OTHER_MS, 10) || 15 * 60 * 1000; // bash e il resto
// [17/10/2026] «Perché non chiudono i turni?». Un ciclo d'attesa con
// `pgrep -f` trovava sé stesso e non finiva mai; il CLI dopo 10 minuti lo
// spostava in sottofondo e da lì OGNI turno della sessione restava «in attesa»
// fino al tetto. Da quel giorno il messaggio aspetta SOLO i lavori nati nel suo
// stesso turno (_ownTasks) e MAI un comando che il CLI ha spostato in
// sottofondo per il limite di tempo (_expiredTasks): quello non è un «ti avviso
// quando finisce», è un comando scaduto. Prova: tests/sdk-attesa-solo-del-turno.test.js.
const MOVED_TO_BG_RE = /moved to the background \(ID: ([A-Za-z0-9_-]+)\)/g;
// Lavori finiti ma il modello non riparte (succede: task senza seguito) → si chiude dopo questa grazia.
const BG_GRACE_MS = parseInt(process.env.SDK_BG_GRACE_MS, 10) || 20000;
// [29/10/2026] Un lavoro che esce dall'elenco dei vivi senza un «completed»
// entro questo tempo è contato FERMATO (la scheda lo dice invece di farlo
// sparire). L'ordine fra elenco e notifica non è garantito dall'SDK: si aspetta.
const BG_DEAD_MS = parseInt(process.env.SDK_BG_DEAD_MS, 10) || 5000;

// [2026-09-10] Il cane da guardia dei congelamenti è stato tolto insieme a
// server/classifier-fallback.js, che era il suo unico destinatario. Quel modulo
// era spento a mano dal 2026-08-04 (ENABLED=false): reportFreeze() rientrava
// subito senza fare niente, quindi il timer girava per parlare al vuoto.
// FREEZE_WATCH_MS resta esportato: tests/sdk-engine-*.test.js lo legge.
const FREEZE_WATCH_MS = parseInt(process.env.CLASSIFIER_FREEZE_MS, 10) || 45000;

// The SDK is ESM-only — load via dynamic import() so server/ stays CJS. Cached.
let _sdkModule = null;
async function getSdk() {
  if (!_sdkModule) _sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  return _sdkModule;
}

// [08/11/2026] — IL LAVORO DEGLI AGENTI NON AFFAMA LA VOCE DI il proprietario.
// whisper-stt gira solo su CPU. Alle 13:10 un OCR della sessione Manga (16
// tesseract, load 66 su 16 core, tutti a nice 0 come whisper) ha portato un
// vocale di 45 s da ~2 s a 390 s; quello delle 13:44 (6:56) non è arrivato.
// Il CLI di ogni sessione nasce con `nice -n 10` (exec: stesso pid, quindi
// signal/kill dell'SDK restano validi) e tutto ciò che lancia lo eredita:
// whisper e il server, a nice 0, passano sempre davanti.
// Prova: tests/agenti-non-affamano-whisper.test.js
const AGENT_NICE = 10;
function spawnAgente({ command, args, cwd, env, signal }, onStderr) {
  const child = childProcess.spawn('nice', ['-n', String(AGENT_NICE), command, ...(args || [])], {
    cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  // Lo stderr lo leggeva l'SDK (spawnLocalProcess) e lo passava a options.stderr.
  child.stderr.on('data', (d) => { try { if (onStderr) onStderr(String(d)); } catch {} });
  child.stderr.on('error', () => {});
  return child;
}

// registry: sessionId -> SdkSession (warm). The warm object lives ONLY here,
// never on the serialised session — sessions.json stays clean.
const registry = new Map();

// [29/10/2026] Lavori in sottofondo FERMATI (uccisi, falliti, morti con la
// sessione), per sessione: sopravvive alla sessione calda, così la scheda li
// mostra anche dopo un crash. Si azzera al prossimo messaggio del proprietario.
const stoppedBySession = new Map(); // sessionId -> Map(taskId -> {id, description, type})
// Chi aspetta che il modello smetta di parlare (session-manager: i messaggi di
// il proprietario scritti mentre gli aiutanti lavorano).
const _turnIdleListeners = [];
function onTurnIdle(fn) { if (typeof fn === 'function') _turnIdleListeners.push(fn); }
function emitTurnIdle(sessionId) {
  for (const fn of _turnIdleListeners) {
    try { fn(sessionId); } catch (e) { console.error('[SDK-ENGINE]', String(sessionId).slice(0, 8), 'turn-idle listener failed:', e && e.message); }
  }
}
function markStopped(s, task, why) {
  if (!s || !task || !task.id) return;
  if (s._completedIds && s._completedIds.has(task.id)) return;
  let m = stoppedBySession.get(s.sessionId);
  if (!m) { m = new Map(); stoppedBySession.set(s.sessionId, m); }
  if (m.has(task.id)) return;
  m.set(task.id, { id: task.id, description: task.description || '', type: task.type || '' });
  console.log('[SDK-ENGINE]', String(s.sessionId).slice(0, 8), 'lavoro in sottofondo FERMATO (' + why + '):', task.id, task.description ? '«' + task.description + '»' : '');
}
function stoppedCount(sessionId) {
  const m = stoppedBySession.get(sessionId);
  return m ? m.size : 0;
}

// [2026-09-30] TURNI CHE NASCONO DA SOLI (ordine del proprietario, stesso giorno).
// Quando un agente lancia un lavoro IN BACKGROUND (Agent/Bash con
// run_in_background) e chiude il turno dicendo «ti avviso quando finisce», il
// CLI — a lavoro finito — riaccende il modello DA SOLO: task_notification →
// init → assistant → result. Misurato dal vivo il 30/09 con una sonda sull'SDK
// 0.3.283 (secondo turno a +19s, nessun messaggio dell'utente). Prima di oggi
// _consume() inoltrava un messaggio SOLO se c'era un turno aperto dal proprietario: quel
// secondo turno finiva nel vuoto, e la sessione «prometteva di avvisare e non
// avvisava mai». Adesso il motore apre un turno da sé e lo consegna a chi l'ha
// registrato qui (index.js → spawnStreamHandler), esattamente come un turno
// normale: storia, broadcast busy→idle, «risposta pronta», notifica.
let _unsolicitedHandler = null; // (sessionId, turnProc) => boolean (true = adottato)
let _backgroundHandler = null;  // (sessionId, count) => void
function setUnsolicitedTurnHandler(fn) { _unsolicitedHandler = typeof fn === 'function' ? fn : null; }
function setBackgroundTasksHandler(fn) { _backgroundHandler = typeof fn === 'function' ? fn : null; }

// Messaggi che vogliono dire «il modello sta lavorando». Solo questi aprono un
// turno spontaneo: i bookend dei task (task_notification, background_tasks_changed,
// task_updated…) arrivano ANCHE senza che il modello riparta, e aprire un turno
// su di loro lascerebbe una card «sta lavorando» senza mai un `result`.
function opensTurn(msg) {
  if (!msg) return false;
  if (msg.type === 'assistant' || msg.type === 'stream_event') return true;
  if (msg.type === 'system' && msg.subtype === 'init') return true;
  if (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'requesting') return true;
  return false;
}

// --- async input queue: a generator the SDK consumes, that we push turns into.
function makeInputQueue() {
  const items = [];
  let waiter = null;
  let ended = false;
  async function* gen() {
    while (true) {
      if (items.length) { yield items.shift(); continue; }
      if (ended) return;
      await new Promise((res) => { waiter = res; });
    }
  }
  return {
    gen: gen(),
    push(item) { items.push(item); if (waiter) { const w = waiter; waiter = null; w(); } },
    end() { ended = true; if (waiter) { const w = waiter; waiter = null; w(); } },
  };
}

// [17/10/2026] I lavori che QUESTO turno aspetta: nati nel turno, vivi, e non
// spostati in sottofondo dal CLI per il limite di tempo.
function waitedTasks(s, turn) {
  if (!s || !Array.isArray(s.bgTasks) || !s.bgTasks.length) return [];
  const own = turn && turn._ownTasks;
  const expired = s._expiredTasks;
  return s.bgTasks.filter((t) => own && own.has(t.id) && !(expired && expired.has(t.id)));
}

// Il risultato di un Bash che il CLI ha spostato in sottofondo per il tetto dei
// 10 minuti dice «moved to the background (ID: …)»: quel lavoro non si aspetta.
function noteMovedToBackground(s, msg) {
  const content = msg && msg.message && msg.message.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || b.type !== 'tool_result') continue;
    const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
    MOVED_TO_BG_RE.lastIndex = 0;
    let m;
    while ((m = MOVED_TO_BG_RE.exec(text))) {
      if (!s._expiredTasks) s._expiredTasks = new Set();
      s._expiredTasks.add(m[1]);
      console.log('[SDK-ENGINE]', s.sessionId.slice(0, 8), 'comando scaduto spostato in sottofondo, non si aspetta:', m[1]);
    }
  }
}

// Avvisa chi guarda (index.js → card della lista) quando cambia il numero dei
// lavori O lo stato d'attesa: prima avvisava solo al cambio del numero.
function notifyBg(s) {
  if (!s || !_backgroundHandler) return;
  const turn = s.activeTurn;
  const waiting = !!(turn && typeof turn.isIdleHold === 'function' && turn.isIdleHold());
  const count = (s.bgTasks || []).length;
  const sig = count + ':' + waiting + ':' + stoppedCount(s.sessionId);
  if (s._bgSig === sig) return;
  s._bgSig = sig;
  try { _backgroundHandler(s.sessionId, count); } catch (e) {
    console.error('[SDK-ENGINE]', String(s.sessionId).slice(0, 8), 'background handler failed:', e && e.message);
  }
}

// [08/11/2026] — DI CHI È QUESTO `result`? (il proprietario: «dopo un !comando la
// chat si rompe»: bolla vuota, poi la risposta come turno a parte.) Il turno
// si chiudeva sul PRIMO result, anche di un altro turno. Misurato con l'SDK
// 0.3.283 (sonde dell'08/11, tests/sdk-risultato-altrui.test.js):
//  - sessione ripresa con un lavoro in sottofondo morto col processo di prima:
//    task_notification «stopped» → init → result VUOTO, num_turns 0, SENZA eco,
//    e solo dopo la risposta al messaggio;
//  - turno A fermato per mandare B: il result interrotto di A (eco = uuid di A)
//    arriva quando B è già aperto.
// Ogni messaggio spinto porta un uuid; il CLI lo rimanda in
// user_message_uuid(s) sul result (anche dei comandi locali come /context).
function echoIds(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.user_message_uuids) && msg.user_message_uuids.length) return msg.user_message_uuids;
  if (typeof msg.user_message_uuid === 'string' && msg.user_message_uuid) return [msg.user_message_uuid];
  return null;
}
function resultIsForeign(turn, msg) {
  if (!turn || !turn._uuid) return false; // turno spontaneo o vecchio: come prima
  const ids = echoIds(msg);
  if (ids) return ids.indexOf(turn._uuid) === -1;
  // Nessuna eco: è altrui solo il result vuoto arrivato prima di qualunque
  // cosa di questo turno (il lavoro morto alla ripresa). Errori e CLI senza
  // eco chiudono come sempre: un turno non deve mai restare appeso.
  return !turn._bound && !turn._content && !msg.is_error && !String(msg.result || '').trim();
}

// --- SdkTurnProc: a ChildProcess-shaped handle for ONE turn -------------------
class SdkTurnProc extends EventEmitter {
  constructor(sdkSession) {
    super();
    this.sdkSession = sdkSession;
    this.pid = null;
    this._ownTasks = new Set(); // lavori in sottofondo nati in QUESTO turno (17/10)
    this._closed = false;
    this._userKilled = false;
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });

    let promptBuf = '';
    const self = this;
    this.stdin = new Writable({
      write(chunk, _enc, cb) { promptBuf += chunk.toString('utf8'); cb(); },
      final(cb) { self._fire(promptBuf); cb(); },
    });
  }

  // stdin end() -> deliver the prompt as this session's next turn.
  _fire(prompt) {
    if (this._closed) return;
    if (!this.sdkSession || this.sdkSession.dead) {
      this.emit('error', new Error('SDK session is not available'));
      this._finish(1);
      return;
    }
    this.sdkSession.pushTurn(this, prompt);
  }

  // Called by the warm session's consumer loop for each SDK message of THIS turn.
  _feed(sdkMsg) {
    if (this._closed) return;
    const s = this.sdkSession;
    if (this._holding && sdkMsg && opensTurn(sdkMsg) && !this._resumed) {
      this._resumed = true; // il modello è ripartito: si aspetta il suo result
      this._clearHoldTimers();
      notifyBg(s); // non più «in attesa»: il modello lavora di nuovo
    }
    // Il seguito si attacca allo stesso messaggio: un a-capo doppio fra la
    // frase «aspetto…» e la risposta, una volta sola per ogni ripresa.
    if (this._needSep && sdkMsg && sdkMsg.type === 'stream_event' && sdkMsg.event
        && sdkMsg.event.type === 'content_block_delta' && sdkMsg.event.delta
        && sdkMsg.event.delta.type === 'text_delta') {
      this._needSep = false;
      this._push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\n' } } });
    }
    if (this._uuid && sdkMsg) {
      const ids = echoIds(sdkMsg);
      if (ids && ids.indexOf(this._uuid) !== -1) this._bound = true;
      if (sdkMsg.type === 'assistant' || sdkMsg.type === 'stream_event') this._content = true;
    }
    if (sdkMsg && sdkMsg.type === 'result' && resultIsForeign(this, sdkMsg)) {
      // [08/11/2026] : il result di un ALTRO turno (lavoro morto alla
      // ripresa, turno fermato prima di questo) non chiude questo turno.
      console.log('[SDK-ENGINE]', s ? s.sessionId.slice(0, 8) : '?', 'result di un altro turno ignorato',
        '(' + (sdkMsg.subtype || '?') + ', num_turns ' + sdkMsg.num_turns + ')');
      return;
    }
    if (sdkMsg && sdkMsg.type === 'result') {
      if (!this._userKilled && waitedTasks(s, this).length) {
        // Turno «in attesa»: passa l'uso (freno dei token) ma non il testo
        // finale né la durata, che chiuderebbero il messaggio sul client.
        const held = Object.assign({}, sdkMsg);
        delete held.result;
        delete held.duration_ms;
        this._push(held);
        this._hold();
        return;
      }
      this._push(sdkMsg);
      this._finish(0); // result = turn end
      return;
    }
    this._push(sdkMsg);
  }

  _push(obj) {
    try { this.stdout.push(JSON.stringify(obj) + '\n'); } catch {}
  }

  _hold() {
    this._holding = true;
    this._resumed = false;
    this._needSep = true;
    this._clearHoldTimers();
    const s = this.sdkSession;
    const waited = waitedTasks(s, this);
    const long = waited.some((t) => /agent|workflow/.test(String(t.type || '')));
    const cap = long ? BG_HOLD_AGENT_MS : BG_HOLD_OTHER_MS;
    const which = waited.map((t) => t.id + (t.description ? ' «' + t.description + '»' : '')).join(', ');
    console.log('[SDK-ENGINE]', s ? s.sessionId.slice(0, 8) : '?', 'turno in attesa del background (tetto', Math.round(cap / 60000), 'min):', which);
    notifyBg(s);
    // Il modello ha smesso di parlare: un messaggio del proprietario in attesa può partire.
    if (s) emitTurnIdle(s.sessionId);
    this._holdCap = setTimeout(() => {
      if (this._closed || !this._holding || this._resumed) return;
      console.log('[SDK-ENGINE]', s ? s.sessionId.slice(0, 8) : '?', 'tetto dell\'attesa raggiunto: chiudo il messaggio');
      this._finish(0);
    }, cap);
    if (this._holdCap.unref) this._holdCap.unref();
    // Lavori già tutti finiti nel frattempo? Parte subito la grazia.
    if (!waited.length) this._armGrace();
  }

  // I lavori sono finiti: se il modello non riparte entro la grazia, si chiude.
  _armGrace() {
    if (!this._holding || this._resumed || this._closed) return;
    if (this._grace) clearTimeout(this._grace);
    this._grace = setTimeout(() => {
      if (this._closed || this._resumed) return;
      this._finish(0);
    }, BG_GRACE_MS);
    if (this._grace.unref) this._grace.unref();
  }

  _clearHoldTimers() {
    if (this._holdCap) { clearTimeout(this._holdCap); this._holdCap = null; }
    if (this._grace) { clearTimeout(this._grace); this._grace = null; }
  }

  // In attesa e il modello è fermo: non c'è niente da interrompere.
  isIdleHold() { return !!(this._holding && !this._resumed && !this._closed); }

  _finish(code) {
    if (this._closed) return;
    this._closed = true;
    this._clearHoldTimers();
    if (this.sdkSession && this.sdkSession.activeTurn === this) {
      this.sdkSession.activeTurn = null;
      this.sdkSession.onTurnEnd();
    }
    if (this._holding) notifyBg(this.sdkSession); // l'attesa è finita: la card lo sappia
    // Emit 'close' only after stdout drains — faithful to ChildProcess order, so
    // spawnStreamHandler processes the final `result` line BEFORE finishMessage.
    let emitted = false;
    const emitClose = () => {
      if (emitted) return;
      emitted = true;
      this.emit('exit', code, null);
      this.emit('close', code, null);
    };
    this.stdout.once('end', emitClose);
    setTimeout(emitClose, 3000).unref(); // safety net — never leave a turn unclosed
    try { this.stdout.push(null); } catch {}
    try { this.stderr.push(null); } catch {}
  }

  // ChildProcess.kill — stopMessage / killAllProcesses. Interrupts the turn but
  // keeps the warm session alive for the next message.
  kill(/* signal */) {
    const idleHold = this.isIdleHold();
    this._userKilled = true;
    // Turno in attesa col modello fermo: il CLI è a riposo, un interrupt non
    // ha niente da fermare — e i lavori in background devono continuare.
    if (this.sdkSession && !idleHold) this.sdkSession.interrupt();
    this._finish(0);
    return true;
  }
}

// --- SdkSession: one warm, persistent streaming-input query -------------------
class SdkSession {
  constructor({ sessionId, cwd, model, resume, appendSystemPrompt }) {
    this.sessionId = sessionId;
    this.cwd = cwd || process.cwd();
    this.model = model || null;
    this.appendSystemPrompt = appendSystemPrompt || null;
    this.dead = false;
    this.activeTurn = null;
    this.lastActivity = Date.now();
    this._idleTimer = null;
    this._freezeTimer = null;
    this._evicting = false;
    this._respawnAfterTurn = false; // deferred mode-change respawn
    this._error = null;
    this._input = makeInputQueue();
    this._query = null;
    this._aborter = new AbortController();
    // Lavori in background ancora vivi (livello, non bordi: si sostituisce a ogni
    // background_tasks_changed). Esclusi gli `ambient`, che non sono attività.
    this.bgTasks = [];
    this._armIdleTimer();
    this._start(resume || null);
  }

  async _start(resume) {
    try {
      const { query } = await getSdk();
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      const options = {
        cwd: this.cwd,
        env,
        includePartialMessages: true,
        // BYPASS PERMANENTE — deciso 2026-08-04, agenti fleet fidati, classifier rimosso dal path permessi.
        // permissionMode è FISSO a 'bypassPermissions': il SDK non delega più ad alcun
        // classifier "auto", quindi le sessioni non si congelano mai se il classifier è giù.
        // Env override resta possibile (CLAUDE_PERMISSION_MODE), ma senza env il default è bypass.
        permissionMode: process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',
        settingSources: ['user', 'project', 'local'],
        abortController: this._aborter,
        stderr: (d) => console.error('[SDK-ENGINE]', this.sessionId.slice(0, 8), String(d).trim()),
        // : il CLI e i suoi figli a nice +10 (spawnAgente).
        spawnClaudeCodeProcess: (o) => spawnAgente(o, (d) => console.error('[SDK-ENGINE]', this.sessionId.slice(0, 8), String(d).trim())),
      };
      if (this.model) options.model = this.model;
      if (resume) options.resume = resume;
      if (this.appendSystemPrompt) options.extraArgs = { 'append-system-prompt': this.appendSystemPrompt };
      this._query = query({ prompt: this._input.gen, options });
      this._consume();
    } catch (err) {
      this._error = err instanceof Error ? err : new Error(String(err));
      console.error('[SDK-ENGINE]', this.sessionId.slice(0, 8), 'start failed:', this._error.message);
      this._teardown();
    }
  }

  // The long-lived loop: route every SDK message to the active turn handle.
  async _consume() {
    try {
      for await (const msg of this._query) {
        if (this.dead) break;
        this._route(msg);
      }
    } catch (err) {
      if (!this._evicting) {
        this._error = err instanceof Error ? err : new Error(String(err));
        console.error('[SDK-ENGINE]', this.sessionId.slice(0, 8), 'warm query crashed:', this._error.message);
      }
    } finally {
      this._teardown();
    }
  }

  // Un messaggio dell'SDK: al turno aperto, oppure apre un turno spontaneo.
  _route(msg) {
    this.lastActivity = Date.now();
    if (msg && msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
      const live = (Array.isArray(msg.tasks) ? msg.tasks : []).filter((t) => t && !t.ambient);
      const known = new Set(this.bgTasks.map((t) => t.id));
      const before = this.bgTasks;
      this.bgTasks = live.map((t) => ({ id: t.task_id, type: t.task_type, description: t.description || '' }));
      // [29/10/2026] Chi esce dall'elenco senza «completed» è fermato: si
      // aspetta BG_DEAD_MS la notifica (l'ordine non è garantito), poi si conta.
      const nowIds = new Set(this.bgTasks.map((t) => t.id));
      for (const t of before) {
        if (nowIds.has(t.id) || (this._completedIds && this._completedIds.has(t.id))) continue;
        const timer = setTimeout(() => {
          if (this._completedIds && this._completedIds.has(t.id)) return;
          markStopped(this, t, 'sparito senza «completed»');
          notifyBg(this);
        }, BG_DEAD_MS);
        if (timer.unref) timer.unref();
      }
      // I lavori nuovi appartengono al turno aperto in questo momento (17/10).
      const turn = this.activeTurn && !this.activeTurn._closed ? this.activeTurn : null;
      if (turn && turn._ownTasks) {
        for (const t of this.bgTasks) if (!known.has(t.id)) turn._ownTasks.add(t.id);
      }
      if (this._expiredTasks) {
        const liveIds = new Set(this.bgTasks.map((t) => t.id));
        for (const id of [...this._expiredTasks]) if (!liveIds.has(id)) this._expiredTasks.delete(id);
      }
      if (!this.bgTasks.length) this._armIdleTimer(); // l'ultimo è finito: riparte il conto dell'ozio
      if (turn && turn._holding && !waitedTasks(this, turn).length) {
        // Fermati dal tasto del proprietario: il modello non ripartirà per un lavoro
        // fermato, la grazia sarebbe solo 20 s di card ferma. Si chiude subito.
        if (this._stopRequested && !this.bgTasks.length && !turn._resumed) turn._finish(0);
        else turn._armGrace();
      }
      if (!this.bgTasks.length) this._stopRequested = false;
      notifyBg(this);
    }
    if (msg && msg.type === 'system' && msg.subtype === 'task_notification' && msg.task_id) {
      if (msg.status === 'completed') {
        if (!this._completedIds) this._completedIds = new Set();
        this._completedIds.add(msg.task_id);
      } else if (msg.status === 'stopped' || msg.status === 'failed') {
        const t = (this.bgTasks || []).find((x) => x.id === msg.task_id) || { id: msg.task_id, description: msg.summary || '' };
        markStopped(this, t, msg.status);
        notifyBg(this);
      }
    }
    if (msg && msg.type === 'system' && msg.subtype === 'task_updated' && msg.task_id && msg.patch
        && (msg.patch.status === 'killed' || msg.patch.status === 'failed')) {
      const t = (this.bgTasks || []).find((x) => x.id === msg.task_id) || { id: msg.task_id, description: msg.patch.description || '' };
      markStopped(this, t, msg.patch.status);
      notifyBg(this);
    }
    if (msg && msg.type === 'user') noteMovedToBackground(this, msg);
    if (!this.activeTurn && !this._evicting && opensTurn(msg) && _unsolicitedHandler) {
      const turn = new SdkTurnProc(this);
      turn._unsolicited = true;
      this.activeTurn = turn;
      let adopted = false;
      try { adopted = _unsolicitedHandler(this.sessionId, turn) === true; } catch (e) {
        console.error('[SDK-ENGINE]', this.sessionId.slice(0, 8), 'unsolicited handler failed:', e && e.message);
      }
      if (!adopted) {
        this.activeTurn = null;
        turn._closed = true;
      } else {
        console.log('[SDK-ENGINE]', this.sessionId.slice(0, 8), 'turno spontaneo (lavoro in background finito)');
        this._armIdleTimer();
      }
    }
    if (this.activeTurn) this.activeTurn._feed(msg);
  }

  // Deliver a user turn into the warm query.
  pushTurn(turnProc, promptText) {
    if (this.dead) { turnProc._finish(1); return; }
    if (this.activeTurn && !this.activeTurn._closed) this.activeTurn._finish(1); // defensive
    this.activeTurn = turnProc;
    this.lastActivity = Date.now();
    this._armIdleTimer();
    this._armFreezeWatch();
    // [08/11/2026] : l'uuid lega il result a QUESTO turno (resultIsForeign).
    turnProc._uuid = crypto.randomUUID();
    this._input.push({
      type: 'user',
      message: { role: 'user', content: promptText },
      parent_tool_use_id: null,
      uuid: turnProc._uuid,
    });
  }

  // [11/11/2026 ] Un messaggio del proprietario DENTRO il turno in corso: priority 'next' = il CLI lo piega
  // alla prossima pausa fra due strumenti, senza interrompere né aprire un turno (activeTurn resta quello).
  foldIn(promptText) {
    if (this.dead || !this.activeTurn || this.activeTurn._closed) return false;
    this.lastActivity = Date.now();
    this._input.push({
      type: 'user',
      message: { role: 'user', content: promptText },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      priority: 'next',
    });
    return true;
  }

  onTurnEnd() {
    this.lastActivity = Date.now();
    this._clearFreezeWatch(); // turn is over — nothing to watch for a hang
    this._armIdleTimer(); // restart the idle countdown now that we're between turns
    if (this._respawnAfterTurn) {
      this._respawnAfterTurn = false;
      this.evict('mode-change-deferred'); // turn done → now safe to respawn
    }
  }

  // [2026-09-10] Il cane da guardia non si arma più: il suo unico destinatario
  // (classifier-fallback) è stato tolto. Il metodo resta come no-op perché è
  // chiamato dal ciclo del turno in due punti; svuotarlo è meno invasivo che
  // rincorrere i chiamanti, e _clearFreezeWatch resta corretto comunque.
  _armFreezeWatch() {
    this._clearFreezeWatch();
  }

  _clearFreezeWatch() {
    if (this._freezeTimer) { clearInterval(this._freezeTimer); this._freezeTimer = null; }
  }

  // Interrupt the current turn WITHOUT killing the warm session.
  interrupt() {
    if (this._query && typeof this._query.interrupt === 'function') {
      Promise.resolve(this._query.interrupt()).catch((e) =>
        console.error('[SDK-ENGINE]', this.sessionId.slice(0, 8), 'interrupt failed:', e && e.message));
    }
  }

  _armIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this.activeTurn) { this._armIdleTimer(); return; } // turn running — defer
      // Un lavoro in background è ancora vivo: sfrattare la sessione UCCIDEREBBE
      // quel lavoro (abort del CLI) e il suo turno di risposta non nascerebbe mai.
      if (this.bgTasks && this.bgTasks.length) { this._armIdleTimer(); return; }
      this.evict('idle');
    }, SDK_SESSION_IDLE_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  // Tear the warm session down (idle, cap, explicit close, or shutdown).
  evict(reason) {
    if (this.dead) return;
    console.log('[SDK-ENGINE]', this.sessionId.slice(0, 8), 'evict:', reason);
    this._evicting = true;
    try { this._input.end(); } catch {}
    try { this._aborter.abort(); } catch {}
    this._teardown();
  }

  // Classifier-fallback flip: must respawn to pick up the new permissionMode,
  // but MUST NOT truncate a healthy in-flight turn. Idle OR frozen → evict now
  // (frozen is stuck anyway, that's the whole point). Healthy streaming turn →
  // flag to respawn at onTurnEnd so the answer + its <options> tail finish first.
  evictForModeChange() {
    if (this.dead) return;
    const active = this.activeTurn && !this.activeTurn._closed;
    const frozen = active && (Date.now() - this.lastActivity) >= FREEZE_WATCH_MS;
    if (frozen) {
      // The turn the owner is actually waiting on is genuinely stuck on the dead
      // classifier's permission verdict. Just aborting it (what happened before)
      // finalizes a TRUNCATED half-message and drops its <options>/UI-question
      // tail — the owner then has to re-type. Tag it so stream-handler RE-RUNS the exact
      // same turn in the now-bypass mode; it completes unblocked. 2c93cc3 only
      // spared OTHER healthy sessions from the flip — the frozen trigger itself
      // still truncated + silently lost its turn until this.
      this.activeTurn._modeChangeRetry = true;
      this.evict('mode-change');
      return;
    }
    if (!active) { this.evict('mode-change'); return; }
    this._respawnAfterTurn = true;
  }

  _teardown() {
    if (this.dead) return;
    this.dead = true;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this._clearFreezeWatch();
    if (registry.get(this.sessionId) === this) registry.delete(this.sessionId);
    if (this.bgTasks && this.bgTasks.length) {
      // La sessione muore coi suoi lavori: la card non deve restare «sta lavorando»,
      // e quei lavori sono morti con lei: la scheda li conta fermati (29/10).
      for (const t of this.bgTasks) markStopped(this, t, 'sessione chiusa');
      this.bgTasks = [];
      if (_backgroundHandler) { try { _backgroundHandler(this.sessionId, 0); } catch {} }
    }
    const turn = this.activeTurn;
    if (turn && !turn._closed) {
      if (this._error && !this._evicting) turn.emit('error', this._error);
      turn._finish(1); // never leave an in-flight turn hanging
    }
  }
}

// --- public API ---------------------------------------------------------------

// Enforce the concurrent-warm-session cap by evicting the least-recently-used.
function enforceMaxWarm() {
  while (registry.size >= SDK_MAX_WARM) {
    // Prima scelta: chi non ha né un turno aperto né lavori in background vivi.
    // Solo se TUTTE sono occupate si ripiega sul vecchio LRU puro (il tetto resta un tetto).
    const busy = (s) => !!(s.activeTurn || (s.bgTasks && s.bgTasks.length));
    let victim = null;
    for (const s of registry.values()) {
      if (busy(s)) continue;
      if (!victim || s.lastActivity < victim.lastActivity) victim = s;
    }
    if (!victim) {
      for (const s of registry.values()) {
        if (!victim || s.lastActivity < victim.lastActivity) victim = s;
      }
    }
    if (!victim) break;
    victim.evict('max-warm-cap');
  }
}

// Get-or-create the warm session for a sessionId and return a turn handle.
// Called by session-manager._spawnClaude (SDK branch).
function startTurn({ sessionId, cwd, model, resume, appendSystemPrompt }) {
  let warm = registry.get(sessionId);
  if (warm && warm.dead) warm = null;
  // MODEL RE-PIN (2026-08-16): a warm session is glued to the model it was
  // created with (options.model at query start) — reusing it after the caller
  // asks for a DIFFERENT model (chip re-pin, or a fallback-ladder retry) would
  // silently run the turn on the stale model while the card claims the new one.
  // Evict + recreate: `resume` carries the transcript over, so the conversation
  // continues seamlessly on the requested model. Safe at turn START — there is
  // no healthy in-flight turn at this point (a new turn is only spawned for a
  // new user message; pushTurn's defensive finish covers the pathological case).
  if (warm && model && warm.model !== model) {
    warm.evict('model-changed');
    warm = null;
  }
  if (!warm) {
    enforceMaxWarm();
    warm = new SdkSession({ sessionId, cwd, model, resume, appendSystemPrompt });
    registry.set(sessionId, warm);
  }
  return new SdkTurnProc(warm);
}

// Explicit close of one session (session-manager.close).
function evictWarmSession(sessionId) {
  const s = registry.get(sessionId);
  if (s) s.evict('session-closed');
}

// Tear down every warm session — server shutdown / restart (no orphans).
async function shutdownAllWarm() {
  const all = [...registry.values()];
  for (const s of all) { try { s.evict('shutdown'); } catch {} }
  if (all.length) await new Promise((r) => setTimeout(r, 200)); // let aborts land
}

// Re-apply a permission-mode change WITHOUT aborting healthy in-flight turns.
// (shutdownAllWarm stays as-is for real shutdown/orphan-guard.)
async function respawnForModeChange() {
  for (const s of [...registry.values()]) { try { s.evictForModeChange(); } catch {} }
}

function warmCount() {
  return registry.size;
}

// Il turno vivo di questa sessione è «in attesa» col modello fermo?
function isIdleHold(sessionId) {
  const s = registry.get(sessionId);
  return !!(s && !s.dead && s.activeTurn && typeof s.activeTurn.isIdleHold === 'function' && s.activeTurn.isIdleHold());
}

// Quanti lavori in background vivi ha questa sessione (0 se non è calda).
function backgroundTaskCount(sessionId) {
  const s = registry.get(sessionId);
  return (s && !s.dead && s.bgTasks) ? s.bgTasks.length : 0;
}

// [17/10/2026] Cosa vede la card: quanti lavori, se il turno li sta aspettando, quali.
// [29/10/2026] + quanti sono stati FERMATI (stopped) e quali (stoppedTasks).
function backgroundInfo(sessionId) {
  const m = stoppedBySession.get(sessionId);
  const stoppedTasks = m ? [...m.values()] : [];
  const s = registry.get(sessionId);
  if (!s || s.dead) return { count: 0, waiting: false, tasks: [], stopped: stoppedTasks.length, stoppedTasks };
  const turn = s.activeTurn;
  const waiting = !!(turn && typeof turn.isIdleHold === 'function' && turn.isIdleHold());
  const tasks = (s.bgTasks || []).map((t) => ({ id: t.id, description: t.description || '', type: t.type || '' }));
  return { count: tasks.length, waiting, tasks, stopped: stoppedTasks.length, stoppedTasks };
}

// [29/10/2026] Il prossimo messaggio del proprietario: il conto dei fermati riparte da zero.
function clearStopped(sessionId) {
  if (!stoppedBySession.has(sessionId)) return;
  stoppedBySession.delete(sessionId);
  const s = registry.get(sessionId);
  if (s && !s.dead) { notifyBg(s); return; }
  if (_backgroundHandler) { try { _backgroundHandler(sessionId, 0); } catch {} }
}

// [29/10/2026] il proprietario scrive mentre il modello PARLA e ci sono lavori in
// sottofondo vivi: interrompere il turno (interrupt del CLI) li uccide tutti —
// misurato il 28/10, 6 aiutanti «interrupted» nello stesso millisecondo del
// turno. Allora il messaggio aspetta che il modello smetta di parlare.
// A modello fermo (turno in attesa) lo stop non interrompe niente: non serve aspettare.
function foldIntoTurn(sessionId, promptText) {
  const s = registry.get(sessionId);
  if (!s || s.dead || typeof s.foldIn !== 'function') return false;
  return s.foldIn(promptText);
}

function interjectionMustWait(sessionId) {
  const s = registry.get(sessionId);
  if (!s || s.dead || !s.bgTasks || !s.bgTasks.length) return false;
  const turn = s.activeTurn;
  if (!turn || turn._closed) return false;
  return !(typeof turn.isIdleHold === 'function' && turn.isIdleHold());
}

// [17/10/2026] Il tasto della card: ferma ogni lavoro in sottofondo vivo della
// sessione (stop_task del CLI). Ritorna quanti ne ha chiesto di fermare; il
// background_tasks_changed che segue aggiorna la card e chiude l'attesa.
function stopBackgroundTasks(sessionId) {
  const s = registry.get(sessionId);
  if (!s || s.dead || !s._query || typeof s._query.stopTask !== 'function') return 0;
  const ids = (s.bgTasks || []).map((t) => t.id);
  if (ids.length) s._stopRequested = true;
  for (const id of ids) {
    console.log('[SDK-ENGINE]', s.sessionId.slice(0, 8), 'fermo il lavoro in sottofondo', id, '(tasto dell\'utente)');
    const fail = (e) => console.error('[SDK-ENGINE]', s.sessionId.slice(0, 8), 'stop del lavoro', id, 'fallito:', e && e.message);
    try { Promise.resolve(s._query.stopTask(id)).catch(fail); } catch (e) { fail(e); }
  }
  return ids.length;
}

// Defensive orphan guard: abort warm queries if the process is signalled/exits.
// index.js's gracefulShutdown also runs; multiple listeners coexist fine.
let _guardsInstalled = false;
function installShutdownGuards() {
  if (_guardsInstalled) return;
  _guardsInstalled = true;
  const handler = () => {
    for (const s of [...registry.values()]) { try { s.evict('process-signal'); } catch {} }
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
  process.once('exit', handler);
}
installShutdownGuards();

module.exports = {
  startTurn, evictWarmSession, shutdownAllWarm, respawnForModeChange, warmCount,
  backgroundTaskCount, isIdleHold, setUnsolicitedTurnHandler, setBackgroundTasksHandler, opensTurn,
  backgroundInfo, stopBackgroundTasks, clearStopped, interjectionMustWait, foldIntoTurn, onTurnIdle,
  SdkSession, SdkTurnProc, FREEZE_WATCH_MS, spawnAgente, AGENT_NICE,
  _setSdkPerProva: (m) => { _sdkModule = m; }, // solo per tests/agenti-non-affamano-whisper.test.js
  _registry: registry, // solo per le prove pure (tests/sdk-attesa-solo-del-turno.test.js)
};
