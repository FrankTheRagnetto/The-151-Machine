#!/usr/bin/env node
'use strict';

// =============================================================================
// LA PROVA DELL'ISTANZA USA-E-GETTA
// (P4 del verdetto C6 — strada scelta il 12/09/2026.)
//
// IL GUASTO CHE L'ISTANZA CHIUDE: i passi 3 e 4 del cancello bussavano alla
// Machine VIVA, che serve il codice del suo ultimo avvio — e l'avvio è solo di
// il proprietario (legge 4). Quindi 26 degli ultimi 40 commit sono stati provati sul codice
// VECCHIO, e il cancello lo scriveva come avviso e committava comunque.
//
// QUESTA PROVA NON GIUDICA SE L'ISTANZA È COMODA. Giudica quattro cose, che sono
// esattamente le quattro che il proprietario ha messo per iscritto ordinando il lavoro:
//   1. che provi il WORKING TREE (e che se il diff non è dentro, vada rosso);
//   2. che NON sfiori la Machine viva né i dati veri;
//   3. che MUOIA SEMPRE — spenta a mano, col cancello interrotto, e col
//      cancello ucciso di SIGKILL, dove nessun trap può girare;
//   4. che il limitatore di /api/login muoia con lei (il 429 che rendeva il
//      cancello non ripetibile entro 60 secondi).
//
// Uso:  node tests/gate-istanza.test.js      (puro — entra da solo in npm test)
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ISTANZA = path.join(ROOT, 'tools', 'gate-istanza.sh');

let ok = 0;
const rotti = [];
function prova(nome, cond, dettaglio) {
  if (cond) { ok++; console.log(`  ✓ ${nome}`); }
  else { rotti.push(nome + (dettaglio ? ` — ${dettaglio}` : '')); console.log(`  ✗ ${nome}${dettaglio ? ` — ${dettaglio}` : ''}`); }
}

// Esegue uno spezzone di bash col sanificatore e il lanciatore già sorgentati.
// Lo stesso modo in cui li usa tools/gate.sh, così la prova non inventa un
// secondo modo di accendere l'istanza che potrebbe divergere da quello vero.
function bash(corpo, opz) {
  const r = spawnSync('bash', ['-c', `set -uo pipefail\ncd "${ROOT}"\n. tools/gate-istanza.sh\n${corpo}`], {
    cwd: ROOT, encoding: 'utf8', timeout: (opz && opz.timeout) || 120000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('── PROVA DELL\'ISTANZA USA-E-GETTA DEL CANCELLO ──');

// ── A) esiste, si accende, e non è la Machine del proprietario ────────────────────────
console.log('\nA) si accende su una porta sua, e risponde');
prova('tools/gate-istanza.sh esiste', fs.existsSync(ISTANZA));

const accesa = bash(`
  gate_istanza_accendi >/dev/null 2>&1 || { echo "ACCENSIONE-FALLITA"; exit 1; }
  echo "PORTA=$GATE_ISTANZA_PORTA"
  echo "DIR=$GATE_ISTANZA_DIR"
  echo "SALUTE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$GATE_ISTANZA_BASE/api/health")"
  echo "SESSIONI=$(curl -s -m 5 "$GATE_ISTANZA_BASE/api/health" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).sessions')"
  # isolamento: i depositi dell'istanza stanno DENTRO la copia
  [ -d "$GATE_ISTANZA_DIR/system" ] && echo "SYSTEM-SUO=si"
  # ATTENZIONE alla lettura di questa riga: dopo l'accensione il file ESISTE
  # quasi sempre, perché l'istanza scrive il PROPRIO deposito (vuoto) al primo
  # salvataggio. Non è una copia: la domanda giusta non è «il file c'è?» ma
  # «è il file del proprietario?». Si risponde byte per byte.
  if [ -f "$GATE_ISTANZA_DIR/server/sessions.json" ] \
     && cmp -s server/sessions.json "$GATE_ISTANZA_DIR/server/sessions.json"; then
    echo "SESSIONI-VERE-COPIATE=si"
  else
    echo "SESSIONI-VERE-COPIATE=no"
  fi
  [ -d "$GATE_ISTANZA_DIR/casa" ] && echo "CASA-FINTA=si"
  # il diff è dentro?
  gate_istanza_prova_il_diff
  gate_istanza_spegni
  [ -d "$GATE_ISTANZA_DIR" ] && echo "COPIA-RESTA=si" || echo "COPIA-RIMOSSA=si"
`);
const val = (k) => { const m = accesa.out.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
prova('l\'istanza si accende e risponde 200 su /api/health', val('SALUTE') === '200', accesa.out.slice(-800));
const porta = Number(val('PORTA'));
prova('la porta NON è la 3170 del proprietario', porta > 1024 && porta !== 3170, `porta: ${porta}`);
prova('la copia sta in /tmp, non nel repo', String(val('DIR') || '').startsWith('/tmp/gate-istanza-'), val('DIR'));

// ── B) non sfiora i dati veri ───────────────────────────────────────────────
console.log('\nB) non sfiora la Machine viva né i dati veri');
prova('parte con ZERO sessioni (quelle del proprietario non ci sono)', val('SESSIONI') === '0', `sessioni: ${val('SESSIONI')}`);
prova('il sessions.json dell\'istanza NON è quello del proprietario (ne scrive uno suo, vuoto)',
  val('SESSIONI-VERE-COPIATE') === 'no');
prova('ha un suo system/ (restart-intent suo, non quello del repo)', val('SYSTEM-SUO') === 'si');
prova('ha una casa finta (os.homedir → ~/.151machine di scarto)', val('CASA-FINTA') === 'si');
// [2026-10-12] Portali usciti dalla Machine: l'istanza non deve più
// nemmeno toccare la cassaforte dei login dei portali (né l'originale né una copia).
prova('il lanciatore non tocca più la cassaforte dei portali',
  !/[a-z0-9]-sessions\.json|_SESSION_STORE/i.test(fs.readFileSync(ISTANZA, 'utf8')));

// La Machine viva, se è accesa, deve essere ancora accesa dopo tutto questo.
const vivo = spawnSync('curl', ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3170/api/health'], { encoding: 'utf8' });
if ((vivo.stdout || '').trim() === '200') {
  prova('la Machine viva è ancora in piedi dopo l\'accensione e lo spegnimento dell\'istanza', true);
} else {
  console.log('    (la Machine viva è spenta: salto il controllo — e NON è un rosso:');
  console.log('     dal 12/09 il cancello prova il diff anche con la Machine spenta)');
}

// ── C) il diff è DENTRO — e se non lo è, è rosso ─────────────────────────────
console.log('\nC) la prova che il lavoro è dentro l\'istanza');
prova('a copia sana, gate_istanza_prova_il_diff dice sì',
  /tutti i \d+ file del tuo lavoro sono DENTRO l'istanza|nessun file nel diff/.test(accesa.out), accesa.out.slice(-500));

// Il controllo positivo non basta: va provato che SA DIRE NO. Si guasta la copia
// a mano — si sporca un file che esiste di sicuro — e si guarda se se ne accorge.
// È il guasto che conta davvero: una lista di file sbagliata farebbe nascere
// un'istanza SENZA il diff, e il cancello tornerebbe a provare il codice vecchio
// senza dirlo a nessuno.
const guastata = bash(`
  gate_istanza_accendi >/dev/null 2>&1 || { echo "ACCENSIONE-FALLITA"; exit 1; }
  echo "// sporcato dalla prova" >> "$GATE_ISTANZA_DIR/tools/gate-istanza.sh"
  if gate_istanza_prova_il_diff > /tmp/.esito-guasto 2>&1; then echo "VERDETTO=passa"; else echo "VERDETTO=rosso"; fi
  grep -q "gate-istanza.sh" /tmp/.esito-guasto && echo "NOMINA-IL-FILE=si"
  rm -f /tmp/.esito-guasto
  gate_istanza_spegni
`);
// Il file sporcato è fra quelli del diff solo se il diff lo contiene: oggi sì
// (è nuovo), ma per non legare la prova al diff di oggi si accetta l'esito
// "rosso" OPPURE la spiegazione che quel file non era nel diff.
if (/VERDETTO=/.test(guastata.out)) {
  const rosso = /VERDETTO=rosso/.test(guastata.out);
  const inDiff = spawnSync('bash', ['-c',
    '{ git --no-pager diff HEAD --name-only; git ls-files --others --exclude-standard; } | grep -qx "tools/gate-istanza.sh"'],
  { cwd: ROOT }).status === 0;
  if (inDiff) {
    prova('una copia GUASTATA manda rosso il controllo (e nomina il file)',
      rosso && /NOMINA-IL-FILE=si/.test(guastata.out), guastata.out.slice(-400));
  } else {
    console.log('    (tools/gate-istanza.sh non è nel diff di oggi: il caso negativo');
    console.log('     non è esigibile senza sporcare il repo — salto, non mento)');
  }
} else {
  prova('il banco di prova del caso negativo gira', false, guastata.out.slice(-400));
}

// ── D) MUORE SEMPRE — la condizione che il proprietario ha scritto per prima ────────────
// «Niente processi orfani e niente porte occupate: quello diventerebbe un guasto
// nuovo peggiore di quello che curiamo.» Tre modi di morire, tre prove.
console.log('\nD) muore SEMPRE (spenta a mano · col cancello interrotto · col cancello UCCISO)');
prova('spenta a mano: la copia è rimossa', /COPIA-RIMOSSA=si/.test(accesa.out), accesa.out.slice(-300));

// D.1 — lo spegnimento è idempotente: il trap lo chiama di nuovo all'uscita,
// dopo che il cancello l'ha già chiamato a mano al passo 4.
const due = bash(`
  gate_istanza_accendi >/dev/null 2>&1 || exit 1
  gate_istanza_spegni
  gate_istanza_spegni
  echo "DUE-VOLTE=ok"
`);
prova('chiamare spegni DUE volte non produce errori (il trap lo fa sempre)',
  /DUE-VOLTE=ok/.test(due.out) && due.code === 0, due.out.slice(-300));

// D.2 — il cancello UCCISO di SIGKILL. Nessun trap gira. Deve bastare la
// guardia, che è un processo separato e non dipende dal cancello per morire.
// Questa è LA prova della condizione 4: tutto il resto sarebbe «sperato».
const segnale = path.join(os.tmpdir(), 'prova-istanza-sigkill-' + process.pid + '.txt');
try { fs.unlinkSync(segnale); } catch {}
const vittima = spawnSync('bash', ['-c', `
  set -uo pipefail
  cd "${ROOT}"
  . tools/gate-istanza.sh
  gate_istanza_accendi >/dev/null 2>&1 || exit 1
  echo "$GATE_ISTANZA_PID $GATE_ISTANZA_DIR $GATE_ISTANZA_PORTA" > "${segnale}"
  # Si suicida di SIGKILL: nessun trap può girare, esattamente come se qualcuno
  # facesse \`kill -9\` sul cancello o il terminale morisse di brutto.
  kill -KILL $$
`], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });

let datiVittima = null;
try { datiVittima = fs.readFileSync(segnale, 'utf8').trim().split(/\s+/); } catch {}
if (!datiVittima || datiVittima.length < 3) {
  prova('il banco di prova del SIGKILL ha acceso un\'istanza', false,
    `segnale assente — uscita=${vittima.status}`);
} else {
  const [pidMorto, dirMorta, portaMorta] = datiVittima;
  // La guardia controlla il padre una volta al secondo: si concede margine, e
  // si misura quanto ci mette davvero (se un giorno diventa lenta si vede).
  const t0 = Date.now();
  let viva = true; let cartella = true;
  for (let i = 0; i < 100; i++) {
    viva = spawnSync('kill', ['-0', pidMorto]).status === 0;
    cartella = fs.existsSync(dirMorta);
    if (!viva && !cartella) break;
    spawnSync('sleep', ['0.2']);
  }
  const dopo = Date.now() - t0;
  prova('cancello UCCISO di SIGKILL → l\'istanza muore comunque (la guardia)', !viva, `pid ${pidMorto} ancora vivo dopo ${dopo}ms`);
  prova('…e la copia di scarto viene rimossa comunque', !cartella, `${dirMorta} esiste ancora dopo ${dopo}ms`);
  console.log(`    (la guardia ha chiuso in ${dopo}ms)`);
  const ancoraInAscolto = spawnSync('bash', ['-c', `curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${portaMorta}/api/health`], { encoding: 'utf8' });
  prova('…e la porta effimera è libera (nessuno risponde più)',
    (ancoraInAscolto.stdout || '').trim() !== '200', `porta ${portaMorta} risponde ancora`);
  if (viva) { spawnSync('kill', ['-KILL', pidMorto]); }
  if (cartella && /^\/tmp\/gate-istanza-/.test(dirMorta)) { fs.rmSync(dirMorta, { recursive: true, force: true }); }
}
try { fs.unlinkSync(segnale); } catch {}

// D.3 — lo spegnimento non cancella cartelle che non sono sue. Un `rm -rf` in
// uno script che gira a ogni commit merita una cintura di sicurezza provata.
const finta = fs.mkdtempSync(path.join(os.tmpdir(), 'NON-una-copia-'));
const rifiuto = bash(`
  GATE_ISTANZA_DIR="${finta}"
  GATE_ISTANZA_PID=""
  GATE_ISTANZA_GUARDIA_PID=""
  gate_istanza_spegni 2>&1 || true
`);
prova('spegni RIFIUTA di cancellare una cartella che non è una copia di scarto',
  fs.existsSync(finta) && /rifiuto di cancellare/.test(rifiuto.out), rifiuto.out.slice(-200));
fs.rmSync(finta, { recursive: true, force: true });

// ── E) il limitatore di /api/login muore con l'istanza ──────────────────────
// È il «secondo guadagno gratis» che il proprietario ha chiesto di verificare: il contatore
// dei tentativi vive in una Map in MEMORIA nel processo (server/index.js,
// `loginAttempts`), quindi un'istanza nuova nasce con zero tentativi e il
// cancello torna ripetibile subito, senza aspettare la finestra di 60 secondi.
console.log('\nE) il 429 di /api/login non sopravvive all\'istanza (ripetibilità del cancello)');
const limite = bash(`
  gate_istanza_accendi >/dev/null 2>&1 || { echo "A-FALLITA"; exit 1; }
  for i in 1 2 3 4 5 6; do
    C=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      -d '{"password":"__prova_sbagliata__"}' "$GATE_ISTANZA_BASE/api/login")
  done
  echo "DOPO-SEI=$C"
  gate_istanza_spegni
  # SUBITO un'istanza nuova, senza aspettare un secondo.
  gate_istanza_accendi >/dev/null 2>&1 || { echo "B-FALLITA"; exit 1; }
  echo "ISTANZA-NUOVA=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{"password":"__prova_sbagliata__"}' "$GATE_ISTANZA_BASE/api/login")"
  gate_istanza_spegni
`);
prova('sei tentativi sbagliati sulla STESSA istanza → 429 (il limitatore c\'è)',
  /DOPO-SEI=429/.test(limite.out), limite.out.slice(-400));
// [12/11/2026] Senza parola, da loopback il gettone si dà: un'istanza
// nuova risponde 200 (prima 401 «password sbagliata»). Il senso non cambia:
// non è 429, quindi il limitatore è morto con la vecchia.
prova('un\'istanza NUOVA, accesa subito dopo → 200 (il limitatore è morto con la vecchia)',
  /ISTANZA-NUOVA=200/.test(limite.out), limite.out.slice(-400));

// ── ESITO ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════');
console.log(`VERDI ${ok}   ROSSI ${rotti.length}`);
if (rotti.length) {
  console.log('\nROTTI:');
  for (const r of rotti) console.log('  · ' + r);
  console.log('\n⚠ UNA DI QUESTE ROSSE SIGNIFICA O CHE IL CANCELLO È TORNATO A');
  console.log('  PROVARE IL CODICE VECCHIO, O CHE LASCIA PROCESSI ORFANI IN GIRO.');
}
console.log('════════════════════════════════════════════');
process.exit(rotti.length ? 1 : 0);
