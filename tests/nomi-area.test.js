'use strict';
// [03/11/2026] I nomi delle sessioni: «the name of their team and if the
// team has subprojects take the name of the subproject, that is it.»
// Prova pura: fonti FINTE in una cartella temporanea (index.md,
// colori.json), CLI finto (uno script che risponde quello che gli si dice e si
// segna il prompt, o che non c'è). Nessuna rete. I casi sono quelli veri del
// 26/10–03/11 che avevano preso il nome sbagliato o nessun nome.
const fs = require('fs');
const os = require('os');
const path = require('path');

let ok = 0, failed = 0;
const check = (c, l) => { if (c) { ok++; console.log('  ok   ' + l); } else { failed++; console.log('  FAIL ' + l); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-area-'));
// Nessun file delle squadre vero: la prova non dipende dalla casa di chi la lancia.
process.env.MACHINE_SQUADRE = path.join(tmp, 'squadre-assente.json');
const dir = path.join(tmp, 'projects');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'index.md'), [
  '# Projects Index',
  '## Attivi',
  '- [Shop](shop.md) -- online shop. Team: /shop',
  '- [Shop — invoices](shop-invoices.md) -- satellite of Shop. Team: /shop',
  '- [Game Studio](game-studio.md) -- the games hub. Team: /games',
  '- [The 151 Machine](151-machine.md) -- Server personale + app web + plugin. Team: /apps',
  '- [151 Entertainment](151-entertainment.md) -- App Android dell\'intrattenimento. Team: **/apps** (creata 2026-10-09)',
  '- [Personal Cloud](personal-cloud.md) -- backup notturno. Team: /apps',
  '- [Sound Rig](music.md) -- the music rig. Team: /music',
  '- [Money](money.md) -- home budget. Team: /money',
  '- [Taxes](taxes.md) -- taxes. Team: /money',
  '- [The 151 TV](pi.md) -- la TV di casa. Team: /pi',
  '- [Stampa 3D](3d-printer.md) -- Ender 3. Team: /3dprinting',
  '- [Other](other.md) -- the fallback inbox. Team: /overseer',
  '- [MPK Firmware](mpk-firmware.md) -- firmware. Team: /music',
  '## Congelati',
  '- [Zoing!](zoing.md) -- Gioco di carte. Team: /games',
  '- [Grabber](grabber.md) -- CONGELATO. Team: /apps',
  '## Completati',
  '- [Internship Hours](internship.md) -- COMPLETATO. Team: /apps',
  '## Archiviati',
  '- [The 151 Raspberry](pi-old.md) -- ARCHIVIATO. Team: /pi',
  '- [Rally Vecchio](rally.md) -- ARCHIVIATO. Team: /games',
].join('\n'));
const colori = path.join(tmp, 'colori.json');
const pref = { lead: 'Lead', apps: 'Apps', shop: 'Shop', games: 'Games', music: 'Music', money: 'Money', pi: 'Pi',
  upgrade: 'Upgrade', overseer: 'Overseer', '3dprinting': '3D Printing', hack: 'Hack' };
fs.writeFileSync(colori, JSON.stringify({ squadre: Object.fromEntries(Object.entries(pref).map(([k, v]) => [k, { prefisso: v }])) }));

const an = require('../server/area-names');

// ---- le squadre ----
const teams = an.loadTeams(dir, colori);
const T = (id) => teams.find((t) => t.id === id);
const sotto = (id) => (T(id) ? T(id).subprojects.map((s) => s.name) : null);
check(T('pi').name === 'Pi' && sotto('pi').length === 0, 'squadra con un progetto solo (/pi → The 151 TV): nessun sottoprogetto, il nome è «Pi»');
check(T('3dprinting').name === '3D Printing' && sotto('3dprinting').length === 0, 'il nome della squadra è quello di colori.json («3D Printing», non «Stampa 3D»)');
check(T('upgrade') && sotto('upgrade').length === 0, 'squadra senza progetti (/upgrade) c\'è lo stesso');
check(['151 Machine', '151 Entertainment', 'Personal Cloud'].every((n) => sotto('apps').includes(n)), 'Apps: i suoi progetti sono i sottoprogetti (senza «The»)');
check(JSON.stringify(sotto('shop')) === '[]', 'Shop: a satellite is not a subproject (one project = no subprojects)');
check(sotto('games').length === 0, 'Games: gli archiviati e i congelati non contano → un progetto solo = nessun sottoprogetto');
check(JSON.stringify(sotto('music')) === JSON.stringify(['Sound Rig', 'MPK Firmware']), 'Music: MPK sotto «## Attivi» conta');
// [11/11/2026] #fhhl: solo «## Attivi» dà nomi d'area.
check(!sotto('apps').includes('Grabber'), 'un progetto sotto «## Congelati» non dà nome d\'area');
check(!sotto('apps').includes('Internship Hours'), 'un progetto sotto «## Completati» non dà nome d\'area');
check(!an.tuttiINomi(teams).includes('Zoing!') && !an.tuttiINomi(teams).includes('Grabber') && !an.tuttiINomi(teams).includes('Internship Hours'), 'congelati e completati non stanno fra tutti i nomi');
const sezioni = (t) => an.daIndice(t).map((x) => x.name);
check(JSON.stringify(sezioni('## Attivi\n- [Uno](u.md) -- x. Team: /apps')) === '["Uno"]', 'un progetto sotto «## Attivi» sì');
check(sezioni('## Active\n- [Uno](u.md) -- x. Team: /apps\n## Paused\n- [Due](d.md) -- x. Team: /apps\n## Ferme\n- [Tre](t.md) -- x. Team: /apps\n## Completate\n- [Quattro](q.md) -- x. Team: /apps').length === 0, 'i nomi vecchi (Active/Paused/Ferme/Completate) non valgono più');
check(sezioni('## Congelati\n- [Uno](u.md) -- x. Team: /apps\n## Completati\n- [Due](d.md) -- x. Team: /apps\n## Archiviati\n- [Tre](t.md) -- x. Team: /apps').length === 0, 'Congelati, Completati, Archiviati: nessun progetto');
check(sotto('overseer').length === 0, 'Overseer: «Other» è la sua casella, non un sottoprogetto');
const vuote = an.loadTeams(path.join(tmp, 'non-esiste'), path.join(tmp, 'non-esiste.json'));
check(Array.isArray(vuote) && vuote.length === 0, 'fonti assenti → nessuna squadra (e lo dice nel log), niente crash');

// ---- il comando ----
const cmd = (t) => (an.teamDaComando(t, teams) || {}).id || null;
check(cmd('/apps rebuild the APK from the psx-kit pack') === 'apps', 'comando in testa');
check(cmd('read ~/work/handoff-music.md /music') === 'music', 'comando in fondo al messaggio');
check(cmd('/home/user/Projects/x è rotto') === null, 'un percorso non è una squadra');
check(cmd('AGENTE: /hack — guarda il login') === 'hack', '«AGENTE: /hack —»');
check(cmd('/shop SERVE /money: il controllo') === 'shop', 'vale il primo comando');
check(cmd('Note 26/10: misurare sulla TV') === null, 'nessun comando → nessuna squadra');
check(cmd('Read the plan, including the two "/apps" sections. /music') === 'music', 'una squadra fra virgolette è citata, non è il comando');
check(/151 TV/.test(T('pi').hint || ''), 'la squadra con un progetto solo porta la sua descrizione (Pi = la TV)');

// ---- la risposta del modello ----
check(an.matchName('151 entertainment', sotto('apps')) === '151 Entertainment', 'match: maiuscole diverse → nome della lista');
check(an.matchName('"MPK Firmware"\n', sotto('music')) === 'MPK Firmware', 'match: virgolette e a capo tolti');
check(an.matchName('Personal Cloud', sotto('music')) === null, 'match: un nome di un\'ALTRA squadra non passa');
check(an.matchName('MACHINE DEBUG', an.tuttiINomi(teams)) === null, 'match: un nome inventato non passa');

// ---- il nome automatico ----
const bin = path.join(tmp, 'claude-finto.sh');
const argsFile = path.join(tmp, 'args.txt');
fs.writeFileSync(bin, '#!/bin/sh\necho chiamato >> "$FAKE_CALLS_FILE"\nprintf "%s\\n" "$@" > "$FAKE_ARGS_FILE"\n[ "$FAKE_TITLE_REPLY" = GIU ] && exit 1\nprintf "%s\\n" "$FAKE_TITLE_REPLY"\n');
fs.chmodSync(bin, 0o755);
process.env.FAKE_ARGS_FILE = argsFile;
const callsFile = path.join(tmp, 'calls.txt');
process.env.FAKE_CALLS_FILE = callsFile;
const chiamate = () => { try { return fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

const createAutoTitle = require('../server/auto-title');
const sessions = new Map();
const manager = { sessions, save() {} };
const renamed = [];
const wss = { clients: new Set([{ readyState: 1, send: (m) => renamed.push(JSON.parse(m)) }]) };
const at = createAutoTitle({ manager, wss, CLAUDE_BIN: bin, teams: () => teams });
let n = 0;
const nuova = (primo, extra) => {
  const id = `sess${++n}-xxxx`;
  const s = Object.assign({ id, title: 'New session', history: [{ role: 'user', content: primo }] }, extra || {});
  sessions.set(id, s); return s;
};
const risponde = (r) => { process.env.FAKE_TITLE_REPLY = r; };
const secondo = (s, testo) => s.history.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: testo });

(async () => {
  try {
    // Squadra senza sottoprogetti: subito, senza chiedere a Claude.
    risponde('151 Entertainment');
    let prima = chiamate();
    const pi = nuova('/pi I have the tplink bluetooth tower and the two new controllers.');
    await at.generateAutoTitleStage1(pi.id);
    check(pi.title === 'Pi' && pi.autoTitled === true, '/pi → «Pi» (prima: «151 TV» o «151 Entertainment»)');
    check(chiamate() === prima, '/pi: nessuna chiamata a Claude (il nome è certo)');
    const up = nuova('/upgrade study the agent.');
    await at.generateAutoTitleStage1(up.id);
    check(up.title === 'Upgrade', '/upgrade → «Upgrade» (prima: «Other»)');
    const st = nuova('/3dprinting I have the new printer part');
    await at.generateAutoTitleStage1(st.id);
    check(st.title === '3D Printing', '/3dprinting → «3D Printing», sempre lo stesso');
    check(renamed.some((m) => m.type === 'session_renamed' && m.id === pi.id && m.title === 'Pi'), 'la lista Sessions riceve il nome');

    // Squadra con sottoprogetti: Claude sceglie SOLO fra quelli della squadra.
    risponde('151 Entertainment');
    const ent = nuova('/apps yo, my phone is connected. Can we debug the entertainment app?');
    await at.generateAutoTitleStage1(ent.id);
    check(ent.title === '151 Entertainment' && ent.autoTitled === true, '/apps sull\'Entertainment → «151 Entertainment»');
    const p = fs.readFileSync(argsFile, 'utf8');
    check(/151 Machine/.test(p) && /Personal Cloud/.test(p) && !/MPK Firmware/.test(p) && !/"Pi"/.test(p), 'il prompt porta solo i progetti di Apps');
    check(/--model\nsonnet\n/.test(p), 'la scelta la fa Sonnet');

    risponde('Sound Rig');
    const sbagliato = nuova('/apps rebuild the APK from the psx-kit pack');
    await at.generateAutoTitleStage1(sbagliato.id);
    check(sbagliato.title === 'Apps' && !sbagliato.autoTitled && sbagliato.deferredAutoTitle, '/apps, risposta fuori squadra → intanto «Apps», si riprova al secondo messaggio');
    risponde('NONE');
    secondo(sbagliato, 'it is for the PS1 games');
    await at.generateAutoTitleStage2(sbagliato.id);
    check(sbagliato.title === 'Apps' && sbagliato.autoTitled === true, 'ancora non chiaro → resta «Apps» (mai «Personal Cloud»)');

    risponde('NONE');
    const ee = nuova('/music');
    await at.generateAutoTitleStage1(ee.id);
    check(ee.title === 'Music' && ee.deferredAutoTitle, '/music da solo → «Music» subito');
    risponde('mpk firmware');
    secondo(ee, 'the keyboard firmware');
    await at.generateAutoTitleStage2(ee.id);
    check(ee.title === 'MPK Firmware' && ee.autoTitled, '…al secondo messaggio il sottoprogetto');

    // Claude giù: con la squadra nota, mai senza nome.
    risponde('GIU');
    const giu = nuova('/music the mixer does not open');
    await at.generateAutoTitleStage1(giu.id);
    check(giu.title === 'Music' && giu.autoTitled === true, 'Claude non risponde → il nome della squadra («Music»)');

    // Nessun comando: sceglie fra tutti i nomi.
    risponde('Pi');
    const nocmd = nuova('The Pi now has Prometheus attached at /mnt/prometheus');
    await at.generateAutoTitleStage1(nocmd.id);
    check(nocmd.title === 'Pi', 'senza comando → un nome della lista (squadra)');
    const tutti = fs.readFileSync(argsFile, 'utf8');
    check(/"Pi"/.test(tutti) && /MPK Firmware/.test(tutti) && /151 Entertainment/.test(tutti), 'senza comando il prompt porta squadre e sottoprogetti');

    check(!/work areas/.test(tutti), 'senza «titleAreas» nessuna area nel prompt');
    // «titleAreas» del file delle squadre: entra nel prompt, solo come contesto.
    const atAree = createAutoTitle({ manager, wss, CLAUDE_BIN: bin, teams: () => teams, aree: () => 'Writing, Garden' });
    risponde('Pi');
    const conAree = nuova('something about the garden');
    await atAree.generateAutoTitleStage1(conAree.id);
    check(/work areas \(context only\): Writing, Garden/.test(fs.readFileSync(argsFile, 'utf8')), 'con «titleAreas» le aree stanno nel prompt');

    risponde('UNCLEAR');
    const vaga = nuova('ciao');
    await at.generateAutoTitleStage1(vaga.id);
    check(vaga.title === 'New session' && vaga.deferredAutoTitle, 'vago e senza comando → «New session», si riprova');
    secondo(vaga, 'niente, una domanda generale');
    await at.generateAutoTitleStage2(vaga.id);
    check(vaga.title === 'Other' && vaga.autoTitled, 'ancora niente → «Other»');

    // Chi non si tocca.
    risponde('151 Machine');
    const dir_ = nuova('/lead', { title: 'LEAD 129', agentType: 'Lead', agentNumber: 129 });
    await at.generateAutoTitleStage1(dir_.id);
    check(dir_.title === 'LEAD 129' && !dir_.autoTitled, 'i super agenti numerati restano numerati');
    const mano = nuova('/apps x', { title: 'Il mio nome', manuallyRenamed: true });
    await at.generateAutoTitleStage1(mano.id);
    check(mano.title === 'Il mio nome', 'un nome dato a mano non si tocca');
    const rinominata = nuova('/apps rebuild', {});
    risponde('NONE');
    await at.generateAutoTitleStage1(rinominata.id);
    rinominata.manuallyRenamed = true; rinominata.title = 'Mio';
    secondo(rinominata, 'the entertainment one');
    risponde('151 Entertainment');
    await at.generateAutoTitleStage2(rinominata.id);
    check(rinominata.title === 'Mio', 'rinominata a mano fra il primo e il secondo messaggio: resta la scelta a mano');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`nomi-area: ${ok} verdi, ${failed} rossi`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
