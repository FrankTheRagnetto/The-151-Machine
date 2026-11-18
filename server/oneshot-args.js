'use strict';

// =============================================================================
// oneshot-args.js — argv builder for the background `claude -p` one-shots.
// =============================================================================
// WHY THIS EXISTS (audit 2026-08-20, work/ladri-utilizzo-21-08.md §3):
//   The background engines (skill-writer, memory-engine, auto-title,
//   skill-curator) all shell out to `claude -p ... --model haiku --max-turns 1`.
//   With no isolation flags the CLI treats each of those as a FULL interactive
//   session and ingests the whole preamble before reading the prompt:
//     - the default Claude Code system prompt
//     - every tool schema (Bash/Read/Edit/Task/Cron/Task*/MCP wrappers...)
//     - the user's ~/.claude skill listing (~60 entries) + agent listing
//     - MCP server instructions (context7, Gmail, Calendar, playwright, ...)
//   MEASURED: 28.016 tokens ingested for a 10-token prompt — a ~16x multiplier
//   on real payloads, on EVERY background call (110 of them on 2026-08-20 alone,
//   236 on the 15th). None of that context is reachable: these calls are pure
//   text-in/text-out with --max-turns 1, they can never invoke a tool.
//
// WHAT THE FLAGS DO (each verified live, numbers are the same 10-token probe):
//   --strict-mcp-config        no MCP servers            28.016 -> 25.831
//   --setting-sources ''       no user/project settings  25.831 -> 24.824
//                              (skills, agents, CLAUDE.md, plugins)
//   --no-session-persistence   no transcript on disk     (see below)
//   --system-prompt <s>        replaces the default CC   24.824 -> 18.475
//                              system prompt with one line
//   --disallowed-tools <all>   drops every tool schema   18.475 ->    173
//                              ------------------------------------------
//                                                   TOTAL: 28.016 -> 173
//
//   --no-session-persistence is doing double duty: it stops the CLI writing a
//   ~60KB transcript into ~/.claude/projects/-tmp/ for every one-shot (3.007
//   files / 154 MB had accumulated), AND it suppresses the CLI's own `ai-title`
//   call — a second, entirely pointless model call that was being made to name a
//   throwaway session (62 of them on 2026-08-20).
//
// SAFETY / BLAST RADIUS:
//   - Only the four background engines use this. The real chat sessions go
//     through server/sdk-engine.js and are NOT touched.
//   - Disallowing a tool name that does not exist is a no-op, so the list is
//     safe to keep broad. If a future CLI ships a tool that is NOT in the list
//     it simply gets loaded again (degrades to the old cost, never breaks).
//   - --system-prompt REPLACES the default. That is correct here: these prompts
//     are fully self-contained instructions. It is also why
//     --exclude-dynamic-system-prompt-sections is deliberately NOT used (the
//     help text says it is ignored with --system-prompt).
// =============================================================================

// Every tool the CLI is known to expose. Observed live via
// `--output-format stream-json --verbose` (the `system` init message lists
// `tools`), plus the deferred/named tools this workspace surfaces.
// Order is irrelevant; unknown names are ignored by the CLI.
const ALL_TOOLS = [
  // core file / shell
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep',
  // agents / planning / tasks
  'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput',
  'TaskStop', 'TodoWrite', 'ListAgents', 'Workflow', 'Plan',
  'EnterPlanMode', 'ExitPlanMode', 'ReportFindings',
  // web
  'WebFetch', 'WebSearch',
  // skills / commands
  'Skill', 'SlashCommand', 'ToolSearch',
  // scheduling / notification / remote
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification',
  'RemoteTrigger', 'Monitor', 'SendMessage', 'AskUserQuestion',
  // worktree / design
  'EnterWorktree', 'ExitWorktree', 'DesignSync',
  // mcp plumbing
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
];

// A minimal replacement system prompt. Deliberately generic: each engine passes
// its own one-liner so the model still knows what shape of answer to produce,
// without dragging in the 6k-token Claude Code operator prompt.
const DEFAULT_SYSTEM = 'You are a precise text processor. Follow the instruction exactly and output nothing else.';

/**
 * Build the argv for an isolated background one-shot.
 *
 * @param {string} prompt        the full user prompt (the engine's own template)
 * @param {object} [opts]
 * @param {string} [opts.model]  default 'haiku'
 * @param {string} [opts.system] one-line system prompt for this engine
 * @param {string[]} [opts.extra] extra flags appended verbatim (e.g. ['--bare'])
 * @returns {string[]} argv for execFile(CLAUDE_BIN, argv, ...)
 */
function oneShotArgs(prompt, opts) {
  const o = opts || {};
  return [
    '-p', prompt,
    '--model', o.model || 'haiku',
    '--max-turns', '1',
    // --- isolation (see header) ---
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    '--system-prompt', o.system || DEFAULT_SYSTEM,
    '--disallowed-tools', ALL_TOOLS.join(' '),
    ...(Array.isArray(o.extra) ? o.extra : []),
  ];
}

module.exports = { oneShotArgs, ALL_TOOLS, DEFAULT_SYSTEM };
