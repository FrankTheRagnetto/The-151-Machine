'use strict';
/**
 * The 151 Machine — Super agents, the list of agents (
 * «there's no way for me to remove super agents or add super agents»).
 * GET /api/plugins/super-agents/agents → every agent il proprietario can open: one per
 * file in ~/.claude/commands/ (the agents themselves, read at every call, so an
 * agent born or retired tomorrow shows up or goes away by itself). Name = the
 * words before the dash of its «description». Left out: the model file and the
 * gestures that are not agents (wrap, post-seduta). Nothing of the owner's is
 * written here: another person's agents are another folder.
 * Proof: tests/super-agenti.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const NON_AGENTI = new Set(['_template', 'wrap', 'post-seduta']);
const KEY_RE = /^[a-z0-9-]{1,32}$/;

function nomeDa(testo, key) {
  const m = String(testo || '').match(/^description:\s*"?([^"\n]*)/m);
  const d = m ? m[1] : '';
  // «Apps 📱 — una porta sola…» → «Apps»: le parole prima del trattino, senza emoji
  const testa = d.split(/\s[—–-]\s/)[0].replace(/[^\p{L}\p{N}\s'&.-]/gu, '').trim();
  return testa || key.charAt(0).toUpperCase() + key.slice(1);
}

function elenco(dir) {
  let nomi = [];
  try { nomi = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const f of nomi) {
    if (!f.endsWith('.md')) continue;
    const key = f.slice(0, -3);
    if (NON_AGENTI.has(key) || !KEY_RE.test(key)) continue;
    let testo = '';
    try { testo = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 2000); } catch (_) {}
    out.push({ key, name: nomeDa(testo, key), command: '/' + key });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  _test: { elenco, nomeDa },
  activate() {
    return {
      registerRoutes(router) {
        router.get('/agents', (_req, res) => {
          res.json({ agents: elenco(path.join(os.homedir(), '.claude', 'commands')) });
        });
      },
    };
  },
};
