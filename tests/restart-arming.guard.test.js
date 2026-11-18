#!/usr/bin/env node
'use strict';

/**
 * restart-arming.guard.test.js — structural guard for the arm-then-restart rule.
 *
 * The post-deploy self-report kept failing because arming lived inside two ad-hoc
 * routes; any new restart path silently skipped it. This test makes that class of
 * bug impossible to merge: it asserts every restart funnel ARMS the post-deploy
 * verify marker, and that nothing bypasses the single in-process funnel.
 *
 * Run: node tests/restart-arming.guard.test.js   (also part of `npm test` smoke).
 * Pure static analysis — reads source, no server boot, no side effects.
 */

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const read = (p) => fs.readFileSync(path.join(SERVER_DIR, p), 'utf8');

const failures = [];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// Strip // line and /* */ block comments so guards scan CODE, not prose.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Pull a function body by brace-matching. Skips the parameter list first (so a
// destructured-param brace `{ a, b } = {}` isn't mistaken for the body).
function funcBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  // Walk the parameter list to its closing ')'.
  let i = src.indexOf('(', start);
  let pdepth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { i++; break; } }
  }
  const open = src.indexOf('{', i);
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return null;
}

// ── Funnel #1: the in-process restart() helper must arm ──────────────────────
const restartControl = stripComments(read('restart-control.js'));
const restartBody = funcBody(restartControl, 'restart');
check('restart-control.restart() exists', !!restartBody);
check(
  'restart-control.restart() arms the verify marker',
  !!restartBody && /armPostDeployVerify\s*\(/.test(restartBody),
  'restart() must call restartIntent.armPostDeployVerify before shutting down'
);

// ── Funnel #2: the shell-restart chokepoint must arm ─────────────────────────
const streamHandler = stripComments(read('stream-handler.js'));
const culpritBody = funcBody(streamHandler, 'maybeRecordRestartCulprit');
check('stream-handler.maybeRecordRestartCulprit() exists', !!culpritBody);
check(
  'stream-handler chokepoint arms the verify marker',
  !!culpritBody && /armPostDeployVerify\s*\(/.test(culpritBody),
  'maybeRecordRestartCulprit must call armPostDeployVerify for session-fired restarts'
);

// ── No bypass: plannedShutdown is the mechanism, never a direct call site ─────
// It may be DEFINED (deploy.js) and PASSED by reference (index.js registers it),
// but it must never be INVOKED by name anywhere — every restart goes through
// restart-control.restart(). A `plannedShutdown(` token = an invocation; the sole
// legitimate one is the definition `function plannedShutdown(reason)`.
let invokeCount = 0;
const offenders = [];
for (const f of fs.readdirSync(SERVER_DIR)) {
  if (!f.endsWith('.js')) continue;
  const src = stripComments(read(f));
  const re = /\bplannedShutdown\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 9), m.index);
    if (before.endsWith('function ')) continue; // the definition — allowed
    invokeCount++;
    offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
  }
}
check(
  'no direct plannedShutdown() invocation bypasses restart-control',
  invokeCount === 0,
  offenders.length ? 'offenders: ' + offenders.join(', ') : ''
);

// ── deploy.js full-deploy path routes through the funnel ──────────────────────
const deploy = stripComments(read('deploy.js'));
check(
  'deploy.js routes the full deploy through restart-control.restart()',
  /restartControl\.restart\s*\(/.test(deploy),
  'deployRoute must call restartControl.restart, not plannedShutdown directly'
);

// ── arm primitive self-deletes on fire (the marker can never linger) ──────────
const index = stripComments(read('index.js'));
check(
  'boot loop self-deletes the armed marker the moment it fires',
  /clearArmedVerify\s*\(/.test(index),
  'index.js boot verify must call restartIntent.clearArmedVerify()'
);

// ── Report ────────────────────────────────────────────────────────────────────
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
if (failures.length) {
  console.error(`\n✗ restart-arming guard FAILED (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`\n✓ restart-arming guard passed (${checks.length} checks)`);
