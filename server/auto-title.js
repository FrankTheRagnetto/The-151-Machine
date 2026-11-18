'use strict';

// [03/11/2026] Il nome di una sessione: «the name of their team and if
// the team has subprojects take the name of the subproject, that is it.»
//   - La squadra la dice il comando del primo messaggio (/apps, /pi, /upgrade…):
//     nessuna ipotesi. Squadra senza sottoprogetti → il suo nome, subito, senza
//     chiedere a nessuno («Pi», «Upgrade», «3D Printing»).
//   - Squadra con sottoprogetti (es. Apps → i suoi progetti) → Sonnet sceglie SOLO fra
//     i sottoprogetti di QUELLA squadra. Non lo capisce → intanto il nome della
//     squadra, e si riprova al secondo messaggio; ancora niente → resta quello.
//   - Nessun comando → Sonnet sceglie fra tutti i nomi (squadre e
//     sottoprogetti); vago → «New session» e si riprova; poi «Other».
//   - Claude non risponde → se la squadra è nota, il suo nome (mai senza nome).
//   - Un nome dato a mano non si tocca; i super agenti numerati restano numerati.
// Le liste: server/area-names.js (lette ogni volta). Le aree di lavoro di chi usa
// l'app: «titleAreas» del file delle squadre (server/squadre.js); vuoto = nessuna
// area nel prompt. Prova: tests/nomi-area.test.js.

const os = require('os');
const { execFile } = require('child_process');
const { oneShotArgs } = require('./oneshot-args');
const { loadTeams, teamDaComando, matchName, tuttiINomi, OTHER } = require('./area-names');
const squadre = require('./squadre');

module.exports = function createAutoTitle({ manager, wss, CLAUDE_BIN, teams: leggiSquadre = loadTeams,
  aree: leggiAree = () => squadre.leggi().titleAreas || '' }) {

  function callClaudeOneShot(prompt, tag, timeoutMs = 30000) {
    return new Promise((resolve) => {
      // ISOLATED one-shot (audit 2026-08-20): no MCP, no user settings/skills,
      // no tool schemas, no transcript on disk. See server/oneshot-args.js.
      execFile(CLAUDE_BIN, oneShotArgs(prompt, {
        system: 'You pick the name of a work session from a fixed list. Output only the name, copied exactly.',
        // [17/10/2026] Sonnet, non Haiku: Haiku sbagliava fra nomi vicini.
        model: 'sonnet',
      }), {
        timeout: timeoutMs,
        cwd: os.tmpdir(),
        encoding: 'utf-8',
      }, (err, stdout) => {
        if (err) {
          console.log(`[AUTO-TITLE] ${tag} Claude CLI failed:`, err.message);
          resolve(null);
          return;
        }
        resolve((stdout || '').trim());
      });
    });
  }

  // Non si nomina: chi ha già un nome, chi è stato rinominato a mano, la flotta.
  function daNonToccare(s) {
    return !s || s.manuallyRenamed || s.autoTitled || !!s.agentType;
  }

  function annuncia(sessionId, title) {
    const renameMsg = JSON.stringify({ type: 'session_renamed', id: sessionId, title });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try { client.send(renameMsg); } catch {}
      }
    });
  }

  // definitivo=false: il nome della squadra mentre si aspetta il sottoprogetto.
  function applyAutoTitle(sessionId, title, definitivo = true) {
    const session = manager.sessions.get(sessionId);
    if (!session) return;
    session.title = title;
    session.autoTitled = definitivo;
    session.deferredAutoTitle = !definitivo;
    manager.save();
    annuncia(sessionId, title);
    console.log(`[AUTO-TITLE] ${sessionId.slice(0, 8)} → "${title}"${definitivo ? '' : ' (squadra; il sottoprogetto al secondo messaggio)'}`);
  }

  function righe(voci) {
    return voci.map((v) => '- "' + v.name + '"' + (v.hint ? ' — ' + v.hint : '')).join('\n');
  }

  // Le voci fra cui scegliere: i sottoprogetti della squadra, o (senza squadra)
  // tutte le squadre e tutti i sottoprogetti.
  function vociPer(team, teams) {
    if (team) return team.subprojects;
    const out = [];
    for (const t of teams) {
      out.push({ name: t.name, hint: 'team /' + t.id + (t.hint ? ' — ' + t.hint : '') + (t.subprojects.length ? ' — only if none of its projects fits' : '') });
      for (const s of t.subprojects) out.push({ name: s.name, hint: s.hint + ' (team /' + t.id + ')' });
    }
    return out;
  }

  function prompt(team, voci, inizio, ultimaRiga) {
    const cosa = team
      ? `The session belongs to the team "${team.name}" (/${team.id}). Pick which of ITS projects the work is on.`
      : 'Pick the team or project the work is on.';
    const aree = String(leggiAree() || '').trim();
    return `Name a session in a session-list UI.
${cosa}
${aree ? `\nThe user's work areas (context only): ${aree.slice(0, 1000)}\n` : ''}
Names ("name" — what it is):
${righe(voci)}

${inizio}

Rules:
- If the text names one of these projects, that is the name.
- If the work touches two, pick the main one (the one the user asks to work on).
- If the work is on none of these projects in particular, do not force one.
- Reply with the quoted name, copied EXACTLY (without the quotes). Never a word from the descriptions, never an invented name.
${ultimaRiga}`;
  }

  async function scegli(sessionId, stage, inizio) {
    const session = manager.sessions.get(sessionId);
    const teams = leggiSquadre();
    const firstUser = session.history.find(m => m.role === 'user');
    const team = teamDaComando(firstUser && firstUser.content, teams);
    const tag = `${sessionId.slice(0, 8)}/stage${stage}`;

    if (team && !team.subprojects.length) return { team, name: team.name };

    const voci = vociPer(team, teams);
    const ammessi = team ? voci.map((v) => v.name) : tuttiINomi(teams);
    const ultima = team
      ? '- If you cannot tell which project, reply NONE.\n\nReply with one name from the list, or NONE. Nothing else.'
      : '- If the text is too vague to tell (a greeting, a generic question), reply UNCLEAR.\n\nReply with one name from the list, or UNCLEAR. Nothing else.';
    const raw = await callClaudeOneShot(prompt(team, voci, inizio, ultima), tag);
    if (raw == null) return { team, name: null, giu: true };
    const name = matchName(raw, ammessi);
    if (!name) console.log(`[AUTO-TITLE] ${tag} ${JSON.stringify(String(raw).slice(0, 40))} — nessun nome della lista`);
    return { team, name };
  }

  async function generateAutoTitleStage1(sessionId) {
    const session = manager.sessions.get(sessionId);
    if (daNonToccare(session)) return;
    const firstUser = session.history.find(m => m.role === 'user');
    if (!firstUser) return;

    const inizio = `FIRST user message of the session:\n"""\n${(firstUser.content || '').slice(0, 400)}\n"""`;
    const { team, name, giu } = await scegli(sessionId, 1, inizio);
    if (daNonToccare(manager.sessions.get(sessionId))) return;

    if (name) return applyAutoTitle(sessionId, name);
    // Squadra nota ma sottoprogetto non chiaro (o Claude giù): intanto la squadra.
    if (team) return applyAutoTitle(sessionId, team.name, !!giu);
    if (giu) return; // nessuna squadra e Claude giù: si riprova al secondo messaggio
    const sNow = manager.sessions.get(sessionId);
    sNow.deferredAutoTitle = true;
    manager.save();
    console.log(`[AUTO-TITLE] ${sessionId.slice(0, 8)}/stage1 nessun nome ancora, si riprova al secondo messaggio`);
  }

  async function generateAutoTitleStage2(sessionId) {
    const session = manager.sessions.get(sessionId);
    if (daNonToccare(session)) return;
    if (!session.deferredAutoTitle) return;

    const userMsgs = session.history.filter(m => m.role === 'user');
    const firstAssistant = session.history.find(m => m.role === 'assistant');
    if (userMsgs.length < 2) return;
    const inizio = `Start of the session:
User: ${(userMsgs[0].content || '').slice(0, 300)}
Assistant: ${firstAssistant ? (firstAssistant.content || '').slice(0, 300) : ''}
User: ${(userMsgs[1].content || '').slice(0, 300)}`;

    const { team, name } = await scegli(sessionId, 2, inizio);
    if (daNonToccare(manager.sessions.get(sessionId))) return;
    applyAutoTitle(sessionId, name || (team ? team.name : OTHER));
  }

  return { generateAutoTitleStage1, generateAutoTitleStage2 };
};
