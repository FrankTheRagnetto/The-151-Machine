/**
 * Chime & Notifications Plugin — Client
 *
 * Plays a two-note done chime via Web Audio API and sends push
 * notifications (Capacitor LocalNotifications or web Notification API)
 * when Claude finishes responding while the app is in the background.
 *
 * Background strategy: when streaming starts, schedule an OS-level
 * local notification for 3 minutes out. If the response completes
 * while the app is still open, cancel it. If Android kills the app,
 * the scheduled notification still fires.
 */

(function() {
  var _audioCtx = null;
  var _localNotifPlugin = null;
  var _localNotifReady = false;
  var _localNotifId = 100; // start high to avoid conflicts with pending IDs
  var _pendingNotifId = null; // ID of the "response ready" scheduled notification (= idPerSessione)

  // --- Settings helpers ---

  function getSetting(key, fallback) {
    try {
      var raw = localStorage.getItem('151-plugin-chime-notifications-' + key);
      return raw !== null ? raw : fallback;
    } catch(e) { return fallback; }
  }

  function isChimeEnabled()   { return getSetting('chimeEnabled', 'on') === 'on'; }
  function isNotifEnabled()   { return getSetting('notificationsEnabled', 'on') === 'on'; }
  function isHapticEnabled()  { return getSetting('hapticEnabled', 'on') === 'on'; }

  // --- Chime ---

  function playDoneChime() {
    if (!isChimeEnabled()) return;
    if (isHapticEnabled() && typeof window.haptic === 'function') {
      window.haptic([10, 50, 10]); // double pulse
    }
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = _audioCtx;
      var now = ctx.currentTime;
      var notes = [523.25, 659.25]; // C5, E5
      for (var i = 0; i < notes.length; i++) {
        (function(idx) {
          var osc  = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = notes[idx];
          gain.gain.setValueAtTime(0.15, now + idx * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.3);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + idx * 0.12);
          osc.stop(now + idx * 0.12 + 0.35);
        })(i);
      }
    } catch(e) {}
  }

  // --- Notifications ---

  function getLocalNotifications() {
    if (_localNotifPlugin) return _localNotifPlugin;
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
        _localNotifPlugin = window.Capacitor.Plugins.LocalNotifications;
      }
    } catch(e) { console.log('[NOTIF] Plugin not available:', e); }
    return _localNotifPlugin;
  }

  function requestNotificationPermission() {
    if (!isNotifEnabled()) return;
    var plugin = getLocalNotifications();
    if (plugin) {
      plugin.requestPermissions().then(function(result) {
        _localNotifReady = result.display === 'granted';
      }).catch(function(e) {});
    } else if ('Notification' in window && Notification.permission === 'default') {
      // [12/10/2026] Il browser accetta la richiesta solo dentro un gesto
      // dell'utente (Firefox lo grida in console a ogni avvio): si chiede al
      // primo tocco o tasto, una volta sola.
      if (_webPermAsked) return;
      _webPermAsked = true;
      var ask = function() {
        document.removeEventListener('pointerdown', ask, true);
        document.removeEventListener('keydown', ask, true);
        try {
          if (Notification.permission === 'default') {
            var p = Notification.requestPermission();
            if (p && typeof p.catch === 'function') p.catch(function() {});
          }
        } catch (e) {}
      };
      document.addEventListener('pointerdown', ask, true);
      document.addEventListener('keydown', ask, true);
    }
  }
  var _webPermAsked = false;

  // --- Una notifica per sessione ---
  // «le notifiche mentono»: tre notifiche ammucchiate per una sola sessione da
  // rispondere. Regola: al massimo UNA notifica per sessione (stesso numero =
  // Android sostituisce la vecchia) e sparisce quando la sessione è aperta o
  // ha la risposta del proprietario, da qualunque apparecchio. Il registro qui sotto
  // ricorda quale sessione ha una notifica e da quando, così al ritorno
  // dell'app (anche dopo che Samsung l'ha uccisa) riconciliaNotifiche()
  // toglie quelle che non aspettano più il proprietario.
  var ICONA = 'ic_stat_machine';     // res/drawable/ic_stat_machine.xml
  var COLORE = '#a78bfa';             // --accent di public/css/main.css
  var REGISTRO = '151-notifiche-sessioni';
  var _pendingSid = null;             // sessione della notifica «di riserva» a 3 minuti

  function idPerSessione(sid) {
    // Numero fisso per sessione, lontano da 1511/1513 dei servizi nativi
    // (stesso NotificationManager: un numero uguale sostituirebbe la loro).
    var h = 0;
    for (var i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) | 0;
    return 200000 + (Math.abs(h) % 700000);
  }

  function leggiRegistro() {
    try { return JSON.parse(localStorage.getItem(REGISTRO) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function scriviRegistro(r) {
    try { localStorage.setItem(REGISTRO, JSON.stringify(r)); } catch (e) {}
  }

  function togliNotifica(id) {
    var plugin = getLocalNotifications();
    if (plugin) plugin.cancel({ notifications: [{ id: id }] }).catch(function() {});
  }

  // La sessione non aspetta più il proprietario: via la sua notifica (consegnata o in coda).
  function clearSessionNotification(sid) {
    if (!sid) return;
    var r = leggiRegistro();
    var c = r[sid];
    if (c) { delete r[sid]; scriviRegistro(r); }
    if (_pendingSid === sid) { _pendingSid = null; _pendingNotifId = null; }
    // Anche senza voce nel registro: una notifica di una versione precedente
    // dell'app può esserci ancora con lo stesso numero.
    togliNotifica(idPerSessione(sid));
  }

  // Dopo un elenco fresco dal server: via le notifiche delle sessioni che non
  // aspettano più il proprietario (risposta in corso, letta altrove dopo la notifica,
  // cancellata, o aperta davanti a lui adesso).
  function riconciliaNotifiche(lista) {
    if (!Array.isArray(lista)) return;
    var r = leggiRegistro();
    var visibile = document.visibilityState === 'visible';
    var adesso = Date.now();
    Object.keys(r).forEach(function(sid) {
      var c = r[sid] || {};
      var s = null;
      for (var i = 0; i < lista.length; i++) { if (lista[i] && lista[i].id === sid) { s = lista[i]; break; } }
      var via = false;
      if (!s) via = lista.length > 0;
      else if (visibile && sid === window.activeSessionId) via = true;
      // Al lavoro = non aspetta il proprietario; la riserva solo finché non è ancora suonata.
      else if (s.status === 'busy' && (!c.riserva || c.at <= adesso)) via = true;
      else if (s.readAt && c.at && s.readAt >= c.at) via = true;
      if (!via && c.at && adesso - c.at > 7 * 86400000) via = true;
      if (via) clearSessionNotification(sid);
    });
  }

  function notifyDone(text, opts) {
    if (!isNotifEnabled()) return;
    var sid = (opts && opts.sessionId) || null;
    // Skip if app is visible UNLESS force=true (background session completions)
    var mostra = !(document.visibilityState === 'visible' && !(opts && opts.force));
    // Cancel any pending "response ready" notification — response arrived while app was open
    // (stessa sessione e notifica da mostrare: la vera la sostituisce col suo stesso numero).
    if (mostra && sid && sid === _pendingSid) { _pendingSid = null; _pendingNotifId = null; }
    else cancelPendingNotification();
    if (!mostra) return;
    var title = (opts && opts.title) || 'The 151 Machine';
    var preview = (text || 'Response complete').replace(/<[^>]*>/g, '').slice(0, 120);
    var plugin = getLocalNotifications();
    if (plugin) {
      var id = sid ? idPerSessione(sid) : _localNotifId++;
      if (sid) {
        var r = leggiRegistro();
        r[sid] = { at: Date.now() };
        scriviRegistro(r);
      }
      plugin.schedule({
        notifications: [{
          title: title,
          body: preview,
          id: id,
          schedule: { at: new Date(Date.now() + 500) },
          sound: null,
          smallIcon: ICONA,
          iconColor: COLORE,
          autoCancel: true,
          extra: sid ? { sessionId: sid } : null,
        }]
      }).catch(function(e) {});
      return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    var n = new Notification(title, {
      body: preview,
      icon: '/icon.svg',
      tag: sid ? 'sessione-' + sid : 'claude-done'
    });
    if (sid) n.onclick = function() { try { window.focus(); } catch (e) {} apriSessione(sid); n.close(); };
  }

  // --- Background notification scheduling ---
  // When streaming starts, schedule a notification for 3 min out.
  // If response completes while app is open, cancel it.
  // If Android kills the app, the OS fires it anyway.
  // Stesso numero della sessione: mai una seconda notifica per lei.

  function schedulePendingNotification() {
    if (!isNotifEnabled()) return;
    var plugin = getLocalNotifications();
    if (!plugin) return;
    cancelPendingNotification(); // clear any existing one first
    var sid = window.activeSessionId;
    if (!sid) return;
    _pendingSid = sid;
    _pendingNotifId = idPerSessione(sid);
    var at = Date.now() + 180000; // 3 minutes
    var r = leggiRegistro();
    r[sid] = { at: at, riserva: true };
    scriviRegistro(r);
    var session = window.sessions ? window.sessions.find(function(s) { return s.id === sid; }) : null;
    var sessionTitle = session && session.title ? session.title : 'Your session';
    plugin.schedule({
      notifications: [{
        title: 'The 151 Machine',
        body: sessionTitle + ' — response ready',
        id: _pendingNotifId,
        schedule: { at: new Date(at) },
        sound: 'default',
        smallIcon: ICONA,
        iconColor: COLORE,
        autoCancel: true,
        extra: { sessionId: sid },
      }]
    }).catch(function(e) { console.log('[NOTIF] Schedule failed:', e); });
  }

  function cancelPendingNotification() {
    if (_pendingNotifId === null) return;
    var sid = _pendingSid;
    // Solo la riserva: se nel frattempo la sessione ha una notifica vera, resta.
    var r = leggiRegistro();
    if (sid && r[sid] && r[sid].riserva) {
      delete r[sid];
      scriviRegistro(r);
      togliNotifica(_pendingNotifId);
    } else if (!sid) {
      togliNotifica(_pendingNotifId);
    }
    _pendingNotifId = null;
    _pendingSid = null;
  }

  // --- Tocco sulla notifica → QUELLA sessione ---
  // «it doesn't bring me to the session that responded. It just opens the app».
  // Ogni notifica di sessione porta extra.sessionId; il tocco arriva come
  // evento del plugin, anche ad app chiusa (Capacitor lo tiene da parte finché
  // qualcuno ascolta). Si scrive anche la sessione da riaprire all'avvio, così
  // init.js apre quella anche se arriva prima di noi.
  var _apriTentativi = 0;
  function apriSessione(sid) {
    if (!sid) return;
    try { localStorage.setItem('151-terminal-session', sid); } catch (e) {}
    clearSessionNotification(sid);
    _apriTentativi = 0;
    provaAdAprire(sid);
  }
  function provaAdAprire(sid) {
    var lista = window.sessions || [];
    var c = null;
    for (var i = 0; i < lista.length; i++) { if (lista[i] && lista[i].id === sid) { c = lista[i]; break; } }
    if (c && typeof window.switchSession === 'function') {
      if (window.activeSessionId !== sid) window.switchSession(sid);
      return;
    }
    // Elenco non ancora arrivato (avvio a freddo): riprova per 20 s, poi lascia
    // fare a init.js con la sessione scritta sopra.
    if (++_apriTentativi <= 40) setTimeout(function() { provaAdAprire(sid); }, 500);
  }
  function ascoltaTocchi() {
    var plugin = getLocalNotifications();
    if (!plugin || typeof plugin.addListener !== 'function' || window.__notificheTocco) return;
    window.__notificheTocco = true;
    try {
      plugin.addListener('localNotificationActionPerformed', function(ev) {
        var n = ev && ev.notification;
        var sid = n && n.extra && n.extra.sessionId;
        if (sid) apriSessione(sid);
      });
    } catch (e) { window.__notificheTocco = false; }
  }

  // --- Hook into streaming lifecycle ---
  // Override setStreamingState to schedule/cancel background notifications

  var _originalSetStreaming = window.setStreamingState;
  window.setStreamingState = function(isStreaming) {
    if (isStreaming) {
      schedulePendingNotification();
    } else {
      cancelPendingNotification();
    }
    if (_originalSetStreaming) _originalSetStreaming(isStreaming);
  };

  // --- Auto-init: request permission on load ---
  requestNotificationPermission();
  ascoltaTocchi();

  // --- Expose globals (called from existing streaming logic) ---
  window.playDoneChime = playDoneChime;
  window.notifyDone = notifyDone;
  window.requestNotificationPermission = requestNotificationPermission;
  window.schedulePendingNotification = schedulePendingNotification;
  window.cancelPendingNotification = cancelPendingNotification;
  window.clearSessionNotification = clearSessionNotification;
  window.riconciliaNotifiche = riconciliaNotifiche;

  // --- Register with plugin system ---
  if (window.The151Machine && window.The151Machine.register) {
    window.The151Machine.register('chime-notifications', {
      playDoneChime: playDoneChime,
      notifyDone: notifyDone,
      requestNotificationPermission: requestNotificationPermission,
      schedulePendingNotification: schedulePendingNotification,
      cancelPendingNotification: cancelPendingNotification,
      clearSessionNotification: clearSessionNotification,
      riconciliaNotifiche: riconciliaNotifiche,
    });
  }
})();
