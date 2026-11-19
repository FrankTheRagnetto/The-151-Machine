'use strict';
// Parity gate for the restart/deploy round (2026-08-16, punto 2).
//
// server/build-hash.js computeContentHash() (the server's LIVE code hash, now
// the primary CODE_HASH source) must produce the EXACT same value as the bash
// pipeline in tools/deploy.sh step 3.5 ("Stamp code hash"). If they drift, the
// ?v= cache-buster the server serves stops matching what deploy.sh stamped and
// clients either miss updates or reload spuriously. Plain node, no framework.
//
// The bash side is read straight from deploy.sh (incl. LC_ALL=C sort -z
// — the 2026-08-16 determinism fix; the ambient it_IT locale collated
// differently and made the hash machine-dependent).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { computeContentHash } = require('../server/build-hash');

const REPO = path.join(__dirname, '..');

// The bash side is READ from tools/deploy.sh (06/10/2026), never copied: a
// hand copy here let deploy.sh gain an exclusion (a backup state file) that the
// server lacked, and this test stayed green on its stale copy.
const DEPLOY_SH = fs.readFileSync(path.join(REPO, 'tools', 'deploy.sh'), 'utf8');
const m = DEPLOY_SH.match(/^CODE_HASH=\$\((find server[\s\S]*?cut -c1-12)\)$/m);
assert.ok(m, 'tools/deploy.sh: could not find the CODE_HASH=$(find ... cut -c1-12) pipeline');
const BASH_PIPELINE = m[1];

const bashHash = execSync(BASH_PIPELINE, { cwd: REPO, shell: '/bin/bash' }).toString().trim();
const nodeHash = computeContentHash();

assert.ok(/^[0-9a-f]{12}$/.test(bashHash), 'bash hash malformed: ' + bashHash);
assert.strictEqual(nodeHash, bashHash,
  `content-hash parity broken: node=${nodeHash} bash=${bashHash} — ` +
  'server/build-hash.js computeContentHash() and tools/deploy.sh step 3.5 must stay in sync');

// deploy.sh must keep the LC_ALL=C fix — a plain `sort -z` reintroduces the
// locale dependence this test exists to prevent.
const deploySh = DEPLOY_SH;
assert.ok(/LC_ALL=C sort -z/.test(deploySh),
  'tools/deploy.sh lost the LC_ALL=C on its code-hash sort');

console.log('build-hash parity OK:', nodeHash);
