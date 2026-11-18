'use strict';
/**
 * Skill Curator — harvest steal #2 (Hermes / NousResearch, adapted to Node).
 *
 * The self-writing-skills feature (server/skill-writer.js) DRAFTS recipes after
 * multi-step work. Left alone, that library rots: dozens of overlapping one-off
 * micro-skills pile up. The Curator is the periodic janitor that fights that
 * entropy. TWO jobs, deliberately split by risk:
 *
 *   A) AGING PASS  — pure, no-LLM, SAFE TO AUTO-RUN. Walks the draft library and
 *      moves each skill active → stale (idle CURATOR_STALE_DAYS) → archived
 *      (idle CURATOR_ARCHIVE_DAYS). Archiving NEVER deletes — it moves the file
 *      into .archive/ (fully recoverable). Pinned skills are never touched.
 *      Re-used skills reactivate. New skills anchor their clock to creation so
 *      they can't instantly archive.
 *
 *   B) CONSOLIDATION REVIEW — LLM, DRY-RUN ONLY. A cheap haiku pass reads the
 *      active library and PROPOSES merges (umbrellas) + prunings. It NEVER
 *      mutates skills; it writes a human report to curator-report.md for the owner to
 *      read and approve — same "owner approves" discipline as the drafts
 *      themselves (a flaky auto-merge must not silently rewrite the library).
 *      Proposals are reconciled against the real file list (hallucinated skill
 *      names are dropped) before they reach the report.
 *
 * GATED by SKILLS_CURATOR (master switch). Unset = scheduler never starts, no
 * timer, fully inert. Runs every CURATOR_INTERVAL_HOURS (default 168 = 7 days),
 * but DEFERS its first run by a full interval on a fresh install (seeds
 * last_run_at=now the first time it's seen) so it can't sweep a brand-new
 * library on boot. State is persisted BEFORE the LLM pass so a crash mid-sweep
 * doesn't immediately re-trigger.
 *
 * Fully wrapped — like memory-engine / skill-writer, it can NEVER throw into the
 * server. Every public entry point swallows its own errors.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { oneShotArgs } = require('./oneshot-args');

const CLAUDE_BIN = 'claude';
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.151machine', 'auto-skills');
const ARCHIVE_DIR = path.join(SKILLS_DIR, '.archive');
const USAGE_FILE = path.join(SKILLS_DIR, '_usage.json');
const STATE_FILE = path.join(SKILLS_DIR, '.curator-state.json');
const REPORT_FILE = path.join(SKILLS_DIR, 'curator-report.md');

const INTERVAL_HOURS = parseInt(process.env.CURATOR_INTERVAL_HOURS || '168', 10); // 7 days
const CHECK_HOURS = parseInt(process.env.CURATOR_CHECK_HOURS || '6', 10);          // how often the timer wakes
const STALE_DAYS = parseInt(process.env.CURATOR_STALE_DAYS || '30', 10);
const ARCHIVE_DAYS = parseInt(process.env.CURATOR_ARCHIVE_DAYS || '90', 10);
const DAY_MS = 86400000;

let _timer = null;

function _on() { return !!process.env.SKILLS_CURATOR; }
function _ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

// ---- small JSON helpers (atomic) -------------------------------------------

function _readJson(file, fallback) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf-8')); return v && typeof v === 'object' ? v : fallback; }
  catch { return fallback; }
}
function _writeJson(file, obj) {
  _ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }
  catch (e) { console.error('[CURATOR] write failed:', file, e.message); }
}

function _state() { return _readJson(STATE_FILE, { last_run_at: 0, runs: [] }); }

// ---- skill enumeration ------------------------------------------------------

function _listSlugs() {
  try {
    return fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  } catch { return []; }
}
function _frontmatter(slug) {
  try {
    const txt = fs.readFileSync(path.join(SKILLS_DIR, `${slug}.md`), 'utf-8');
    const m = txt.match(/^---\n([\s\S]*?)\n---/);
    const out = {};
    if (m) for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  } catch { return {}; }
}
function _fileMtime(slug) {
  try { return fs.statSync(path.join(SKILLS_DIR, `${slug}.md`)).mtimeMs; } catch { return 0; }
}

// last meaningful activity for a skill: newest of created / lastSeen / file mtime
function _lastActivity(slug, usage) {
  const u = usage[slug] || {};
  return Math.max(u.created || 0, u.lastSeen || 0, u.lastUsed || 0, _fileMtime(slug));
}

// ---- A) AGING PASS (pure, no LLM, safe) ------------------------------------

function _archiveSkill(slug) {
  _ensureDir(ARCHIVE_DIR);
  const src = path.join(SKILLS_DIR, `${slug}.md`);
  const dst = path.join(ARCHIVE_DIR, `${slug}.md`);
  try { fs.renameSync(src, dst); return true; }
  catch (e) { console.error('[CURATOR] archive move failed:', slug, e.message); return false; }
}

function applyAgingTransitions(now = Date.now()) {
  const usage = _readJson(USAGE_FILE, {});
  const result = { staled: [], archived: [], reactivated: [], active: 0, pinnedSkipped: 0 };

  for (const slug of _listSlugs()) {
    const u = usage[slug] || (usage[slug] = {});
    if (u.pinned) { result.pinnedSkipped++; continue; }
    const idleDays = (now - _lastActivity(slug, usage)) / DAY_MS;

    if (idleDays >= ARCHIVE_DAYS) {
      if (_archiveSkill(slug)) {
        u.state = 'archived'; u.archivedAt = now;
        result.archived.push(slug);
      }
    } else if (idleDays >= STALE_DAYS) {
      if (u.state !== 'stale') { u.state = 'stale'; result.staled.push(slug); }
    } else {
      if (u.state === 'stale') { u.state = 'active'; result.reactivated.push(slug); }
      else u.state = u.state || 'active';
      result.active++;
    }
  }
  _writeJson(USAGE_FILE, usage);
  return result;
}

// ---- B) CONSOLIDATION REVIEW (LLM, dry-run, owner-approved) -----------------

function _callHaiku(prompt, timeoutMs = 60000) {
  return new Promise((resolve) => {
    try {
      // ISOLATED one-shot (audit 2026-08-20): no MCP, no user settings/skills,
      // no tool schemas, no transcript on disk. Preamble 28.016 -> 173 tokens.
      // See server/oneshot-args.js.
      execFile(CLAUDE_BIN, oneShotArgs(prompt, {
        system: 'You review a library of skill entries and reply with a single JSON object. Output nothing else.',
      }), {
        timeout: timeoutMs, cwd: os.tmpdir(), encoding: 'utf-8',
      }, (err, stdout) => {
        if (err) { console.log('[CURATOR] haiku call failed:', err.message); resolve(null); return; }
        resolve((stdout || '').trim());
      });
    } catch (e) { console.log('[CURATOR] haiku spawn failed:', e.message); resolve(null); }
  });
}

function _activeSkillList() {
  const usage = _readJson(USAGE_FILE, {});
  return _listSlugs()
    .filter(slug => (usage[slug] || {}).state !== 'archived')
    .map(slug => {
      const fm = _frontmatter(slug);
      return { name: fm.name || slug, description: (fm.description || '').slice(0, 200), tags: fm.tags || '' };
    });
}

function _reviewPrompt(skills) {
  const list = skills.map((s, i) => `${i + 1}. [${s.name}] ${s.description}${s.tags ? ` (tags: ${s.tags})` : ''}`).join('\n');
  return `You are a librarian curating an AI assistant's self-written "skill" library.
A flat pile of many narrow, overlapping skills is a FAILURE of the library, not a feature.
Your job: propose how to CONSOLIDATE overlapping skills into broader "umbrella" skills, and which redundant ones to prune. This is a PROPOSAL ONLY — nothing will be changed automatically.

Hard rules:
- Only group skills that genuinely overlap in purpose. Distinct triggers alone are NOT a reason to keep duplicates apart, but do NOT merge unrelated skills.
- Never propose merging fewer than 2 skills into an umbrella.
- Prune only true redundancies (fully covered by another skill).
- Use ONLY the skill names exactly as given. Do not invent names.
- If the library is already clean, return empty arrays.

SKILLS (${skills.length}):
${list}

Return ONLY JSON:
{"consolidations":[{"from":["name-a","name-b"],"into":"umbrella-name","reason":"one sentence"}],"prunings":[{"name":"name","reason":"one sentence"}]}`;
}

function _parseReview(raw) {
  if (!raw) return { consolidations: [], prunings: [] };
  let s = String(raw).trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return { consolidations: [], prunings: [] };
  let o; try { o = JSON.parse(s.slice(i, j + 1)); } catch { return { consolidations: [], prunings: [] }; }
  if (!o || typeof o !== 'object') return { consolidations: [], prunings: [] };
  return {
    consolidations: Array.isArray(o.consolidations) ? o.consolidations : [],
    prunings: Array.isArray(o.prunings) ? o.prunings : [],
  };
}

// Reconcile model output against the REAL skill set: drop hallucinated names,
// require >=2 real sources per umbrella. The model proposes; code decides what
// is even reportable.
function _reconcile(review, realNames) {
  const real = new Set(realNames);
  const consolidations = [];
  for (const c of review.consolidations) {
    if (!c || typeof c.into !== 'string') continue;
    const from = (Array.isArray(c.from) ? c.from : []).filter(n => real.has(n));
    if (from.length < 2) continue; // need >=2 real sources to be a real merge
    consolidations.push({ from, into: String(c.into).trim(), reason: String(c.reason || '').trim().slice(0, 200) });
  }
  const prunings = [];
  for (const p of review.prunings) {
    if (p && typeof p.name === 'string' && real.has(p.name)) {
      prunings.push({ name: p.name, reason: String(p.reason || '').trim().slice(0, 200) });
    }
  }
  return { consolidations, prunings };
}

function _writeReport(skills, proposals, aging, now) {
  const ts = new Date(now).toISOString();
  const L = [];
  L.push(`# Skill Curator Report`, '', `Generated: ${ts}`, `Mode: DRY-RUN (proposals only — nothing was changed to your skills)`, '');
  L.push(`## Library aging (applied automatically — safe, recoverable)`);
  L.push(`- Active: ${aging.active}`);
  L.push(`- Newly marked stale (idle ≥ ${STALE_DAYS}d): ${aging.staled.length}${aging.staled.length ? ' — ' + aging.staled.join(', ') : ''}`);
  L.push(`- Archived (idle ≥ ${ARCHIVE_DAYS}d, moved to .archive/, recoverable): ${aging.archived.length}${aging.archived.length ? ' — ' + aging.archived.join(', ') : ''}`);
  L.push(`- Reactivated (used again): ${aging.reactivated.length}${aging.reactivated.length ? ' — ' + aging.reactivated.join(', ') : ''}`);
  L.push(`- Pinned (skipped): ${aging.pinnedSkipped}`, '');
  L.push(`## Consolidation proposals (NOT applied — review & approve)`);
  if (!proposals.consolidations.length && !proposals.prunings.length) {
    L.push('', '_Library looks clean — no merges or prunings proposed._', '');
  } else {
    if (proposals.consolidations.length) {
      L.push('', '### Suggested merges (umbrellas)');
      for (const c of proposals.consolidations) L.push(`- **${c.into}** ← ${c.from.join(' + ')}  \n  _${c.reason}_`);
    }
    if (proposals.prunings.length) {
      L.push('', '### Suggested prunings');
      for (const p of proposals.prunings) L.push(`- **${p.name}** — _${p.reason}_`);
    }
    L.push('', '_To apply: review the named skills in ~/.151machine/auto-skills/ and merge/remove by hand (or ask me to)._', '');
  }
  _ensureDir(SKILLS_DIR);
  const tmp = REPORT_FILE + '.tmp';
  try { fs.writeFileSync(tmp, L.join('\n')); fs.renameSync(tmp, REPORT_FILE); }
  catch (e) { console.error('[CURATOR] report write failed:', e.message); }
}

// ---- orchestration ----------------------------------------------------------

function shouldRunNow(now = Date.now()) {
  const st = _state();
  if (!st.last_run_at) { // first time seen → seed clock, defer a full interval
    st.last_run_at = now;
    _writeJson(STATE_FILE, st);
    return false;
  }
  return (now - st.last_run_at) >= INTERVAL_HOURS * 3600000;
}

/**
 * Run one curator pass. force=true bypasses both the flag and the schedule
 * gate (used by tests + a manual trigger). Never throws; returns a summary.
 */
async function runCurator(force = false, now = Date.now()) {
  try {
    if (!force && !_on()) return { skipped: 'flag-off' };
    if (!force && !shouldRunNow(now)) return { skipped: 'not-due' };

    // Persist run state BEFORE the LLM pass (crash-safe: don't re-trigger on restart).
    const st = _state();
    st.last_run_at = now;
    st.runs = (st.runs || []).slice(-9);
    st.runs.push({ at: now });
    _writeJson(STATE_FILE, st);

    // A) safe aging pass
    const aging = applyAgingTransitions(now);

    // B) dry-run consolidation review
    const skills = _activeSkillList();
    let proposals = { consolidations: [], prunings: [] };
    if (skills.length >= 2) {
      const raw = await _callHaiku(_reviewPrompt(skills));
      proposals = _reconcile(_parseReview(raw), skills.map(s => s.name));
    }

    _writeReport(skills, proposals, aging, now);
    console.log(`[CURATOR] pass done — active ${aging.active}, staled ${aging.staled.length}, archived ${aging.archived.length}; proposals: ${proposals.consolidations.length} merge / ${proposals.prunings.length} prune → ${REPORT_FILE}`);
    return { aging, proposals, report: REPORT_FILE };
  } catch (e) {
    console.error('[CURATOR] run error:', e.message);
    return { error: e.message };
  }
}

/**
 * Start the periodic scheduler. No-op unless SKILLS_CURATOR is set. The timer
 * wakes every CHECK_HOURS and runCurator() self-gates on shouldRunNow(); the
 * first run is deferred a full interval. Timer is unref'd so it never holds the
 * process open.
 */
function startCuratorScheduler() {
  try {
    if (!_on()) return false;
    if (_timer) return true;
    shouldRunNow(); // seed the clock on first boot so we defer the first sweep
    _timer = setInterval(() => { runCurator(false); }, CHECK_HOURS * 3600000);
    if (_timer.unref) _timer.unref();
    console.log(`[CURATOR] scheduler started (every ${INTERVAL_HOURS}h, checking every ${CHECK_HOURS}h)`);
    return true;
  } catch (e) { console.error('[CURATOR] scheduler start failed:', e.message); return false; }
}

function stopCuratorScheduler() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = {
  startCuratorScheduler, stopCuratorScheduler, runCurator, shouldRunNow,
  applyAgingTransitions,
  // exposed for tests:
  _parseReview, _reconcile, _activeSkillList, _reviewPrompt,
  SKILLS_DIR, ARCHIVE_DIR, STATE_FILE, REPORT_FILE,
};
