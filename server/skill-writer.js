'use strict';
/**
 * Self-writing skills — Odysseus steal #3 (adapted to Node).
 *
 * After the assistant does REAL multi-step work in a chat, it writes itself a
 * reusable skill (a markdown recipe: when-to-use + procedure + pitfalls +
 * verification) as a DRAFT, so next time the same kind of job comes up it can
 * run the recipe instead of re-figuring it out.
 *
 * Design notes (mirrors server/memory-engine.js — the proven template):
 *  - Cheap `haiku` one-shot, fully wrapped so it can NEVER throw into the chat
 *    path. Resolves null on any error.
 *  - Driven off the existing `onResponseComplete` plugin hook (see
 *    plugins/auto-skills) — fire-and-forget, off the live turn.
 *  - Drafts land OUTSIDE the repo (~/.151machine/auto-skills/) — NEVER in the
 *    live ~/.claude/commands/ set (a flaky auto-skill must not become a live
 *    command; Write there is blocked anyway). the owner reviews + promotes manually.
 *  - GATED by the SKILLS_AUTO env flag. Unset = fully inert. Turn on exactly
 *    like MEMORY_AUTO: set SKILLS_AUTO=1 in ecosystem.linux.config.js, then
 *    `pm2 restart ecosystem.linux.config.js --only 151-machine`. Roll back =
 *    delete the line + restart.
 *
 * THE DISCIPLINE (the whole point): a skill that captures junk is worse than
 * none. We fire ONLY after genuine multi-step agent work (tool_calls>=2 OR
 * agent_rounds>=2), require the extractor to return a confident result
 * (confidence>=0.6), and let it return bare `null` for one-offs / plain Q&A /
 * failed turns — which produces NOTHING.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { oneShotArgs } = require('./oneshot-args');

const CLAUDE_BIN = 'claude';
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.151machine', 'auto-skills');
const USAGE_FILE = path.join(SKILLS_DIR, '_usage.json');
// Hand-built team/command skills live here (PC-only — SKILLS_AUTO is PC-only). Their
// names are fed to the extractor so it never re-derives a recipe a team already encodes.
const COMMANDS_DIR = process.env.COMMANDS_DIR || path.join(os.homedir(), '.claude', 'commands');

const CONTEXT_MSGS = 12;        // recent messages handed to the extractor
const MIN_TOOL_CALLS = 2;       // gate: real multi-step work
const MIN_AGENT_ROUNDS = 2;     // gate: real multi-step work
const MIN_CONFIDENCE = 0.6;     // below this, write nothing
const COOLDOWN_ROUNDS = parseInt(process.env.SKILLS_COOLDOWN || '3', 10); // min new turns between write attempts per session
const MAX_INDEX = 40;           // skills listed in the injected index
const JACCARD_DUP = 0.6;        // near-duplicate title threshold

// ---- economic guards (audit 2026-08-20, work/ladri-utilizzo-21-08.md) -------
// Above this many ACTIVE drafts the dedup surface is dense enough that new
// titles essentially always collide — 102 drafts produced 37 calls / 0 writes.
const MAX_LIBRARY = parseInt(process.env.SKILLS_MAX_LIBRARY || '100', 10);
// Consecutive fruitless attempts before a session stops proposing at all.
const MAX_MISSES = parseInt(process.env.SKILLS_MAX_MISSES || '2', 10);
// Cap on the remembered dead-window fingerprints (unbounded Set = slow leak).
const MAX_FINGERPRINTS = 500;

const _turnCounts = new Map();   // sessionId -> completed-turn count (in-process)
const _lastAttempt = new Map();  // sessionId -> turn count at last write attempt
const _misses = new Map();       // sessionId -> consecutive attempts that wrote nothing
const _deadFingerprints = new Set(); // conversation windows already known to yield nothing
let _libraryWarned = false;      // log the saturation line once, not every turn

// Cheap stable hash of a conversation window. Not cryptographic — it only has to
// recognise "we already asked about exactly this and got nothing".
function _fingerprint(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${h1.toString(36)}:${h2.toString(36)}:${str.length}`;
}

// Record a fruitless attempt: remember the window, bump the session's breaker.
function _recordMiss(sessionId, fp) {
  if (fp) {
    if (_deadFingerprints.size >= MAX_FINGERPRINTS) {
      // cheap FIFO trim — drop the oldest quarter
      let drop = Math.ceil(MAX_FINGERPRINTS / 4);
      for (const k of _deadFingerprints) { _deadFingerprints.delete(k); if (--drop <= 0) break; }
    }
    _deadFingerprints.add(fp);
  }
  _misses.set(sessionId, (_misses.get(sessionId) || 0) + 1);
}

// Active (non-archived) drafts currently on disk.
function _activeDraftCount() {
  try {
    const usage = _loadUsage();
    return _listSlugs().filter(slug => (usage[slug] || {}).state !== 'archived').length;
  } catch { return 0; }
}

function _ensureDir() { try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch {} }

function _slugify(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled-skill';
}

function _tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function _jaccard(a, b) {
  const A = new Set(_tokens(a)), B = new Set(_tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---- gate -----------------------------------------------------------------

/**
 * True only if the recent conversation shows genuine multi-step agent work.
 * tool_calls = sum of each assistant message's recorded tools[] (finishMessage
 * stores the distinct tools used that turn). agent_rounds = # assistant msgs.
 */
function _passesGate(history) {
  if (!Array.isArray(history) || history.length < 2) return false;
  const recent = history.slice(-CONTEXT_MSGS);
  let toolCalls = 0, rounds = 0;
  for (const m of recent) {
    if (m && m.role === 'assistant') {
      rounds++;
      if (Array.isArray(m.tools)) toolCalls += m.tools.length;
    }
  }
  return toolCalls >= MIN_TOOL_CALLS || rounds >= MIN_AGENT_ROUNDS;
}

// The last turn must have actually produced an assistant answer (skip failed
// turns: an empty assistant tail means the turn errored / was killed).
function _lastTurnOk(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].role === 'assistant') {
      return !!String(history[i].content || '').trim();
    }
  }
  return false;
}

// ---- haiku ----------------------------------------------------------------

function _callHaiku(prompt, timeoutMs = 45000) {
  return new Promise((resolve) => {
    try {
      // ISOLATED one-shot (audit 2026-08-20): no MCP, no user settings/skills,
      // no tool schemas, no transcript on disk. Preamble 28.016 -> 173 tokens.
      // See server/oneshot-args.js.
      execFile(CLAUDE_BIN, oneShotArgs(prompt, {
        system: 'You extract a reusable procedure from a conversation and reply with a single JSON object. Output nothing else.',
      }), {
        timeout: timeoutMs, cwd: os.tmpdir(), encoding: 'utf-8',
      }, (err, stdout) => {
        if (err) { console.log('[SKILLS] haiku call failed:', err.message); resolve(null); return; }
        resolve((stdout || '').trim());
      });
    } catch (e) { console.log('[SKILLS] haiku spawn failed:', e.message); resolve(null); }
  });
}

function _extractPrompt(convo, existing) {
  const caps = (existing && existing.length) ? existing.map(n => '- ' + n).join('\n') : '(none)';
  return `You write reusable "skills" for an AI assistant. A skill is a recipe the assistant follows next time the SAME KIND of multi-step job comes up, so it doesn't have to re-figure it out.

Read the conversation below. ONLY if it shows the assistant successfully completing a concrete, repeatable, multi-step task worth capturing, output a skill.

EXISTING CAPABILITIES (skills/teams that ALREADY exist). If the task in the conversation is already covered by ANY of these, return null — NEVER duplicate or re-describe an existing capability. Only write a skill for a genuinely NEW repeatable procedure none of these cover:
${caps}

Return NOTHING worth saving as exactly: null
Return null for: plain Q&A, one-off chit-chat, failed/abandoned attempts, anything trivial or unique, OR anything already covered by an existing capability above. Be strict — a junk or duplicate skill is worse than none.

If it IS worth saving, return ONLY a JSON object:
{
  "title": "short imperative name, e.g. 'Resync a music library after a yt-dlp fix'",
  "problem": "one sentence: when to use this (the trigger situation)",
  "solution": "one sentence: how you know it worked (the verification)",
  "steps": ["concrete step 1", "step 2", "..."],
  "pitfalls": ["gotcha or thing that went wrong / to avoid", "..."],
  "tags": ["lowercase", "keywords"],
  "confidence": 0.0
}

Rules:
- steps: the actual procedure that worked, in order, concrete and self-contained.
- pitfalls: real mistakes/gotchas seen in THIS conversation (empty array if none).
- confidence: 0.0-1.0, how reusable + worth-saving this is. Below 0.6 = don't bother (return null instead).

Conversation:
"""
${convo}
"""

JSON object or null:`;
}

function _parseSkill(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^null$/i.test(s)) return null;
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  s = s.slice(i, j + 1);
  let o;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  if (typeof o.title !== 'string' || !o.title.trim()) return null;
  const conf = Number(o.confidence);
  if (!(conf >= MIN_CONFIDENCE)) return null;
  const steps = Array.isArray(o.steps) ? o.steps.map(x => String(x).trim()).filter(Boolean) : [];
  if (!steps.length) return null; // no procedure = not a skill
  return {
    title: o.title.trim().slice(0, 120),
    problem: String(o.problem || '').trim().slice(0, 300),
    solution: String(o.solution || '').trim().slice(0, 300),
    steps,
    pitfalls: Array.isArray(o.pitfalls) ? o.pitfalls.map(x => String(x).trim()).filter(Boolean) : [],
    tags: Array.isArray(o.tags) ? o.tags.map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 8) : [],
    confidence: Math.round(conf * 100) / 100,
  };
}

// ---- usage sidecar --------------------------------------------------------

function _loadUsage() {
  try { const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8')); return (u && typeof u === 'object') ? u : {}; }
  catch { return {}; }
}
function _saveUsage(u) {
  _ensureDir();
  const tmp = USAGE_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(u, null, 2)); fs.renameSync(tmp, USAGE_FILE); }
  catch (e) { console.error('[SKILLS] usage save failed:', e.message); }
}

// ---- skill file render ----------------------------------------------------

function _renderSkill(skill, sessionId) {
  const fm = [
    '---',
    `name: ${_slugify(skill.title)}`,
    `description: ${skill.problem.replace(/\n/g, ' ') || skill.title}`,
    'auto_generated: true',
    `confidence: ${skill.confidence}`,
    `created: ${new Date().toISOString()}`,
    `source_session: ${String(sessionId).slice(0, 12)}`,
    `tags: [${skill.tags.join(', ')}]`,
    '---',
  ].join('\n');

  const lines = [fm, '', `# ${skill.title}`, ''];
  lines.push('## When to Use', skill.problem || '_(not specified)_', '');
  lines.push('## Procedure');
  skill.steps.forEach((st, idx) => lines.push(`${idx + 1}. ${st}`));
  lines.push('');
  lines.push('## Pitfalls');
  if (skill.pitfalls.length) skill.pitfalls.forEach(p => lines.push(`- ${p}`));
  else lines.push('- _(none recorded)_');
  lines.push('');
  lines.push('## Verification', skill.solution || '_(not specified)_', '');
  return lines.join('\n');
}

// ---- existing skills ------------------------------------------------------

function _listSlugs() {
  try {
    // sort() is load-bearing, not cosmetic: readdirSync order is
    // filesystem-dependent, so without it a newly written draft can land
    // anywhere in the list and reshuffle the skill-index lines in the cached
    // --append-system-prompt → a prompt-cache miss with no semantic change
    // (openclaw harvest steal: sort dynamic structures before caching).
    return fs.readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
      .sort();
  } catch { return []; }
}

// Names of capabilities that already exist: hand-built team/command skills PLUS
// existing auto-skill drafts. Fed to the extractor so it never re-writes a recipe a
// team already encodes (the "shadow library" fix — fusion step 3, 2026-06-03). Wrapped.
function _listExistingCapabilities() {
  const out = new Set();
  try {
    for (const f of fs.readdirSync(COMMANDS_DIR)) {
      if (f.endsWith('.md')) out.add(f.replace(/\.md$/, ''));
    }
  } catch {}
  for (const s of _listSlugs()) out.add(s);
  return Array.from(out).sort();
}

function _readFrontmatter(file) {
  try {
    const txt = fs.readFileSync(file, 'utf-8');
    const m = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  } catch { return {}; }
}

// ---- public API -----------------------------------------------------------

/**
 * Fire-and-forget from the auto-skills plugin's onResponseComplete hook.
 * Writes at most one draft skill, only after genuine multi-step work. Never throws.
 */
async function maybeWriteSkill(sessionId, history) {
  try {
    if (!process.env.SKILLS_AUTO) return;
    const n = (_turnCounts.get(sessionId) || 0) + 1;
    _turnCounts.set(sessionId, n);

    if (!_passesGate(history)) return;
    if (!_lastTurnOk(history)) return;

    // Throttle: don't re-attempt every single turn once the gate is open.
    const last = _lastAttempt.has(sessionId) ? _lastAttempt.get(sessionId) : -Infinity;
    if (n - last < COOLDOWN_ROUNDS) return;

    // ---- ECONOMIC GUARDS (audit 2026-08-20) --------------------------------
    // On 2026-08-20 this engine made 37 haiku calls and wrote 0 files: the
    // library is saturated (102 drafts), so every proposal died in the dedup at
    // :305/:314 — AFTER the model had already been paid. The dedup itself can't
    // be hoisted (it needs the title the model invents), so these three cheap
    // checks stand in front of it. All are pre-call: they cost nothing.
    // NOTE: _lastAttempt is now stamped AFTER the guards, so a skipped attempt
    // does not consume the cooldown window.

    // (1) Library cap. Past SKILLS_MAX_LIBRARY active drafts the dedup surface is
    //     so dense that new titles almost always collide. Stop proposing until
    //     the owner prunes or the curator archives.
    const activeCount = _activeDraftCount();
    if (activeCount >= MAX_LIBRARY) {
      if (!_libraryWarned) {
        _libraryWarned = true;
        console.log(`[SKILLS] library saturated (${activeCount}/${MAX_LIBRARY} active drafts) — write attempts SUSPENDED (no haiku calls). Prune ${SKILLS_DIR} or raise SKILLS_MAX_LIBRARY.`);
      }
      return;
    }
    if (_libraryWarned && activeCount < MAX_LIBRARY) _libraryWarned = false;

    const recent = history.slice(-CONTEXT_MSGS)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 900)}`)
      .join('\n');
    if (!recent.trim()) return;

    // (2) Same-conversation memo. The cooldown fires on turn COUNT, so a session
    //     that keeps talking about the same job re-submitted a nearly identical
    //     window every 3 turns and got the same rejected title back every time.
    //     If this window already produced nothing, don't buy the same answer.
    const fp = _fingerprint(recent);
    if (_deadFingerprints.has(fp)) return;

    // (3) Per-session miss breaker. After MAX_MISSES consecutive attempts that
    //     produced no file, this session has nothing new to teach — stop.
    const misses = _misses.get(sessionId) || 0;
    if (misses >= MAX_MISSES) return;

    _lastAttempt.set(sessionId, n);

    const raw = await _callHaiku(_extractPrompt(recent, _listExistingCapabilities()));
    const skill = _parseSkill(raw);
    if (!skill) { _recordMiss(sessionId, fp); return; } // null / low-confidence / no procedure → write NOTHING

    const slug = _slugify(skill.title);
    const usage = _loadUsage();

    // Dedup: exact slug OR near-duplicate title against existing drafts.
    const existing = _listSlugs();
    if (existing.includes(slug)) {
      _recordMiss(sessionId, fp);
      usage[slug] = usage[slug] || { writes: 0 };
      usage[slug].writes = (usage[slug].writes || 0) + 1;
      usage[slug].lastSeen = Date.now();
      _saveUsage(usage);
      console.log(`[SKILLS] '${slug}' already exists — bumped usage (writes ${usage[slug].writes})`);
      return;
    }
    for (const ex of existing) {
      if (_jaccard(slug.replace(/-/g, ' '), ex.replace(/-/g, ' ')) >= JACCARD_DUP) {
        console.log(`[SKILLS] '${slug}' near-duplicate of '${ex}' — skipping write`);
        _recordMiss(sessionId, fp);
        return;
      }
    }

    // A real write: this session is productive again, clear its breaker.
    _misses.delete(sessionId);

    _ensureDir();
    const file = path.join(SKILLS_DIR, `${slug}.md`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, _renderSkill(skill, sessionId));
    fs.renameSync(tmp, file);

    usage[slug] = { writes: 1, created: Date.now(), confidence: skill.confidence };
    _saveUsage(usage);
    console.log(`[SKILLS] wrote draft skill '${slug}' (confidence ${skill.confidence}) from session ${String(sessionId).slice(0, 8)}`);
  } catch (e) {
    console.error('[SKILLS] write error:', e.message);
  }
}

/**
 * Index of draft skill names + descriptions (progressive disclosure — the agent
 * sees only this, not full bodies). Returns [] when off/empty.
 */
function listSkillIndex() {
  try {
    if (!process.env.SKILLS_AUTO) return [];
    return _listSlugs().map(slug => {
      const fm = _readFrontmatter(path.join(SKILLS_DIR, `${slug}.md`));
      return { name: fm.name || slug, description: fm.description || '' };
    });
  } catch { return []; }
}

/**
 * System-prompt addition listing available draft recipes, or '' when off/empty.
 * Appended (flag-gated) where the session-start --append-system-prompt is built.
 */
function getSkillIndexPreface() {
  try {
    if (!process.env.SKILLS_AUTO) return '';
    const idx = listSkillIndex();
    if (!idx.length) return '';
    const lines = idx.slice(0, MAX_INDEX)
      .map(s => `- ${s.name}: ${s.description}`).join('\n');
    return `\n\nReusable skills you have written for yourself from past work (UNREVIEWED draft recipes — names + descriptions only; your hand-built team/command skills ALWAYS take precedence). If one matches the current task and no team skill covers it, ask to read its file from ${SKILLS_DIR}/<name>.md before re-figuring out the procedure:\n${lines}`;
  } catch { return ''; }
}

function clearSession(sessionId) { _turnCounts.delete(sessionId); _lastAttempt.delete(sessionId); _misses.delete(sessionId); }

module.exports = {
  maybeWriteSkill, listSkillIndex, getSkillIndexPreface, clearSession,
  _passesGate, _parseSkill, _slugify, SKILLS_DIR,
  _listExistingCapabilities, _extractPrompt,
};
