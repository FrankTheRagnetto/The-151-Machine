/**
 * Code Block Enhancements Plugin — Client
 *
 * Adds language badges, copy buttons, and auto-collapse to <pre><code> blocks.
 * Exposes window.addCodeCopyButtons for the message renderer to call directly.
 */

(function() {
  var LANG_LABELS = {
    js: 'JS', javascript: 'JS', ts: 'TS', typescript: 'TS',
    py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby',
    go: 'Go', rust: 'Rust', java: 'Java', cpp: 'C++', c: 'C',
    cs: 'C#', csharp: 'C#', php: 'PHP', swift: 'Swift',
    kotlin: 'Kotlin', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON',
    yaml: 'YAML', yml: 'YAML', xml: 'XML', sql: 'SQL',
    md: 'Markdown', markdown: 'Markdown', txt: 'Text',
    gdscript: 'GDScript', gd: 'GDScript', lua: 'Lua',
    toml: 'TOML', ini: 'INI', dockerfile: 'Docker',
  };

  function getCollapseThreshold() {
    // Prefer The151Machine settings API if available
    if (window.The151Machine && window.The151Machine.getSetting) {
      var val = window.The151Machine.getSetting('code-blocks', 'collapseThreshold');
      if (val !== undefined && val !== null) return Number(val);
    }
    // Fall back to localStorage
    var stored = localStorage.getItem('151-plugin-code-blocks-collapseThreshold');
    if (stored !== null) return Number(stored);
    // Default
    return 8;
  }

  function detectLang(pre) {
    var code = pre.querySelector('code');
    if (!code) return null;
    var cls = code.className || '';
    var match = cls.match(/language-(\w+)/);
    if (match) return LANG_LABELS[match[1].toLowerCase()] || match[1].toUpperCase();
    return null;
  }

  // Robust clipboard copy. navigator.clipboard is undefined on the PHONE because
  // the app loads over plain http (Tailscale) = a NON-secure context, so the
  // async Clipboard API silently failed there while working on the PC (localhost
  // is treated as secure). Fall back to a hidden textarea + execCommand('copy'),
  // which still works inside the Android WebView in a non-secure context.
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text)
        .then(function() { return true; })
        .catch(function() { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function addCodeCopyButtons(container) {
    var threshold = getCollapseThreshold();
    var pres = container.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      if (pre.querySelector('.code-copy-btn')) continue;

      var lang = detectLang(pre);
      if (lang) {
        var badge = document.createElement('span');
        badge.className = 'code-lang-badge';
        badge.textContent = lang;
        pre.appendChild(badge);
      }

      var btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = 'Copy';
      (function(pre, btn) {
        btn.onclick = function() {
          var code = pre.querySelector('code');
          var text = code ? code.textContent : pre.textContent;
          copyText(text).then(function(ok) {
            btn.textContent = ok ? '\u2713' : 'Failed';
            btn.classList.toggle('copied', ok);
            setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
          });
        };
      })(pre, btn);
      pre.appendChild(btn);

      if (threshold > 0) {
        var code = pre.querySelector('code');
        var text = code ? code.textContent : pre.textContent;
        var lineCount = (text.match(/\n/g) || []).length + 1;
        if (lineCount > threshold) {
          pre.classList.add('collapsed');
          var expandBtn = document.createElement('button');
          expandBtn.className = 'code-expand-btn';
          expandBtn.textContent = 'Show ' + lineCount + ' lines';
          (function(pre, expandBtn, lineCount) {
            expandBtn.onclick = function() {
              if (pre.classList.contains('collapsed')) {
                pre.classList.remove('collapsed');
                expandBtn.textContent = 'Collapse';
              } else {
                pre.classList.add('collapsed');
                expandBtn.textContent = 'Show ' + lineCount + ' lines';
              }
            };
          })(pre, expandBtn, lineCount);
          pre.parentNode.insertBefore(expandBtn, pre.nextSibling);
        }
      }
    }
  }

  // Expose globally so the message renderer can call it directly
  window.addCodeCopyButtons = addCodeCopyButtons;

  // Register with plugin system
  if (window.The151Machine && window.The151Machine.register) {
    window.The151Machine.register('code-blocks', {
      enhance: addCodeCopyButtons,
      getCollapseThreshold: getCollapseThreshold,
    });
  }
})();
