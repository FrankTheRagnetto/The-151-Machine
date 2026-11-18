/**
 * Tool Use Visualization Plugin — Client
 *
 * Real-time activity log during Claude's response: tool names,
 * elapsed time, spinner, and compact summary on completion.
 */

(function() {
  // --- Settings ---
  function getSetting(key) {
    if (window.The151Machine && window.The151Machine.getSetting) {
      var v = window.The151Machine.getSetting('tool-use-viz', key);
      if (v !== undefined && v !== null) return v;
    }
    var stored = localStorage.getItem('151-plugin-tool-use-viz-' + key);
    if (stored !== null) return stored;
    var defaults = { detailLevel: 'full', maxVisibleEntries: 7 };
    return defaults[key];
  }

  // --- Tool Labels ---
  var TOOL_LABELS = {
    'Read': 'Reading file', 'Edit': 'Editing code', 'Write': 'Writing file',
    'Bash': 'Running command', 'Grep': 'Searching code', 'Glob': 'Finding files',
    'Agent': 'Running subagent', 'TodoWrite': 'Updating tasks',
    'WebFetch': 'Fetching URL', 'WebSearch': 'Searching web',
    'Skill': 'Loading skill', 'EnterPlanMode': 'Planning',
    'ExitPlanMode': 'Plan complete', 'NotebookEdit': 'Editing notebook',
    'AskUserQuestion': 'Asking question',
  };

  var SERVER_LABELS = {
    'github': 'GitHub', 'workspace': 'Google Workspace',
    'jcodemunch': 'Analyzing code', 'context7': 'Fetching docs',
    'neon': 'Database', 'happy': 'Happy',
  };

  function friendlyToolName(raw) {
    if (TOOL_LABELS[raw]) return TOOL_LABELS[raw];
    if (raw.startsWith('mcp__')) {
      var parts = raw.split('__');
      var server = parts[1] || '';
      var tool = parts.slice(2).join('_') || '';
      var label = SERVER_LABELS[server];
      if (label) {
        if (tool) {
          var cleanTool = tool.replace(/_/g, ' ').replace(/^(get|list|search|create|update|delete|read|find|manage)\s/i, '');
          return label + ': ' + cleanTool;
        }
        return label;
      }
      return tool.replace(/_/g, ' ') || raw;
    }
    return raw;
  }

  function extractToolDetail(toolName, input) {
    if (!input || typeof input !== 'object') return '';
    if (input.file_path) {
      var parts = input.file_path.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1] || input.file_path;
    }
    if (input.command) {
      var cmd = input.command.trim().split('\n')[0];
      return cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
    }
    if (input.pattern) return '"' + input.pattern + '"';
    if (input.skill) return input.skill;
    if (input.description) return input.description;
    if (input.url) return input.url;
    if (input.query) return input.query;
    return '';
  }

  // --- Activity Log State ---
  var activityLogEntries = [];
  var inlineActivityEl = null;
  var activityStartTime = null;
  var activityElapsedTimer = null;

  function formatElapsed(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function formatTime() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function ensureActivityLog() {
    if (!inlineActivityEl) {
      inlineActivityEl = document.createElement('div');
      inlineActivityEl.id = 'inline-activity';
      inlineActivityEl.classList.add('active');
      var streamingEl = window.streamingEl;
      if (streamingEl) {
        streamingEl.appendChild(inlineActivityEl);
      } else {
        var messagesEl = document.getElementById('messages');
        streamingEl = document.createElement('div');
        streamingEl.className = 'message assistant streaming thinking-state';
        var meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.innerHTML = '<span class="msg-role">Claude</span><span>' + formatTime() + '</span>';
        streamingEl.appendChild(meta);
        streamingEl._body = document.createElement('div');
        streamingEl._body.className = 'streaming-text';
        streamingEl.appendChild(streamingEl._body);
        streamingEl.appendChild(inlineActivityEl);
        messagesEl.appendChild(streamingEl);
        window.streamingEl = streamingEl;
      }
      activityStartTime = Date.now();
      if (activityElapsedTimer) clearInterval(activityElapsedTimer);
      activityElapsedTimer = setInterval(updateElapsed, 1000);
    }
    return inlineActivityEl;
  }

  function updateElapsed() {
    if (!inlineActivityEl || !activityStartTime) return;
    var el = inlineActivityEl.querySelector('.activity-elapsed');
    if (el) el.textContent = formatElapsed(Date.now() - activityStartTime);
  }

  function addActivity(type, text, detail) {
    if (getSetting('detailLevel') === 'hidden') return;
    var log = ensureActivityLog();
    var friendlyText = (type === 'tool') ? friendlyToolName(text) : text;
    var entry = { type: type, text: friendlyText, raw: text, detail: detail || '' };
    activityLogEntries.push(entry);
    renderActivityLog(log);
    if (typeof window.scrollToBottom === 'function') window.scrollToBottom();
  }

  function renderActivityLog(log) {
    var level = getSetting('detailLevel');
    var maxVisible = parseInt(getSetting('maxVisibleEntries')) || 7;
    var icons = { thinking: '&#9679;', tool: '&#9881;', done: '&#10003;' };
    var entries = activityLogEntries;
    var html = '';
    // SECURITY (P2.2): never a no-op fallback — always escape.
    var esc = typeof window.escapeHtml === 'function' ? window.escapeHtml : function(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

    var showFrom = 0;
    if (entries.length > maxVisible) {
      showFrom = entries.length - (maxVisible - 1);
      html += '<div class="activity-collapsed">' + showFrom + ' previous steps</div>';
    }

    for (var i = showFrom; i < entries.length - 1; i++) {
      var e = entries[i];
      var icon = e.done ? '&#10003;' : (icons[e.type] || '&#9679;');
      var itemClass = e.done ? 'done' : e.type;
      var detailHtml = (level === 'full' && e.detail) ? ' <span class="al-detail">' + esc(e.detail) + '</span>' : '';
      html += '<div class="activity-log-item ' + itemClass + '">' +
        '<span class="al-icon">' + icon + '</span>' +
        '<span class="al-text">' + esc(e.text) + detailHtml + '</span></div>';
    }

    var last = entries[entries.length - 1];
    if (last) {
      var elapsed = activityStartTime ? formatElapsed(Date.now() - activityStartTime) : '';
      var lastDetail = (level === 'full' && last.detail) ? ' <span class="al-detail">' + esc(last.detail) + '</span>' : '';
      html += '<div class="activity-current">' +
        '<div class="activity-spinner"></div>' +
        '<span>' + esc(last.text) + lastDetail + '</span>' +
        '<span class="activity-elapsed">' + elapsed + '</span>' +
      '</div>';
    }

    log.innerHTML = html;
  }

  function hideActivity() {
    if (activityElapsedTimer) { clearInterval(activityElapsedTimer); activityElapsedTimer = null; }
    if (inlineActivityEl) {
      var totalTime = activityStartTime ? formatElapsed(Date.now() - activityStartTime) : '';
      var toolCount = activityLogEntries.filter(function(e) { return e.type === 'tool'; }).length;
      var summary = '';
      if (toolCount > 0) summary = toolCount + ' tool' + (toolCount > 1 ? 's' : '') + ' used';
      if (totalTime) summary += (summary ? ' \u00b7 ' : '') + totalTime;
      if (summary) {
        inlineActivityEl.innerHTML = '<div class="activity-log-item done">' +
          '<span class="al-icon">&#10003;</span>' +
          '<span class="al-text">' + summary + '</span></div>';
      } else {
        inlineActivityEl.remove();
      }
      inlineActivityEl = null;
      activityLogEntries = [];
      activityStartTime = null;
    }
  }

  function appendToolSummary(tools) {
    if (!tools || tools.length === 0) return;
    // SECURITY (P2.2): never a no-op fallback — always escape.
    var esc = typeof window.escapeHtml === 'function' ? window.escapeHtml : function(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var counts = {};
    for (var i = 0; i < tools.length; i++) {
      var name = friendlyToolName(tools[i]);
      counts[name] = (counts[name] || 0) + 1;
    }
    var summary = Object.keys(counts).map(function(name) {
      return counts[name] > 1 ? name + ' x' + counts[name] : name;
    }).join(', ');

    var div = document.createElement('div');
    div.className = 'tool-card';
    div.innerHTML =
      '<div class="tool-card-header">' +
        '<span class="arrow">&#9654;</span>' +
        '<span>' + tools.length + ' tool' + (tools.length > 1 ? 's' : '') + ': ' + esc(summary) + '</span>' +
      '</div>' +
      '<div class="tool-card-body"><pre><code>' + tools.map(function(t) { return esc(friendlyToolName(t)); }).join('\n') + '</code></pre></div>';
    div.querySelector('.tool-card-header').onclick = function() { div.classList.toggle('open'); };
    var messagesEl = document.getElementById('messages');
    if (messagesEl) messagesEl.appendChild(div);
  }

  function showThinkingState() {
    addActivity('thinking', 'Processing...');
    if (!window.streamingEl) {
      var messagesEl = document.getElementById('messages');
      var el = document.createElement('div');
      el.className = 'message assistant streaming thinking-state';
      var meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = '<span class="msg-role">Claude</span><span>' + formatTime() + '</span>';
      el.appendChild(meta);
      el._body = document.createElement('div');
      el._body.className = 'streaming-text';
      el.appendChild(el._body);
      var dots = document.createElement('div');
      dots.className = 'thinking-dots';
      dots.innerHTML = '<span></span><span></span><span></span>';
      el._body.appendChild(dots);
      messagesEl.appendChild(el);
      window.streamingEl = el;
      if (typeof window.scrollToBottom === 'function') window.scrollToBottom();
    }
  }

  // --- Expose Globally ---
  window.friendlyToolName = friendlyToolName;
  window.extractToolDetail = extractToolDetail;
  window.appendToolSummary = appendToolSummary;
  window.addActivity = addActivity;
  window.hideActivity = hideActivity;
  window.ensureActivityLog = ensureActivityLog;
  window.showThinkingState = showThinkingState;

  // --- Register ---
  if (window.The151Machine && window.The151Machine.register) {
    window.The151Machine.register('tool-use-viz', {
      friendlyToolName: friendlyToolName,
      extractToolDetail: extractToolDetail,
      addActivity: addActivity,
      hideActivity: hideActivity,
      showThinkingState: showThinkingState,
      appendToolSummary: appendToolSummary,
    });
  }
})();
