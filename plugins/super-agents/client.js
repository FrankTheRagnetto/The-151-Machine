/**
 * The 151 Machine — Super agents.
 * «Vuole decidere lui quali agenti sono super … cambiarne colori e icone, da una
 * raccolta di icone.» Una pagina in fondo al pannello dei plugin (il proprietario: «nella
 * sidebar plugins in fondo, tanto è vuota»): in alto i suoi super agenti (la
 * scheda speciale del file delle squadre, se c'è, resta sempre), ognuno si
 * toglie o si sposta; sotto «Add a super agent»
 * con ogni agente che c'è (GET /agents, plugins/super-agents/server.js). Tocco
 * sulla riga = colore e icona sotto di lei. Si salva nelle impostazioni del plugin (POST /api/plugins/super-agents/
 * settings, _registry.json) e sul telefono (localStorage), e la barra a sinistra
 * si ridisegna subito (window.applySuperAgents, public/js/sessions.js).
 * Prova: tests/super-agenti.test.js.
 */
(function () {
  'use strict';
  var PLUGIN_ID = 'super-agents';
  // L'icona di partenza di un agente appena aggiunto: quella che il file delle
  // squadre gli dà (teams o super), altrimenti la bolla; poi la sceglie chi usa l'app.
  function iconaDi(k) {
    var q = window.squadre || {};
    var x = (q.super && q.super[k]) || (q.teams && q.teams[k]) || {};
    return (x.icon && window.IC && window.IC[x.icon]) ? x.icon : 'messageCircle';
  }
  function speciale() { return window.superSpeciale ? window.superSpeciale() : null; }
  var COLORI = ['#facc15', '#fb923c', '#f87171', '#f0abfc', '#c084fc', '#a78bfa', '#2979ff', '#38bdf8', '#34d399', '#83f52c', '#e5e7eb'];
  var ICONE = ['sun', 'scale', 'brain', 'eye', 'shield', 'cpu', 'gamepad', 'music', 'globe', 'bookOpen', 'graduationCap',
    'wrench', 'gear', 'search', 'terminal', 'package', 'messageCircle', 'fileText', 'broom', 'power', 'paperclip'];

  function call(path, opts) {
    opts = opts || {};
    var url = '/api/plugins/' + PLUGIN_ID + path;
    if (window.UI && typeof window.UI.authFetch === 'function') return window.UI.authFetch(url, opts);
    return fetch((window.getServerUrl ? window.getServerUrl() : '') + url, opts);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function scelte(cfg) { return window.superScelte ? window.superScelte(cfg) : (cfg || {}); }

  // Pura: le scelte → l'HTML della pagina (la prova la legge in node).
  // [12/11 the owner «so ugly and unclear», poi «no way to remove or add»] I suoi super
  // agenti in una lista: icona nel suo colore, nome, «Remove». Tocco sulla riga →
  // sotto di lei «Color», «Icon» e l'ordine. In fondo «Add a super agent».
  function ordinati(s) {
    return Object.keys(s).filter(function (k) { return s[k].on; }).sort(function (a, b) { return s[a].pos - s[b].pos; });
  }
  function view(s, notice, aperto, catalogo, aggiungi) {
    var IC = window.IC || {};
    var miei = ordinati(s);
    var h = '<div class="sa-wrap"><p class="sa-lede">Pinned at the top of your sessions. Tap one to change its color, icon or place.</p>' +
      '<p class="sa-lab sa-top">Your super agents</p><div class="sa-list">';
    miei.forEach(function (k, i) {
      var a = s[k], dir = k === speciale(), open = aperto === k;
      h += '<div class="sa-item' + (open ? ' open' : '') + '" style="--sa-c:' + esc(a.color) + '">' +
        '<button type="button" class="sa-row" data-act="open" data-agent="' + k + '" aria-expanded="' + open + '">' +
          '<span class="sa-ic">' + (IC[a.icon] || '') + '</span>' +
          '<span class="sa-txt"><b>' + esc(a.name) + '</b><small>' + (dir ? 'Always on top' : '/' + k) + '</small></span>' +
          '<span class="sa-chev" aria-hidden="true">' + (open ? '−' : '+') + '</span>' +
        '</button>' +
        (open
          ? '<div class="sa-edit"><p class="sa-lab">Color</p><div class="sa-cols">' + COLORI.map(function (c) {
              return '<button type="button" class="sa-col' + (c === a.color ? ' on' : '') + '" data-act="color" data-agent="' + k + '" data-v="' + c + '" style="background:' + c + '" aria-label="Color ' + c + '"></button>';
            }).join('') + '</div><p class="sa-lab">Icon</p><div class="sa-grid">' + ICONE.filter(function (n) { return IC[n]; }).map(function (n) {
              return '<button type="button" class="sa-icn' + (n === a.icon ? ' on' : '') + '" data-act="icon" data-agent="' + k + '" data-v="' + n + '" aria-label="Icon ' + n + '">' + IC[n] + '</button>';
            }).join('') + '</div>' +
            (dir ? '' : '<div class="sa-acts">' +
              (i > (miei[0] === speciale() ? 1 : 0) ? '<button type="button" class="sa-btn" data-act="up" data-agent="' + k + '">Move up</button>' : '') +
              (i < miei.length - 1 ? '<button type="button" class="sa-btn" data-act="down" data-agent="' + k + '">Move down</button>' : '') +
              '<button type="button" class="sa-btn sa-del" data-act="remove" data-agent="' + k + '">Remove</button></div>') +
            '</div>'
          : '') +
        '</div>';
    });
    h += '</div>';
    if (!aggiungi) {
      h += '<button type="button" class="sa-add" data-act="add-open"><span>+</span> Add a super agent</button>';
    } else {
      var altri = (catalogo || []).filter(function (x) { return !(s[x.key] && s[x.key].on); });
      h += '<p class="sa-lab sa-top">Add a super agent</p><div class="sa-list">' +
        (catalogo === null ? '<p class="sa-empty">Loading the agents…</p>'
          : catalogo === false ? '<p class="sa-empty">The list of agents comes from the PC, and the PC could not be reached.</p>'
          : !altri.length ? '<p class="sa-empty">Every agent is already a super agent.</p>'
          : altri.map(function (x) {
              return '<button type="button" class="sa-row sa-pick" data-act="add" data-agent="' + esc(x.key) + '" data-v="' + esc(x.name) + '">' +
                '<span class="sa-ic sa-ic-off">' + (IC[iconaDi(x.key)] || '') + '</span>' +
                '<span class="sa-txt"><b>' + esc(x.name) + '</b><small>' + esc(x.command) + '</small></span><span class="sa-plus">+</span></button>';
            }).join('')) +
        '</div><button type="button" class="sa-add sa-done" data-act="add-close">Done</button>';
    }
    if (notice) h += '<p class="sa-note" role="status">' + esc(notice) + '</p>';
    return h + '</div>';
  }

  function injectCSS() {
    if (document.getElementById('sa-css')) return;
    var st = document.createElement('style');
    st.id = 'sa-css';
    st.textContent =
      '.sa-wrap{padding:14px 14px 28px;overflow-y:auto;height:100%;box-sizing:border-box}' +
      '.sa-lede{color:var(--text-dim);margin:0 0 14px;font-size:14px;line-height:1.4}' +
      '.sa-list{border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden}' +
      '.sa-item{position:relative;border-top:1px solid rgba(255,255,255,.06)}.sa-item:first-child{border-top:0}' +
      '.sa-row{display:flex;align-items:center;width:100%;min-height:60px;padding:10px 14px;background:transparent;border:0;color:var(--text);text-align:left;cursor:pointer;font:inherit}' +
      '.sa-ic{width:36px;height:36px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:20px;color:var(--sa-c);background:color-mix(in srgb,var(--sa-c) 16%,transparent);margin-right:12px;flex:none}' +
      '.sa-txt{display:flex;flex-direction:column;flex:1;min-width:0}.sa-txt b{font-size:15px;font-weight:600}.sa-txt small{color:var(--text-dim);font-size:12px;margin-top:2px}' +
      '.sa-chev{color:var(--text-dim);font-size:18px;width:16px;text-align:center}' +
      '.sa-edit{padding:2px 14px 14px 62px}' +
      '.sa-lab{margin:8px 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}' +
      '.sa-cols{display:flex;flex-wrap:wrap;margin:0 -4px}' +
      '.sa-col{width:28px;height:28px;border-radius:50%;border:0;margin:4px;cursor:pointer;padding:0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}' +
      '.sa-col.on{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--text)}' +
      '.sa-grid{display:flex;flex-wrap:wrap;margin:0 -3px}' +
      '.sa-icn{width:40px;height:40px;margin:3px;border-radius:10px;border:0;background:rgba(255,255,255,.04);color:var(--text-dim);font-size:19px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}' +
      '.sa-icn.on{color:var(--sa-c);background:color-mix(in srgb,var(--sa-c) 18%,transparent)}' +
      '.sa-note{color:var(--text-dim);font-size:13px;margin-top:12px}' +
      '.sa-top{margin:0 0 8px 2px}.sa-list + .sa-lab{margin-top:20px}' +
      '.sa-acts{display:flex;flex-wrap:wrap;margin:12px -4px 0}' +
      '.sa-btn{margin:4px;min-height:38px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:transparent;color:var(--text);font:inherit;font-size:13px;cursor:pointer}' +
      '.sa-del{color:#f87171;border-color:rgba(248,113,113,.4);margin-left:auto}' +
      '.sa-add{display:flex;align-items:center;justify-content:center;width:100%;min-height:50px;margin-top:14px;border-radius:14px;border:1px dashed rgba(255,255,255,.2);background:transparent;color:var(--text);font:inherit;font-size:14px;cursor:pointer}' +
      '.sa-add span{font-size:20px;margin-right:8px;color:var(--accent)}.sa-done{border-style:solid}' +
      '.sa-pick{border-top:1px solid rgba(255,255,255,.06);padding-right:14px}.sa-pick:first-child{border-top:0}' +
      '.sa-ic-off{color:var(--text-dim);background:rgba(255,255,255,.05)}' +
      '.sa-plus{color:var(--accent);font-size:22px;width:20px;text-align:center}' +
      '.sa-empty{color:var(--text-dim);font-size:13px;padding:14px;margin:0}';
    document.head.appendChild(st);
  }

  var stato = null; // le scelte correnti
  function salva(s) {
    if (window.applySuperAgents) window.applySuperAgents(s, true);
    return call('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: s }) })
      .then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // Pura: un gesto sulle scelte → le scelte nuove (la prova la usa in node).
  function gesto(s, act, k, v) {
    s = JSON.parse(JSON.stringify(s));
    var sk = speciale();
    var miei = ordinati(s).filter(function (x) { return x !== sk; });
    var usati = miei.map(function (x) { return s[x].color; });
    if (act === 'add') {
      var prima = s[k] || {};
      s[k] = { on: true, name: v || prima.name || k, pos: miei.length ? s[miei[miei.length - 1]].pos + 1 : 1,
        color: prima.color || COLORI.filter(function (c) { return usati.indexOf(c) < 0; })[0] || COLORI[5],
        icon: prima.icon || iconaDi(k) };
    }
    if (act === 'remove' && k !== sk && s[k]) s[k].on = false;
    if ((act === 'up' || act === 'down') && s[k]) {
      var i = miei.indexOf(k), j = act === 'up' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < miei.length) { var t = s[miei[j]].pos; s[miei[j]].pos = s[k].pos; s[k].pos = t; if (s[k].pos === s[miei[j]].pos) s[k].pos += act === 'up' ? -0.5 : 0.5; }
    }
    if (act === 'color' && s[k]) s[k].color = v;
    if (act === 'icon' && s[k]) s[k].icon = v;
    return scelte(s);
  }

  function mount(host) {
    injectCSS();
    stato = scelte(window.superAgents);
    var notice = '', aperto = null, aggiungi = false, catalogo = null;
    function render() {
      var top = (host.querySelector('.sa-wrap') || {}).scrollTop || 0;
      host.innerHTML = view(stato, notice, aperto, catalogo, aggiungi);
      var w = host.querySelector('.sa-wrap'); if (w) w.scrollTop = top;
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      var k = b.getAttribute('data-agent'), act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (act === 'add-open') {
        aggiungi = true; render();
        if (!catalogo) call('/agents').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { catalogo = j && j.agents ? j.agents : false; render(); })
          .catch(function () { catalogo = false; render(); });
        return;
      }
      if (act === 'add-close') { aggiungi = false; render(); return; }
      if (act === 'open') { aperto = aperto === k ? null : k; render(); return; }
      stato = gesto(stato, act, k, v);
      if (act === 'remove') aperto = null;
      if (act === 'add') { aggiungi = false; aperto = k; }
      render();
      salva(stato).then(function (ok) { notice = ok ? '' : 'Saved on this screen only: the PC could not be reached.'; if (!ok) render(); });
    });
    render();
  }

  // All'avvio: le scelte salvate sul PC vincono su quelle del telefono.
  function carica() {
    call('/settings').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var a = j && (j.values || j.settings || {}).agents;
      if (a && window.applySuperAgents) window.applySuperAgents(a, true);
    }).catch(function () {});
  }

  var api = { renderInPanel: function (c) { mount(c); }, view: view, _test: { COLORI: COLORI, ICONE: ICONE, gesto: gesto } };
  if (window.The151Machine && window.The151Machine.register) window.The151Machine.register(PLUGIN_ID, api);
  carica();
})();
