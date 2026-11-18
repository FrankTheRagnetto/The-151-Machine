#!/usr/bin/env node
'use strict';
// [10/11/2026 ] Su un telefono vero la Machine compariva fra le «app attive» in
// sottofondo. L'unico servizio in primo piano è MicService (microfono), acceso
// da dictation.js al tap e spento a fine presa. Se la pagina si ricarica a metà
// presa (ritorno dalla copia offline, hash nuovo dopo una consegna, errore),
// lo stato JS muore e nessuno chiama più AndroidMic.stop: servizio orfano.
// Cura: all'avvio dictation.js chiede al registratore nativo (che vive col
// Bridge, non con la pagina) se registra ancora — sì: la presa si adotta; no:
// MicService si spegne. Più una guardia nativa in MicService.java.
// Prova pura: il dictation.js vero in una sandbox vm, ponti Android finti.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const blocco = (n, fn) => Promise.resolve().then(fn).catch((e) => { fail++; console.log('  FAIL ' + n + ' — lancia: ' + e.message); });
const pausa = () => new Promise((r) => setImmediate(r));

const DICT = rd('public/js/dictation.js');

function el() {
  const cls = new Set();
  return { style: {}, value: '', title: '', selectionStart: 0, onclick: null,
    classList: { add: (...a) => a.forEach((x) => cls.add(x)), remove: (...a) => a.forEach((x) => cls.delete(x)),
      toggle() {}, contains: (x) => cls.has(x) } };
}

// Carica dictation.js come lo carica una pagina appena aperta.
// statoNativo: 'NONE' | 'RECORDING' | 'PAUSED' | null (niente plugin) | 'lancia'
function apri(statoNativo, { conMic = true } = {}) {
  const chiamate = { start: 0, stop: 0, stopRecording: 0, toast: [] };
  const els = { 'mic-btn': el(), 'message-input': el(), 'send-btn-new': el(), 'input-row': el() };
  const timers = [];
  const win = {
    showToast: (m) => chiamate.toast.push(m),
    Battito: { ogni() {} },
  };
  if (conMic) win.AndroidMic = { start: () => chiamate.start++, stop: () => chiamate.stop++ };
  if (statoNativo !== null) {
    win.Capacitor = { isNativePlatform: () => true, Plugins: { VoiceRecorder: {
      getCurrentStatus: () => statoNativo === 'lancia' ? Promise.reject(new Error('x')) : Promise.resolve({ status: statoNativo }),
      stopRecording: () => { chiamate.stopRecording++; return Promise.resolve({ value: null }); },
      startRecording: () => Promise.resolve({ value: true }),
      requestAudioRecordingPermission: () => Promise.resolve({ value: true }),
    } } };
  }
  const ctx = {
    window: win, document: { getElementById: (id) => els[id] || null, body: { appendChild() {}, removeChild() {} }, createElement: () => el(), addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (f, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    Promise, JSON, Date, Math, Uint8Array, ArrayBuffer, atob: () => '',
  };
  win.window = win;
  // Le funzioni globali del browser stanno su window: nella sandbox, sul contesto.
  Object.assign(ctx, { showToast: win.showToast });
  vm.createContext(ctx);
  vm.runInContext(DICT, ctx);
  return { chiamate, win, mic: els['mic-btn'] };
}

(async () => {
  // ---- A: pagina nuova, niente registra → il servizio orfano si spegne ----
  await blocco('A', async () => {
    const p = apri('NONE');
    await pausa();
    ok(p.chiamate.stop === 1, 'A. registratore nativo fermo → AndroidMic.stop() chiamato all\'avvio (MicService orfano spento)');
    ok(p.chiamate.start === 0, 'A. e mai AndroidMic.start()');
    ok(p.win.Dictation.state() === 'idle', 'A. il tasto resta a riposo');
  });

  // ---- B: pagina nuova a metà presa → la presa si adotta, niente si spegne ----
  await blocco('B', async () => {
    const p = apri('RECORDING');
    await pausa();
    ok(p.chiamate.stop === 0, 'B. registratore nativo ANCORA vivo → MicService NON si spegne (la dettatura fuori dall\'app continua)');
    ok(p.chiamate.start === 0, 'B. e non si riaccende da sottofondo (startForeground fallirebbe e spegnerebbe la presa)');
    ok(p.win.Dictation.state() === 'recording' && p.win.Dictation.mode() === 'native', 'B. la presa è adottata: stato recording, modo native');
    ok(p.mic.classList.contains('recording'), 'B. il tasto è rosso');
    ok(p.chiamate.toast.some((t) => /still running/i.test(t)), 'B. lo schermo lo dice');
    p.win.Dictation.stop();
    await pausa(); await pausa();
    ok(p.chiamate.stopRecording === 1, 'B. il tocco ferma il registratore nativo (l\'audio va a trascrivere)');
    ok(p.chiamate.stop === 1, 'B. e spegne MicService');
  });

  await blocco('B2', async () => {
    const p = apri('PAUSED');
    await pausa();
    ok(p.chiamate.stop === 0 && p.win.Dictation.state() === 'recording', 'B2. presa in pausa: adottata anche lei, non spenta');
  });

  // ---- C: plugin assente o in errore → si spegne (niente da adottare) ----
  await blocco('C', async () => {
    const senza = apri(null);
    await pausa();
    ok(senza.chiamate.stop === 1, 'C. niente plugin VoiceRecorder → AndroidMic.stop()');
    const rotto = apri('lancia');
    await pausa();
    ok(rotto.chiamate.stop === 1, 'C. stato del registratore in errore → AndroidMic.stop()');
  });

  // ---- D: fuori dall'app Android non succede niente ----
  await blocco('D', async () => {
    const p = apri('NONE', { conMic: false });
    await pausa();
    ok(p.chiamate.stop === 0 && p.chiamate.start === 0, 'D. browser del PC (niente AndroidMic): nessuna chiamata');
  });

  // ---- E: la guardia nativa di MicService ----
  await blocco('E', () => {
    const j = rd('app/android/app/src/main/java/com/the151universe/machine/MicService.java');
    ok(/getActiveRecordingConfigurations\(\)/.test(j), 'E. MicService guarda le registrazioni attive del telefono');
    ok(/GUARDIA_OGNI_MS\s*=\s*60_000L/.test(j) && /GUARDIA_GIRI_MUTI\s*=\s*2\b/.test(j), 'E. ogni 60 s, 2 giri muti di fila → si spegne');
    const avvio = j.slice(j.indexOf('ACTION_START.equals(action)'), j.indexOf('spegni();\n        return START_NOT_STICKY'));
    ok(/postDelayed\(controllo, GUARDIA_OGNI_MS\)/.test(avvio), 'E. la guardia parte a ogni START');
    const sp = j.slice(j.indexOf('private void spegni()'), j.indexOf('private void createChannel'));
    ok(/removeCallbacks\(controllo\)/.test(sp), 'E. spegni() ferma la guardia');
    ok(/catch \(Exception e\) \{\s*return true;/.test(j), 'E. nel dubbio la guardia NON spegne (una presa viva non muore mai per errore)');
  });

  console.log(`\n${pass} ok, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
