// Niente animazioni infinite per dire «sta lavorando».
// il proprietario: la Machine prima in Batteria sul Samsung, 50-117% al giorno.
// Misurato su un telefono vero col cavo: a app aperta e ferma la WebView disegnava 120
// fotogrammi/s (~147% di un core) per le pulsazioni «live» e le rotelle;
// con le stesse cose ferme 1 fotogramma/s (~12%). Scelta del proprietario: colore fisso.
//
//   A. Ogni `animation: … infinite` nel CSS dell'app (public/css/main.css e
//      il CSS dentro i client.js dei plugin) è in ELENCO qui sotto, con il
//      motivo: sono stati brevi (registrazione, caricamento, riavvio, login).
//      Un'animazione infinita nuova fa fallire la prova finché qualcuno non
//      la dichiara — il modo più facile di riportare il telefono a 120/s.
//   B. Gli stati «sta lavorando» (card viva, etichette, pallini, cursore,
//      puntini, rotella attività) non hanno animazioni infinite.
//   C, D. (tolte il 12/11/2026) Provavano che la rotella dello sblocco con
//      l'impronta si fermasse da nascosta e in attesa: lo sblocco con
//      l'impronta non esiste più, e con lui la
//      rotella. Che non torni lo prova tests/senza-impronta.test.js.
//   E. Pagina di accesso e schermata di riavvio: il
//      «151» respira due volte e si ferma;
//      la sfera del riavvio anima solo transform (niente ridisegno).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let n = 0, rossi = 0;
const attese = [];
function t(nome, fn) {
  n++;
  const rosso = (e) => { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') attese.push(r.then(() => console.log('  ✓ ' + nome), rosso));
    else console.log('  ✓ ' + nome);
  } catch (e) { rosso(e); }
}

// Stati brevi: girano solo mentre succede qualcosa che il proprietario sta guardando.
const AMMESSE = {
  micPulse: 'microfono che registra / si accende',
  micSpin: 'microfono che si accende',
  micDot: 'microfono che registra',
  uploadPulse: 'file in caricamento',
  orbPulse: 'schermata di riavvio (solo transform, prova E)',
  'bk-pulse': 'backup in corso', 'bk-slide': 'backup in corso',
  'upd-pulse': 'aggiornamento in corso', 'upd-slide': 'aggiornamento in corso',
};

function fontiCss() {
  const out = [['public/css/main.css', fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8')]];
  for (const d of fs.readdirSync(path.join(ROOT, 'plugins'))) {
    const f = path.join(ROOT, 'plugins', d, 'client.js');
    if (fs.existsSync(f)) out.push(['plugins/' + d + '/client.js', fs.readFileSync(f, 'utf8')]);
  }
  return out;
}
const senzaCommenti = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function infinite() {
  const trovate = [];
  for (const [file, testo] of fontiCss()) {
    const re = /animation\s*:\s*([^;}'"]*)/g;
    let m;
    while ((m = re.exec(senzaCommenti(testo)))) {
      if (!/\binfinite\b/.test(m[1])) continue;
      const nome = m[1].trim().split(/\s+/)[0];
      trovate.push({ file, nome });
    }
    const re2 = /animation-iteration-count\s*:\s*infinite/g;
    while ((m = re2.exec(senzaCommenti(testo)))) trovate.push({ file, nome: '(iteration-count)' });
  }
  return trovate;
}

console.log('animazioni-ferme — niente 120 fotogrammi/s a schermo fermo');

t('A. ogni animazione infinita è dichiarata (stati brevi)', () => {
  const fuori = infinite().filter((a) => !AMMESSE[a.nome]);
  assert.deepStrictEqual(fuori, [], 'animazioni infinite non dichiarate: ' +
    fuori.map((a) => a.nome + ' in ' + a.file).join(', '));
});

t('B. «sta lavorando» è fermo: card, etichette, pallini, cursore, puntini, rotella', () => {
  const css = senzaCommenti(fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8'));
  const selettori = ['.session-item.in-progress', '.session-item.is-live', '.session-status-label.is-busy',
    '.session-status-label.is-waiting', '.session-dot.idle', '.session-dot.busy', '.session-dot.wrapping',
    '.streaming-text::after', '.thinking-dots span', '.activity-spinner'];
  const regole = css.split('}').map((r) => r.split('{'));
  for (const sel of selettori) {
    const colpevoli = regole.filter(([s, corpo]) => s && corpo && s.includes(sel) && /\banimation\s*:/.test(corpo));
    assert.strictEqual(colpevoli.length, 0, sel + ' ha ancora un\'animazione: ' + (colpevoli[0] || [])[0]);
  }
});

t('E. accesso e riavvio: niente che ridisegna per sempre', () => {
  const css = senzaCommenti(fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8'));
  const regola = (sel) => { const m = css.match(new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };
  assert.ok(/animation\s*:\s*emblemPulse\s+4s\s+ease-in-out\s+2\s*;/.test(regola('.login-emblem')), 'il «151» respira 2 volte');
  const orb = (css.match(/@keyframes orbPulse\s*\{([\s\S]*?\})\s*\}/) || [])[1] || '';
  assert.ok(orb && !/box-shadow|filter/.test(orb), 'orbPulse anima solo transform: ' + orb);
  assert.ok(!/fogDrift|twinkle3/.test(css), 'fogDrift/twinkle3 senza @keyframes: tolti, non tornano');
});

Promise.all(attese).then(() => {
  console.log(`\n${n - rossi}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
});
