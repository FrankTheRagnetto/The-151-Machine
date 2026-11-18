/* The 151 Machine — Auth: login, server config */

// [12/11/2026] Impronta tolta «once and for all». Si entra con la sola
// parola d'accesso, poi l'app resta aperta come nel browser del PC: niente
// blocco all'avvio né al ritorno dallo sfondo (era public/js/biometric.js),
// niente tasto dell'impronta, niente offerta «Set Up Fingerprint», niente
// parola salvata nel Keystore. Il plugin nativo e il permesso USE_BIOMETRIC
// restano nell'APK finché non se ne fa una nuova: nessuno li chiama più.
// Prova: tests/senza-impronta.test.js.

// [12/11/2026] Niente più parola d'accesso. La Machine risponde
// solo al PC e al Tailscale del proprietario (muro in server/solo-tailnet.js); a chi
// passa il muro POST /api/login dà il gettone senza chiedere niente. Il client
// lo prende da solo all'avvio e quando un 401 lo butta: la pagina d'accesso
// resta solo come messaggio («Not on your Tailscale», «PC not reachable») con
// un tasto Retry. Prova: tests/solo-tailnet.test.js, tests/senza-impronta.test.js.

function _accessoMessaggio(testo) {
  var e = document.getElementById('login-error');
  if (e) e.textContent = testo || '';
}

var _gettoneInCorso = null;
function doLogin() {
  if (_gettoneInCorso) return _gettoneInCorso;
  _accessoMessaggio('Connecting…');
  _gettoneInCorso = (async function() {
    try {
      var res = await fetch(getServerUrl() + '/api/login', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (res.ok) {
        var data = await res.json();
        if (!data || !data.token) throw new Error('no token');
        window.authToken = data.token;
        localStorage.setItem('151-terminal-token', window.authToken);
        _accessoMessaggio('');
        var lo = document.getElementById('login-overlay');
        if (lo) lo.classList.add('hidden');
        init();
        return true;
      }
      var corpo = null;
      try { corpo = await res.json(); } catch (e) {}
      if (res.status === 403) _accessoMessaggio('Not on your Tailscale');
      else if (res.status === 429) _accessoMessaggio('Too many attempts. Wait a minute.');
      else if (res.status === 503 && corpo && corpo.offline) _accessoMessaggio('PC not reachable');
      else _accessoMessaggio('Server error (' + res.status + ')');
    } catch (e) {
      _accessoMessaggio('PC not reachable');
    } finally {
      _gettoneInCorso = null;
    }
    return false;
  })();
  return _gettoneInCorso;
}
window.doLogin = doLogin;

// Un 401 (gettone rifiutato) mostra la pagina d'accesso e chiede subito un
// gettone nuovo, al massimo una volta ogni 15 s: se il server desse gettoni
// che poi rifiuta, niente giostra infinita — resta il messaggio e il Retry.
var _ultimoGettoneAuto = 0;
function mostraAccesso() {
  var lo = document.getElementById('login-overlay');
  if (lo) lo.classList.remove('hidden');
  var ora = Date.now();
  if (ora - _ultimoGettoneAuto < 15000) return;
  _ultimoGettoneAuto = ora;
  doLogin();
}
window.mostraAccesso = mostraAccesso;

// --- Event Handlers: Retry ---
var _loginBtn = document.getElementById('login-btn');
if (_loginBtn) {
  _loginBtn.onclick = doLogin;
  _loginBtn._mainHandlerAttached = true;
}

// --- Server Config ---
var serverConfigLink = document.getElementById('server-config-link');
var serverConfigOverlay = document.getElementById('server-config-overlay');
var serverUrlInput = document.getElementById('server-url-input');
var serverTestStatus = document.getElementById('server-test-status');

// Always show server config link (product app always needs explicit server)
serverConfigLink.textContent = serverUrl ? serverUrl.replace(/^https?:\/\//, '') : 'Configure server';
serverConfigLink.onclick = function() {
  serverUrlInput.value = serverUrl || '';
  serverTestStatus.textContent = '';
  serverConfigOverlay.classList.remove('hidden');
};

// Presets
document.querySelectorAll('.server-preset').forEach(function(btn) {
  btn.onclick = function() {
    serverUrlInput.value = btn.dataset.url;
  };
});

// Test connection
document.getElementById('server-test-btn').onclick = async function() {
  var url = serverUrlInput.value.replace(/\/+$/, '');
  if (!url) { serverTestStatus.innerHTML = '<span style="color:var(--orange)">Enter a server URL</span>'; return; }
  serverTestStatus.innerHTML = '<span style="color:var(--text-dim)">Testing...</span>';
  try {
    var ac = new AbortController(); setTimeout(function() { ac.abort(); }, 5000);
    var res = await fetch(url + '/api/health', { cache: 'no-store', signal: ac.signal });
    var data = await res.json();
    if (data.ok) {
      serverTestStatus.innerHTML = '<span style="color:var(--green)">Connected — ' + (data.sessions || 0) + ' active sessions</span>';
    } else {
      serverTestStatus.innerHTML = '<span style="color:var(--orange)">Unexpected response</span>';
    }
  } catch(e) {
    serverTestStatus.innerHTML = '<span style="color:#ef4444">Failed: ' + (e.message || 'unreachable') + '</span>';
  }
};

// Save
document.getElementById('server-save-btn').onclick = function() {
  var url = serverUrlInput.value.replace(/\/+$/, '');
  serverUrl = url;
  localStorage.setItem('151-server-url', url);
  serverConfigOverlay.classList.add('hidden');
  serverConfigLink.textContent = url ? url.replace(/^https?:\/\//, '') : 'Configure server';
  // Server salvato: si riabilita il Retry e, senza gettone, lo si chiede subito
  // (niente parola da scrivere dal 12/11/2026).
  var _lb = document.getElementById('login-btn');
  if (url) {
    if (_lb) _lb.disabled = false;
    if (!window.authToken) doLogin();
  }
  // Reconnect if already logged in.
  // [2026-09-10] `&& activeSessionId`: era l'UNICA chiamata a connectWebSocket
  // senza controllo del nullo (tutte le altre — ws.js:179/1562/1646, input.js:934
  // — sono già dentro una guardia). Finché una sessione esisteva sempre non si
  // vedeva; ora che zero è uno stato legittimo, salvare l'indirizzo del server
  // stando sul vuoto mandava `join` con sessionId null, e il server ci muore
  // sopra: ws-handler.js:125 fa currentSessionId.slice(0, 8). Niente sessione,
  // niente join — il socket lo apre da sé la prossima switchSession().
  if (window.authToken && ws && activeSessionId) { connectWebSocket(activeSessionId); }
};

document.getElementById('server-config-close').onclick = function() {
  serverConfigOverlay.classList.add('hidden');
};

