// La sonda del telefono non manda più in grigio per un colpo solo (27/10/2026).
// il proprietario: «la Machine va in grigio a sprazzi e torna normale da sola».
// Causa: OfflineBridge.java segnava «PC giù» alla PRIMA sonda mancata (2,5 s)
// e la lanciava a ogni onCapabilitiesChanged (a raffica col segnale Wi-Fi).
// Misurato dal PC verso il telefono: 3% di pacchetti persi, picchi 0,4–0,8 s.
//
//   A. GiudiceRete.java (Java puro) COMPILATO e FATTO GIRARE qui sul PC:
//      un colpo mancato da «su» resta su; due di fila → giù; una buona azzera;
//      all'avvio una mancata basta; giu() è subito.
//   B. OfflineBridge.java usa il giudice, riprova dopo una mancata, e
//      onCapabilitiesChanged sonda solo per risalire.
//   [07/11/2026] Più paziente: da «su» il grigio vuole 2 mancate E
//   12 s dalla prima della fila (telefono su Starlink, buchi di pochi secondi).
// Sul telefono vero: checklist al proprietario.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const JAVA = path.join(ROOT, 'app/android/app/src/main/java/com/the151universe/machine/');
const CASA = os.userInfo().homedir; // da /etc/passwd: il cancello chiude $HOME

let n = 0, rossi = 0;
function t(nome, fn) {
  n++;
  try { fn(); console.log('  ✓ ' + nome); }
  catch (e) { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); }
}

function javac() {
  const cand = [path.join(CASA, 'jdk21/bin/javac'), path.join(CASA, 'jdks')];
  if (fs.existsSync(cand[0])) return cand[0];
  for (const d of fs.existsSync(cand[1]) ? fs.readdirSync(cand[1]) : []) {
    const j = path.join(cand[1], d, 'bin/javac');
    if (fs.existsSync(j)) return j;
  }
  throw new Error('javac non trovato (~/jdk21 o ~/jdks): la prova A non può girare');
}

t('A. il giudice, compilato e fatto girare', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-due-colpi-'));
  try {
    const pkg = path.join(dir, 'com/the151universe/machine');
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(path.join(JAVA, 'GiudiceRete.java'), path.join(pkg, 'GiudiceRete.java'));
    fs.writeFileSync(path.join(pkg, 'Prova.java'), `package com.the151universe.machine;
public class Prova {
  static void p(String s) { System.out.println(s); }
  public static void main(String[] a) {
    GiudiceRete g = new GiudiceRete();
    p("avvio-mancata " + g.segna(false, 0));
    g = new GiudiceRete();
    p("avvio-buona " + g.segna(true, 0));
    p("una-mancata " + g.segna(false, 1000));
    p("buona-azzera " + g.segna(true, 2000));
    p("una-mancata-bis " + g.segna(false, 3000));
    p("seconda-a-5s " + g.segna(false, 8000));
    p("terza-a-11s " + g.segna(false, 14000));
    p("a-12s-giu " + g.segna(false, 15000));
    p("risale " + g.segna(true, 16000));
    p("dopo-ora-ferma " + g.segna(false, 3600000));
    p("subito-dopo " + g.segna(false, 3601100));
    p("certezza " + g.giu());
    p("dopo-certezza-buona " + g.segna(true, 3602000));
    p("PAZIENZA_MS " + GiudiceRete.PAZIENZA_MS);
  }
}
`);
    const jc = javac();
    execFileSync(jc, ['-d', dir, path.join(pkg, 'GiudiceRete.java'), path.join(pkg, 'Prova.java')], { stdio: 'pipe' });
    const javaBin = path.join(path.dirname(jc), 'java');
    const out = execFileSync(javaBin, ['-cp', dir, 'com.the151universe.machine.Prova'], { encoding: 'utf8' });
    assert.strictEqual(out.trim(), [
      'avvio-mancata false',       // PC spento all'avvio: subito la copia
      'avvio-buona true',
      'una-mancata true',          // IL CASO DI il proprietario: un colpo solo non è grigio
      'buona-azzera true',
      'una-mancata-bis true',      // il conto è ripartito da zero
      'seconda-a-5s true',         // IL CASO DI buco Starlink di 5 s, niente grigio
      'terza-a-11s true',
      'a-12s-giu false',           // 12 s dalla PRIMA mancata: giù davvero
      'risale true',
      'dopo-ora-ferma true',       // l'orologio parte dalla prima mancata, non dall'ultima buona
      'subito-dopo true',
      'certezza false',
      'dopo-certezza-buona true',
      'PAZIENZA_MS 12000',
    ].join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('B. OfflineBridge segue il giudice, riprova subito, e il segnale Wi-Fi non lancia sonde', () => {
  const src = fs.readFileSync(path.join(JAVA, 'OfflineBridge.java'), 'utf8');
  assert.ok(/new GiudiceRete\(\)/.test(src) && /giudice\.segna\(ok\)/.test(src), 'segna passa dal giudice');
  assert.ok(!/piSu = ok;/.test(src), 'nessuno scrive più piSu dalla sonda nuda');
  assert.ok(/!ok && Boolean\.TRUE\.equals\(ora\)[\s\S]{0,160}postDelayed\(this::sondaInSfondo, RIPROVA_MS\)/.test(src), 'conferma dopo una mancata');
  assert.ok(/RIPROVA_MS = (\d+)/.test(src) && Number(src.match(/RIPROVA_MS = (\d+)/)[1]) > 1000, 'sopra il limite di 1 s di sondaInSfondo');
  assert.ok(/onCapabilitiesChanged\([^)]*\)\s*\{\s*if \(Boolean\.FALSE\.equals\(piSu\)\) sondaInSfondo\(\);/.test(src), 'capacità: solo per risalire');
  assert.ok(/onReceivedError[\s\S]{0,400}segnaGiu\(\)/.test(src), 'pagina mancata = certezza');
  const pg = src.slice(src.indexOf('private boolean piGiu()'), src.indexOf('private boolean piGiu()') + 300);
  assert.ok(/return Boolean\.FALSE\.equals\(piSu\);/.test(pg), 'la pagina principale segue il giudice');
});

console.log(rossi ? `sonda-due-colpi: ${rossi}/${n} ROSSI` : `sonda-due-colpi: ${n}/${n} verdi`);
process.exit(rossi ? 1 : 0);
