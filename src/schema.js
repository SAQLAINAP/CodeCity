import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Each action is exactly one class of tool call. If a visual state can't be traced
// back to a tool call, it doesn't exist. See README "The metaphor must map 1:1".
export const ACTIONS = {
  construct: { label: 'Under construction', hint: 'file written from scratch' },
  renovate: { label: 'Renovation', hint: 'file edited in place' },
  survey: { label: 'Survey', hint: 'file read' },
  inspect: { label: 'Inspection', hint: 'tests or lint run' },
  crew: { label: 'Crew on site', hint: 'shell command or subagent' },
  extract: { label: 'On-site extraction', hint: 'MCP tool call' },
  deliver: { label: 'Material delivery', hint: 'external API or web fetch' },
};

const INSPECT_COMMAND = /(^|[\s;&|])(npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|jest|vitest|mocha|pytest|tox|ruff|mypy|flake8|black|eslint|prettier|tsc|go\s+test|cargo\s+(test|clippy)|rspec|phpunit|gradle\s+test|mvn\s+test)\b/;

function firstFilePath(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.filePath || input.notebook_path || input.path || null;
}

function clip(value, max = 400) {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function editDetail(input) {
  if (Array.isArray(input?.edits)) {
    return `${input.edits.length} edit(s); first replaces ${clip(input.edits[0]?.old_string, 120)}`;
  }
  if (input?.old_string != null) {
    return `replaced ${clip(input.old_string, 160)} with ${clip(input.new_string, 160)}`;
  }
  return null;
}

// Returns { action, file, detail } — file is absolute or null when the call has no
// single target (Grep, Bash, WebFetch). Those still reach the event feed, they just
// don't change a building's state.
export function classify(toolName, toolInput) {
  const name = toolName || 'unknown';

  if (name.startsWith('mcp__')) {
    return { action: 'extract', file: null, detail: `${name} ${clip(toolInput, 200)}` };
  }

  switch (name) {
    case 'Write':
      return {
        action: 'construct',
        file: firstFilePath(toolInput),
        detail: `wrote ${String(toolInput?.content ?? '').split('\n').length} lines`,
      };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { action: 'renovate', file: firstFilePath(toolInput), detail: editDetail(toolInput) };
    case 'Read':
    case 'NotebookRead':
      return { action: 'survey', file: firstFilePath(toolInput), detail: 'read the file' };
    case 'Grep':
      return { action: 'survey', file: null, detail: `searched for ${clip(toolInput?.pattern, 120)}` };
    case 'Glob':
      return { action: 'survey', file: null, detail: `listed files matching ${clip(toolInput?.pattern, 120)}` };
    case 'Bash':
    case 'BashOutput': {
      const command = String(toolInput?.command ?? '');
      return {
        action: INSPECT_COMMAND.test(command) ? 'inspect' : 'crew',
        file: null,
        detail: clip(command, 300),
      };
    }
    case 'WebFetch':
    case 'WebSearch':
      return {
        action: 'deliver',
        file: null,
        detail: clip(toolInput?.url || toolInput?.query, 200),
      };
    case 'Task':
      return { action: 'crew', file: null, detail: clip(toolInput?.description, 200) };
    default:
      return { action: 'crew', file: firstFilePath(toolInput), detail: clip(toolInput, 200) };
  }
}

const PATH_CANDIDATE = /[\w@.~-]*(?:\/[\w@.~-]+)+\.\w{1,6}\b|\b[\w@.~-]+\.\w{1,6}\b/g;

// Bash commands and MCP calls name their target inside a string rather than a
// file_path field, so the crew and the drill would never land on a building. One
// existsSync per candidate is cheap and keeps this deterministic.
function sniffPath(text, cwd, root) {
  if (!text) return null;
  for (const word of (String(text).match(PATH_CANDIDATE) ?? []).slice(0, 12)) {
    for (const candidate of [path.resolve(cwd, word), path.resolve(root, word)]) {
      if (relativize(candidate, root) === null) continue;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not a real path, just a word with a dot in it.
      }
    }
  }
  return null;
}

// Agents report realpath'd paths, so on macOS a root of /tmp/x never matches an
// event path of /private/tmp/x. Retry through realpath before giving up.
function relativize(absolute, root) {
  const direct = path.relative(root, absolute);
  if (!direct.startsWith('..')) return direct || path.basename(absolute);
  try {
    const resolved = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
    if (!resolved.startsWith('..')) return resolved || path.basename(absolute);
  } catch {
    // The file may already be gone; treat it as outside the city.
  }
  return null;
}

// The only place that knows what a given agent's payload looks like. Adding a
// second agentic tool is an entry here, not a change anywhere downstream — that is
// the whole claim that the harness is tool-agnostic.
function adapt(payload) {
  if (payload?.tool_name) {
    return {
      tool: payload.tool_name,
      input: payload.tool_input,
      cwd: payload.cwd,
      sessionId: payload.session_id,
      hook: payload.hook_event_name,
    };
  }
  // OpenAI-style function calls, as emitted by Codex and most MCP-native runners.
  if (payload?.name) {
    let input = payload.arguments ?? payload.args ?? payload.parameters;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = { command: input }; }
    }
    return { tool: payload.name, input, cwd: payload.cwd, sessionId: payload.session_id, hook: payload.event };
  }
  // Already in our shape: any agent can post this directly with a one-line hook.
  return { tool: payload?.tool, input: payload?.input, cwd: payload?.cwd, sessionId: payload?.sessionId, hook: payload?.hook };
}

// Normalizes a raw agent hook payload into the one event shape the rest of the
// system knows about.
export function normalize(payload, root) {
  const source = adapt(payload);
  const { action, file, detail } = classify(source.tool, source.input);
  const cwd = source.cwd || root;

  let absolute = file ? path.resolve(cwd, file) : null;
  if (!absolute && (action === 'crew' || action === 'inspect' || action === 'extract')) {
    absolute = sniffPath(detail, cwd, root);
  }

  return {
    id: randomUUID(),
    ts: Date.now(),
    sessionId: source.sessionId || 'unknown',
    hook: source.hook || 'PostToolUse',
    tool: source.tool || 'unknown',
    action,
    file: absolute ? relativize(absolute, root) : null,
    detail: detail ?? null,
  };
}
