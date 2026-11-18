'use strict';

// =============================================================================
// MODEL RESOLUTION + FALLBACK LADDER (2026-08-15)
// =============================================================================
// Before this module, session-manager pinned every spawned session to a
// hardcoded model (env CLAUDE_MODEL || 'claude-opus-4-8'), ignoring the default
// the owner picks with the interactive /model command (saved as the top-level
// "model" field of ~/.claude/settings.json).
//
// Exports:
//   resolveModelChain(pinnedModel?) — the ordered list of models to try for ONE
//     spawn.
//     Primary = pinnedModel (the SESSION'S own pin, 2026-08-16 — fixed at
//               creation or via the topbar chip picker; when present it beats
//               everything, so a later terminal /model change NEVER retargets
//               an existing session)
//             → settings.json "model" (the interactive /model pick — read at
//               SPAWN time, never cached at module load, so changing /model
//               applies to new sessions without a server restart). This is the
//               USER'S default for NEW sessions and wins over env.
//             → env CLAUDE_MODEL (a secondary pin, only when there is no /model
//               pick — e.g. a host without a settings.json). NOTE: it is
//               deliberately NOT first — the Claude Code harness exports
//               CLAUDE_MODEL=claude-opus-4-8 into interactive sessions, and a
//               `pm2 restart --update-env` used to leak that ambient value into
//               the server, silently overriding /model. Settings-first kills it.
//             → 'claude-opus-4-8' (the legacy static pin).
//     The chain appends the static fallbacks ['claude-opus-5',
//     'claude-opus-4-8'], deduped preserving order.
//   ModelFallbackProc — a ChildProcess-shaped wrapper (same duck-typing
//     precedent as RemoteProc / PeerProc / SdkTurnProc) that spawns the first
//     model and, if the attempt dies with a model-unavailable / usage-limit /
//     quota error BEFORE producing any assistant output, transparently retries
//     with the next model in the chain — replaying the buffered stdin prompt.
//     stream-handler sees ONE proc: stdout/stderr forward live (streaming
//     preserved), 'close' fires only when an attempt succeeds or the chain is
//     exhausted, so a mid-ladder failure never finalizes the turn early.
// =============================================================================

const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_DEFAULT_MODEL = 'claude-opus-4-8';
const STATIC_FALLBACK_MODELS = ['claude-opus-5', 'claude-opus-4-8'];

// The retry TRIGGER. An attempt is retried with the next model ONLY when ALL of:
//   1. exit code is a non-zero number (null = killed by signal → never retry);
//   2. no user kill / no classifier mode-change retry is pending on the attempt;
//   3. the attempt produced NO assistant output (a '"type":"assistant"' line on
//      stdout) — the ladder is for STARTUP failures, never for re-running a turn
//      that already streamed an answer;
//   4. the combined error text (stderr, 4KB stdout tail — where `claude -p
//      --output-format stream-json` puts its error `result` line —, 'error'
//      event messages, and the SDK warm-session's stored _error) matches:
const FALLBACK_ERROR_RE = new RegExp([
  'not_found_error',                                      // Anthropic API 404 on a bad model id
  'model_not_found',
  'no such model',
  '(?:unknown|invalid|unsupported)[ _-]model',
  'model[^\\n]{0,60}(?:not (?:found|available|supported)|unavailable)',
  'usage limit reached',                                  // CLI "Claude AI usage limit reached|<ts>"
  'rate[ _-]?limit(?:_error|ed)?',                        // rate_limit_error / rate-limited
  'quota[^\\n]{0,30}(?:exceeded|exhausted|reached)',
  'insufficient[ _-]quota',
  'out of quota',
  'credit balance is too low',                            // Anthropic billing exhaustion
  'overloaded_error',                                     // Anthropic 529 — model tier saturated
].join('|'), 'i');

// Read the interactive /model pick. Failure of ANY kind (missing file, bad
// JSON, wrong shape) falls through to null — never throws into the spawn path.
function readSettingsModel() {
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed.model === 'string' && parsed.model.trim()) {
      return parsed.model.trim();
    }
  } catch {}
  return null;
}

// FAMIGLIE (2026-08-16, round #4): the chip menu offers FAMILIES, not
// versioned ids — Fable / Opus / Sonnet / Haiku. A family pin resolves at
// EVERY spawn to the newest model of that family available right now, so a
// future Fable 6 / Opus 9 rides in with zero app changes.
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

// VIA HAIKU DAL MENU — E VIA SONNET: the
// families a human can CLICK — chip picker + spawn selector. Both are
// deliberately absent: no real use case for picking either by hand. Sonnet went
// after the two-model experiment of 19/8, where the same "read everything" job
// was run twice: Sonnet sourced its three headline findings from DOCUMENTS
// instead of the disk and all three failed verification (a password it called
// "exposed for 83 days" was never in git; 47 unpushed commits were 96; a third
// item was two hours stale). Not a bad model — the wrong model for a fleet whose
// whole job is judging messy real systems, where one confident wrong sentence
// costs an afternoon.
// They stay INTACT everywhere else — MODEL_FAMILIES still contains both, so
// familyOf / displayModelFor / resolveFamilyModel keep resolving a 'haiku' or
// 'sonnet' pin (a session already pinned to one, or the internal automatic
// fallback ladder) exactly as before. Only the clickable options get fewer.
const SELECTABLE_FAMILIES = ['fable', 'opus'];

// Best-known NEWEST precise id per family — used ONLY to give the chip/card an
// immediate precise label the instant a family is picked (round #5, 1a: click
// Opus → read "Opus 5" AT ONCE), before the turn's `system:init` line stamps the
// real running id. The SPAWN itself still hands the CLI the bare family alias
// (resolveFamilyModel), so if a newer release the CLI already knows about ships,
// it rides in and noteRunningModel corrects this label from the real process.
// Keep in step with the CLI's newest per family (probed 2026-08-16:
// fable→claude-fable-5, opus→claude-opus-5, sonnet→claude-sonnet-4-6,
// haiku→claude-haiku-4-5-20251001). 2026-09-27: opus → claude-opus-5-5, il
// modello che il proprietario ha scelto col /model il 26/09 e che il vivo già usa (deploy
// log 26/09: «model sync: claude-opus-5-5»). claude-opus-5 resta nella scala.
const FAMILY_NEWEST = {
  fable: 'claude-fable-5[1m]',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

// 'claude-fable-5[1m]' → 'fable'; 'sonnet' → 'sonnet'; junk → null.
function familyOf(id) {
  if (!id || typeof id !== 'string') return null;
  const m = id.toLowerCase().match(/^(?:claude-)?([a-z]+)/);
  return m ? m[1] : null;
}

// The PRECISE id to DISPLAY on the chip/card for a pin. A bare family resolves
// to a real versioned name at once (round #5, 1a): the settings.json /model pick
// if it's the same family (it carries the exact tier, e.g. the 1M window), else
// the best-known newest for that family. A precise id passes through verbatim.
// Never returns a bare family for a known family — the card always shows a real
// model name. NOTE: this is DISPLAY only; resolveFamilyModel drives the spawn.
function displayModelFor(model) {
  const raw = (typeof model === 'string' ? model.trim() : '');
  const fam = raw.toLowerCase();
  if (MODEL_FAMILIES.includes(fam)) {
    const s = readSettingsModel();
    if (s && familyOf(s) === fam) return s;
    return FAMILY_NEWEST[fam] || raw;
  }
  return raw;
}

// Resolve a bare family name to the newest model of that family, re-evaluated
// per spawn:
//   1. the settings.json /model pick, IF same family — it carries the exact
//      tier (e.g. claude-fable-5[1m], the 1M window the bare alias would lose)
//      and gets updated the day the owner moves to a new release;
//   2. env CLAUDE_MODEL, if same family;
//   3. the bare family name itself — the CLI/SDK resolves the alias to ITS
//      newest known model (probed 2026-08-16: --model fable → claude-fable-5,
//      --model haiku → claude-haiku-4-5-20251001), so new releases arrive
//      with a CLI update, no app change. The fallback ladder guards the rest.
function resolveFamilyModel(family) {
  const s = readSettingsModel();
  if (s && familyOf(s) === family) return s; // the user's exact /model tier pick
  // Round #5 (1b) — return the PRECISE newest id for the family, NOT the bare
  // alias. Two reasons:
  //   • the SDK and CLI resolve a bare alias DIFFERENTLY (probed 2026-08-16 on
  //     REAL processes: CLI --model opus → claude-opus-5, but the SDK warm
  //     engine → claude-opus-4-7). Production runs the SDK engine, so the bare
  //     alias would silently give il proprietario an OLDER opus — only a precise id
  //     guarantees the SAME model on both engines and every device;
  //   • env CLAUDE_MODEL is deliberately NOT consulted — the Claude Code harness
  //     leaks CLAUDE_MODEL=claude-opus-4-8 (opus family), which used to pin the
  //     'opus' family to the OLD opus (the "Opus 4-8 flashes" bug). The 4-8
  //     stays ONLY in the fallback ladder.
  // FAMILY_NEWEST is the single line to bump the day a new release ships — that
  // is also how the owner immediately SEES the new version on the chip.
  if (FAMILY_NEWEST[family]) return FAMILY_NEWEST[family];
  return family;
}

// Ordered, deduped list of models to try for one spawn. Called at SPAWN time.
// `pinnedModel` (optional) is the session's own pin — when a non-blank string
// it wins over settings/env, so a pinned session ignores later /model changes.
// A bare FAMILY pin ('fable', 'sonnet', …) expands here, per spawn, to that
// family's newest model — see resolveFamilyModel.
function resolveModelChain(pinnedModel) {
  let pin = (typeof pinnedModel === 'string' && pinnedModel.trim()) || null;
  if (pin && MODEL_FAMILIES.includes(pin.toLowerCase())) {
    pin = resolveFamilyModel(pin.toLowerCase());
  }
  const primary = pin
    || readSettingsModel()
    || process.env.CLAUDE_MODEL
    || LEGACY_DEFAULT_MODEL;
  const chain = [];
  for (const m of [primary, ...STATIC_FALLBACK_MODELS]) {
    if (!chain.includes(m)) chain.push(m);
  }
  return chain;
}

// CHIP MODELLO (2026-08-16; famiglie round #4): what the topbar chip picker
// AND the Super-Agent spawn selector offer — FAMILIES, no version numbers.
// Labels are derived client-side (prettifyModelId: 'fable' → 'Fable').
// 2026-08-16 (round #6): Haiku dropped from the clickable set — see
// SELECTABLE_FAMILIES. The fallback ladder is untouched.
function listSelectableModels() {
  return SELECTABLE_FAMILIES.slice();
}

class ModelFallbackProc extends EventEmitter {
  // spawnAttempt(model) → a ChildProcess-shaped proc (real spawn or SdkTurnProc).
  // onModelChange(model) — optional; called when a retry switches to the next
  // model, so the caller can keep session.model in sync with what's running.
  constructor({ models, spawnAttempt, onModelChange }) {
    super();
    this._models = models && models.length ? models : [LEGACY_DEFAULT_MODEL];
    this._idx = 0;
    this._spawnAttempt = spawnAttempt;
    this._onModelChange = onModelChange || null;
    this._closed = false;
    this._killRequested = false;
    this._userKilled = false; // session-manager sets this directly pre-kill (stopMessage)
    this._current = null;
    this.pid = null;

    // Same Readable-push pattern as SdkTurnProc: with 'data' listeners attached
    // (flowing mode) a push forwards synchronously, so the inner proc's
    // data-before-close ordering is preserved through the wrapper.
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });

    // stdin facade: buffer everything so a retry can replay the exact prompt,
    // while forwarding live to the current attempt.
    this._stdinChunks = [];
    this._stdinEnded = false;
    const self = this;
    this.stdin = new Writable({
      write(chunk, _enc, cb) {
        self._stdinChunks.push(Buffer.from(chunk));
        try {
          if (self._current && self._current.stdin) self._current.stdin.write(chunk);
        } catch {}
        cb();
      },
      final(cb) {
        self._stdinEnded = true;
        try {
          if (self._current && self._current.stdin && self._current.stdin.end) {
            self._current.stdin.end();
          }
        } catch {}
        cb();
      },
    });

    this._attempt();
  }

  _attempt() {
    const model = this._models[this._idx];
    let att;
    try {
      att = this._spawnAttempt(model);
    } catch (err) {
      this._settleAttempt({
        code: 1,
        signal: null,
        att: null,
        sawAssistant: false,
        errText: (err && err.message) || String(err),
        lastErr: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    this._current = att;
    if (att.pid) this.pid = att.pid;

    let errText = '';
    let stdoutTail = '';
    let sawAssistant = false;
    let lastErr = null;
    let settled = false;

    att.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      if (!sawAssistant && s.includes('"type":"assistant"')) sawAssistant = true;
      stdoutTail = (stdoutTail + s).slice(-4096);
      try { this.stdout.push(d); } catch {}
    });
    att.stderr.on('data', (d) => {
      errText = (errText + d.toString('utf8')).slice(-8192);
      try { this.stderr.push(d); } catch {}
    });

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      // SDK path: the warm session's fatal error lives on sdkSession._error
      // (console-only otherwise) — fold it into the detection text.
      let sdkErr = '';
      try {
        if (att.sdkSession && att.sdkSession._error) sdkErr = att.sdkSession._error.message || '';
      } catch {}
      this._settleAttempt({
        code,
        signal,
        att,
        sawAssistant,
        errText: [errText, stdoutTail, sdkErr].filter(Boolean).join('\n'),
        lastErr,
      });
    };

    att.on('error', (err) => {
      lastErr = err instanceof Error ? err : new Error(String(err));
      errText += '\n' + lastErr.message;
      // A spawn-level failure (no pid) may never emit 'close' — synthesize one.
      if (!att.pid) setTimeout(() => finish(1, null), 250);
    });
    att.on('close', (code, signal) => finish(code, signal));
  }

  _settleAttempt({ code, signal, att, sawAssistant, errText, lastErr }) {
    if (this._closed) return;
    const killed = this._killRequested || this._userKilled || (att && att._userKilled);
    const modeRetry = !!(att && att._modeChangeRetry);
    const hasNext = this._idx + 1 < this._models.length;
    const modelError = typeof code === 'number' && code !== 0
      && FALLBACK_ERROR_RE.test(errText || '');

    if (!killed && !modeRetry && !sawAssistant && modelError && hasNext) {
      const failed = this._models[this._idx];
      this._idx += 1;
      const next = this._models[this._idx];
      console.log(`[model-fallback] ${failed} non disponibile → riprovo con ${next}`);
      try { if (this._onModelChange) this._onModelChange(next); } catch {}
      this._attempt();
      // Replay the buffered prompt into the fresh attempt.
      try {
        if (this._current && this._current.stdin) {
          for (const c of this._stdinChunks) this._current.stdin.write(c);
          if (this._stdinEnded && this._current.stdin.end) this._current.stdin.end();
        }
      } catch (err) {
        console.error('[model-fallback] stdin replay failed:', err && err.message);
      }
      return;
    }

    // Final — propagate exactly what the inner attempt produced. Mirror the
    // flags stream-handler reads off the proc BEFORE emitting 'close'.
    this._closed = true;
    if (att && att._userKilled) this._userKilled = true;
    if (modeRetry) this._modeChangeRetry = true;
    if (lastErr) this.emit('error', lastErr);
    try { this.stdout.push(null); } catch {}
    try { this.stderr.push(null); } catch {}
    this.emit('exit', code, signal || null);
    this.emit('close', code, signal || null);
  }

  // ChildProcess.kill — forward only; do NOT set _userKilled here (a plain
  // SIGTERM at shutdown must keep today's semantics where 'close' fires without
  // the flag). stopMessage sets proc._userKilled = true itself before killing.
  kill(signal) {
    this._killRequested = true;
    try {
      if (this._current && this._current.kill) return this._current.kill(signal);
    } catch {}
    return true;
  }
}

module.exports = {
  resolveModelChain,
  listSelectableModels,
  familyOf,
  displayModelFor,
  MODEL_FAMILIES,
  SELECTABLE_FAMILIES,
  FAMILY_NEWEST,
  ModelFallbackProc,
  FALLBACK_ERROR_RE,
};
