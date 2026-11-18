'use strict';
// tools/system-cleanup.sh — the owner's rule: delete ONLY real junk,
// never what would be downloaded or rebuilt again by itself. Runs the real
// script on a FAKE home with a FAKE `pacman` in PATH (no data of the owner's, no
// root, nothing outside the temp folder is written). Proves:
//   A. trash, thumbnails, Spotify and build downloads are left byte for byte;
//   B. yay: current package/sources/clone stay; old versions, build leftovers
//      and folders of uninstalled programs go; unknown folders stay;
//   C. a size whose `du` hits an unreadable subfolder prints ONE number
//      (the «11GB 0» bug);
//   D. the report is English.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'tools', 'system-cleanup.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syscleanup-'));
const home = path.join(tmp, 'home');
const bin = path.join(tmp, 'bin');
const w = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const H = (...p) => path.join(home, ...p);
const exists = (p) => fs.existsSync(p);
let locked = null;

try {
  // Fake pacman: two installed AUR programs, one with an epoch.
  w(path.join(bin, 'pacman'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = "-Q" ]; then',
    '  case "$3" in foo) echo "foo 1.2-1";; bar) echo "bar 2:3.0-1";; *) exit 1;; esac',
    '  exit 0',
    'fi',
    'exit 0',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'pacman'), 0o755);

  // A. things that must never move
  const keep = [
    H('.local/share/Trash/files/old.txt'),
    H('.cache/thumbnails/large/a.png'),
    H('.cache/spotify/Data/ab/track.file'),
    H('.npm/_cacache/index'),
    H('.gradle/caches/x.jar'),
    H('.android/avd/x.img'),
    H('.cache/ms-playwright/chromium/chrome'),
  ];
  keep.forEach((p) => w(p, 'KEEP'));
  // C. an unreadable folder inside a measured one → du exits 1
  locked = H('.cache/spotify/Data/locked');
  fs.mkdirSync(locked); w(path.join(locked, 'f'));
  fs.chmodSync(locked, 0o000);

  // B. yay
  const foo = H('.cache/yay/foo');
  w(path.join(foo, 'PKGBUILD'));
  w(path.join(foo, 'fix.patch'));
  w(path.join(foo, '.SRCINFO'), [
    'pkgbase = foo', '\tpkgver = 1.2', '\tpkgrel = 1',
    '\tsource = https://example.org/dl/foo-1.2.tar.gz?raw=1',
    '\tsource_x86_64 = foo-bin.deb::https://example.org/foo_1.2_amd64.deb',
    '\tsource = git+https://example.org/repo.git#tag=v1.2',
    '\tsource = fix.patch',
    'pkgname = foo', 'pkgname = foo-extra', '',
  ].join('\n'));
  execFileSync('git', ['init', '-q', foo]);
  execFileSync('git', ['-C', foo, 'add', 'PKGBUILD', '.SRCINFO', 'fix.patch']);
  const fooKeep = ['foo-1.2.tar.gz', 'foo-bin.deb', 'foo-1.2-1-x86_64.pkg.tar.zst',
    'foo-1.2-1-x86_64.pkg.tar.zst.sig', 'repo/HEAD', 'PKGBUILD', 'fix.patch', '.SRCINFO'];
  const fooGone = ['foo-1.1.tar.gz', 'foo_1.1_amd64.deb', 'foo-1.1-1-x86_64.pkg.tar.zst',
    'foo-1.1-1-x86_64.pkg.tar.zst.sig', 'foo-debug-1.2-1-x86_64.pkg.tar.zst',
    'src/build/a.o', 'pkg/foo/usr/bin/foo'];
  [...fooKeep, ...fooGone].forEach((f) => { if (!exists(path.join(foo, f))) w(path.join(foo, f)); });

  const bar = H('.cache/yay/bar');
  w(path.join(bar, '.SRCINFO'), 'pkgbase = bar\npkgname = bar\n');
  w(path.join(bar, 'bar-2:3.0-1-any.pkg.tar.zst'));
  w(path.join(bar, 'bar-2:2.9-1-any.pkg.tar.zst'));

  w(H('.cache/yay/gone/.SRCINFO'), 'pkgbase = gone\npkgname = gone\n');
  w(H('.cache/yay/gone/gone-1-1-any.pkg.tar.zst'), 'x'.repeat(5000));
  w(H('.cache/yay/mystery/data.bin'));          // no .SRCINFO: not ours to judge
  w(H('.cache/yay/completion.cache'));          // yay's own file

  const out = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  // A
  keep.forEach((p) => assert.strictEqual(fs.readFileSync(p, 'utf8'), 'KEEP', `touched: ${p}`));
  // B
  fooKeep.forEach((f) => assert.ok(exists(path.join(foo, f)), `yay kept file removed: ${f}`));
  fooGone.forEach((f) => assert.ok(!exists(path.join(foo, f)), `yay junk left: ${f}`));
  assert.ok(!exists(path.join(foo, 'src')) && !exists(path.join(foo, 'pkg')), 'src/pkg left');
  assert.ok(exists(path.join(bar, 'bar-2:3.0-1-any.pkg.tar.zst')), 'epoch: current removed');
  assert.ok(!exists(path.join(bar, 'bar-2:2.9-1-any.pkg.tar.zst')), 'epoch: old left');
  assert.ok(!exists(H('.cache/yay/gone')), 'uninstalled program folder left');
  assert.ok(exists(H('.cache/yay/mystery/data.bin')), 'unknown folder touched');
  assert.ok(exists(H('.cache/yay/completion.cache')), 'yay completion cache touched');
  assert.match(out, /✓ Old program installers \(yay\): [\d.]+[KMG]?B freed/);
  // C
  const lines = out.split('\n');
  assert.ok(!lines.some((l) => /^\s*0\s*$/.test(l)), 'a lone «0» line is back:\n' + out);
  assert.match(out, /\n {2}Spotify music: [\d.]+[KMG]?B\n/);
  // D
  assert.ok(!/Pulizia|liberat|Cestino|Miniature|pacchetti/i.test(out), 'Italian left in report:\n' + out);
  assert.match(out, /Trash: [\d.]+[KMG]?B/);
  console.log('system-cleanup: OK — junk out, everything regenerable or personal left in place');
} finally {
  if (locked) try { fs.chmodSync(locked, 0o755); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
