'use strict';

// =============================================================================
// MODEL PIN PER SESSIONE — round modelli il proprietario
// Verifies:
//   a. resolveModelChain(pin): the session's pin BEATS settings.json/env and
//      the static fallbacks are appended, deduped.
//   b. resolveModelChain() no-arg unchanged (settings-first, 0c671d9 semantics).
//   c. listSelectableModels(): chip picker trio present, deduped, Fable first.
//   d. SessionManager.create() pins at birth (pinnedModel === model, non-empty).
//   e. setModel() re-pins pin + display model and PERSISTS both.
//   f. load() restores the pin (round-trip through _serializeAll JSON).
// Pure unit test — no server, no CLI spawn, scratch store in tmpdir.
// =============================================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ERMETICO (2026-09-27, ). Prima questo test leggeva il
// ~/.claude/settings.json VERO attraverso readSettingsModel(): il 26/09 il proprietario ha
// scelto `claude-opus-5-5` col /model, e il test (che si dichiara PURO) è
// diventato rosso — e con lui il passo 3/7 del cancello, per TUTTI i commit.
// Un test puro non deve dipendere dalla scelta di modello di nessuno. Adesso
// la casa è FINTA: HOME punta a una cartella usa-e-getta con un settings.json
// scritto qui, PRIMA di qualunque require (os.homedir() su Linux legge $HOME a
// ogni chiamata). Il settings finto porta una scelta Fable col tier 1M — la
// forma per cui questo test era stato scritto — e la sezione g riscrive il
// finto per provare che una scelta della stessa famiglia vince davvero.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pin-home-'));
const FAKE_SETTINGS = path.join(FAKE_HOME, '.claude', 'settings.json');
function writeFakeSettings(model) {
  fs.mkdirSync(path.dirname(FAKE_SETTINGS), { recursive: true });
  fs.writeFileSync(FAKE_SETTINGS, JSON.stringify(model ? { model } : {}, null, 2));
}
const REAL_HOME = process.env.HOME;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.CLAUDE_MODEL; // nemmeno l'env del chiamante deve spostare la prova
writeFakeSettings('claude-fable-5[1m]');
assert.strictEqual(os.homedir(), FAKE_HOME, 'la casa del test deve essere quella finta');
assert.notStrictEqual(os.homedir(), REAL_HOME, 'mai la casa vera');

const { resolveModelChain, listSelectableModels, familyOf, displayModelFor, FAMILY_NEWEST, MODEL_FAMILIES } = require('../server/model-fallback');
const { SessionManager } = require('../server/session-manager');

// a. pin wins over everything
{
  const chain = resolveModelChain('claude-test-pin-9');
  assert.strictEqual(chain[0], 'claude-test-pin-9', 'pin must be primary');
  assert.ok(chain.includes('claude-opus-5'), 'static fallback opus-5 appended');
  assert.ok(chain.includes('claude-opus-4-8'), 'static fallback opus-4-8 appended');
  assert.strictEqual(new Set(chain).size, chain.length, 'chain deduped');
}

// a2. blank/whitespace pin ignored → falls through to default resolution
{
  assert.deepStrictEqual(resolveModelChain('   '), resolveModelChain(),
    'blank pin must behave like no pin');
}

// b. no-arg chain: primary is a non-empty string and fallbacks still ride along
{
  const chain = resolveModelChain();
  assert.ok(typeof chain[0] === 'string' && chain[0].trim(), 'default primary non-empty');
  assert.ok(chain.includes('claude-opus-4-8'), 'legacy fallback present');
}

// c. picker list — FAMIGLIE (round #4) minus Haiku (round #6, 2026-08-16) and
// minus Sonnet (2026-08-19): the CLICKABLE set is Fable/Opus, offered to both
// the topbar chip and the Super-Agent spawn selector. Both dropped families stay
// in MODEL_FAMILIES (and thus in familyOf/displayModelFor/the automatic fallback
// path) — they are only unclickable. This test is the guard for exactly that
// distinction: trimming the menu must never trim what the app can RESOLVE,
// or every session already pinned to one would break on its next spawn.
{
  const models = listSelectableModels();
  assert.deepStrictEqual(models, ['fable', 'opus'],
    'picker offers the two clickable families, Fable first');
  assert.ok(!models.includes('haiku'), 'Haiku is NOT hand-pickable');
  assert.ok(!models.includes('sonnet'), 'Sonnet is NOT hand-pickable (2026-08-19)');
  assert.ok(MODEL_FAMILIES.includes('haiku'),
    'Haiku still a known family (internal resolution/fallback intact)');
  assert.ok(MODEL_FAMILIES.includes('sonnet'),
    'Sonnet still a known family (internal resolution/fallback intact)');
  // Both pins still resolve end-to-end — nothing about the ladder changed.
  assert.strictEqual(familyOf(resolveModelChain('haiku')[0]), 'haiku',
    'an existing haiku pin still resolves in-family');
  assert.strictEqual(familyOf(resolveModelChain('sonnet')[0]), 'sonnet',
    'an existing sonnet pin still resolves in-family');
}

// c2. familyOf + family-pin expansion in the chain
{
  assert.strictEqual(familyOf('claude-fable-5[1m]'), 'fable');
  assert.strictEqual(familyOf('claude-haiku-4-5-20251001'), 'haiku');
  assert.strictEqual(familyOf('sonnet'), 'sonnet');
  assert.strictEqual(familyOf(''), null);

  // Family pin expands per spawn: primary must BE of that family — either the
  // settings.json pick (same family, exact tier) or the bare alias the CLI
  // resolves itself. Fallbacks still appended.
  const fab = resolveModelChain('fable');
  assert.strictEqual(familyOf(fab[0]), 'fable', 'fable pin resolves inside the family');
  assert.ok(fab.includes('claude-opus-5') && fab.includes('claude-opus-4-8'),
    'ladder intact under a family pin');
  const son = resolveModelChain('sonnet');
  assert.strictEqual(familyOf(son[0]), 'sonnet', 'sonnet pin resolves inside the family');
  // A versioned id is NOT expanded — exact pins still respected verbatim.
  assert.strictEqual(resolveModelChain('claude-opus-4-8')[0], 'claude-opus-4-8');
}

// c3. ROUND #5 (1b) — the opus family must NOT resolve to the leaked env
// CLAUDE_MODEL=claude-opus-4-8. The spawn primary is the bare 'opus' alias
// (which the real CLI resolves to claude-opus-5); 4-8 lives ONLY in the ladder.
{
  const chain = resolveModelChain('opus');
  assert.strictEqual(chain[0], FAMILY_NEWEST.opus,
    'opus family spawns as the PRECISE newest (same on CLI + SDK), never opus-4-8');
  assert.ok(/^claude-opus-\d/.test(chain[0]), 'a precise opus id, never the bare alias');
  assert.notStrictEqual(chain[0], 'claude-opus-4-8',
    'env CLAUDE_MODEL leak must not win family resolution');
  // 4-8 is still reachable — but only as a fallback rung, never primary.
  assert.ok(chain.includes('claude-opus-4-8'), 'opus-4-8 stays in the ladder');
  assert.ok(chain.indexOf('claude-opus-4-8') > 0, 'opus-4-8 is never the primary');
}

// c4. ROUND #5 (1a) — displayModelFor gives a PRECISE version immediately for a
// bare family pick, so the chip/card read a real name at once (never bare).
{
  assert.strictEqual(displayModelFor('opus'), FAMILY_NEWEST.opus,
    'Opus family shows the precise newest immediately');
  // fable settings.json tier (claude-fable-5[1m]) beats the bare newest map.
  assert.strictEqual(displayModelFor('fable'), 'claude-fable-5[1m]',
    'fable display = the (fake) settings.json tier pick');
  assert.ok(displayModelFor('fable') !== 'fable', 'never a bare family name');
  // A precise id passes through verbatim.
  assert.strictEqual(displayModelFor('claude-opus-5'), 'claude-opus-5');
  assert.strictEqual(displayModelFor('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
}

// d/e/f. SessionManager pin lifecycle on a scratch store
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pin-test-'));
  const store = path.join(dir, 'sessions.json');
  const mgr = new SessionManager(store);

  const dto = mgr.create({ title: 'pin-test', workingDirectory: dir });
  const live = mgr.sessions.get(dto.id);
  assert.ok(live.pinnedModel && live.pinnedModel.trim(), 'pinned at birth');
  assert.strictEqual(live.model, live.pinnedModel, 'display model = pin at birth');
  assert.strictEqual(live.pinnedModel, resolveModelChain()[0],
    'birth pin = current terminal default');

  // e0. FAMIGLIE: family pin stores the family, display resolves to a real id
  mgr.setModel(dto.id, 'fable');
  assert.strictEqual(live.pinnedModel, 'fable', 'family pin stored bare');
  assert.strictEqual(familyOf(live.model), 'fable', 'display model resolved in-family');
  // noteRunningModel (init line) refines display, never the pin
  mgr.noteRunningModel(dto.id, 'claude-fable-5[1m]');
  assert.strictEqual(live.model, 'claude-fable-5[1m]', 'init stamps precise display');
  assert.strictEqual(live.pinnedModel, 'fable', 'pin untouched by init stamp');
  mgr.noteRunningModel(dto.id, 'claude'); // placeholder must be ignored
  assert.strictEqual(live.model, 'claude-fable-5[1m]', "'claude' placeholder ignored");

  // e. re-pin via the chip door (exact ids still work)
  const dto2 = mgr.setModel(dto.id, 'claude-opus-5');
  assert.strictEqual(live.pinnedModel, 'claude-opus-5', 'setModel re-pins');
  assert.strictEqual(live.model, 'claude-opus-5', 'setModel updates display model');
  assert.strictEqual(dto2.model, 'claude-opus-5', 'DTO ships the new model');
  assert.throws(() => mgr.setModel('nope-id', 'claude-opus-5'), /not found/i);
  assert.throws(() => mgr.setModel(dto.id, '   '), /required/i);

  // f. persistence round-trip
  const serialized = JSON.parse(mgr._serializeAll());
  const row = serialized.find((s) => s.id === dto.id);
  assert.strictEqual(row.pinnedModel, 'claude-opus-5', 'pin persisted');
  assert.strictEqual(row.model, 'claude-opus-5', 'model persisted');
  fs.writeFileSync(store, JSON.stringify(serialized, null, 2));
  const mgr2 = new SessionManager(store);
  mgr2.load();
  const restored = mgr2.sessions.get(dto.id);
  assert.strictEqual(restored.pinnedModel, 'claude-opus-5', 'pin survives load()');

  // cleanup (scratch dir only) — cancel pending debounced saves first so no
  // stray write fires after the dir is gone.
  if (mgr._saveTimer) clearTimeout(mgr._saveTimer);
  if (mgr2._saveTimer) clearTimeout(mgr2._saveTimer);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// g. la scelta /model della STESSA famiglia vince su FAMILY_NEWEST (è il caso
// vero del 26/09: settings = claude-opus-5-5). Il finto viene riscritto: niente
// cache, readSettingsModel rilegge a ogni chiamata.
{
  writeFakeSettings('claude-opus-9-9');
  assert.strictEqual(resolveModelChain()[0], 'claude-opus-9-9', 'no pin → settings pick');
  assert.strictEqual(resolveModelChain('opus')[0], 'claude-opus-9-9',
    'opus family pin → the same-family settings pick (exact tier)');
  assert.strictEqual(displayModelFor('opus'), 'claude-opus-9-9');
  // una famiglia DIVERSA nel settings non tocca la risoluzione della fable
  assert.strictEqual(resolveModelChain('fable')[0], FAMILY_NEWEST.fable);
  // settings senza modello → cade sul default statico, mai sulla casa vera
  writeFakeSettings(null);
  assert.strictEqual(resolveModelChain()[0], 'claude-opus-4-8', 'no settings model → legacy default');
  // settings illeggibile → stesso ripiego, nessuna eccezione nel percorso di spawn
  fs.writeFileSync(FAKE_SETTINGS, '{ rotto');
  assert.strictEqual(resolveModelChain()[0], 'claude-opus-4-8', 'broken settings → legacy default');
}

process.env.HOME = REAL_HOME;
try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}

console.log('model-pin.test.js: PASS (a,a2,b,c,d,e,f,g) — casa finta, settings finto');
