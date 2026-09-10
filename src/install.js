import fs from 'node:fs';
import path from 'node:path';

export const MARKER = 'codecity/event';

// This runs after every single tool call, so it has to be cheap and it has to fail
// silently. Cheap rules out a Node script: ~76ms of interpreter startup per call
// against curl's ~16ms. Silent means swallowing the exit code, because a CodeCity
// that simply isn't running makes curl exit 7, and Claude Code surfaces any
// non-zero hook exit as an error — once per tool call.
export function hookCommand(port, platform = process.platform) {
  const url = `http://127.0.0.1:${port}/${MARKER}`;

  if (platform === 'win32') {
    // Claude Code runs hooks through Git Bash when it is installed and PowerShell
    // when it is not, and which one we will get cannot be known at install time —
    // so this single string has to be valid in both. That rules out `|| true`
    // (PowerShell 5.1 has no `||`) and bare `curl` (in PowerShell 5.1 that name is
    // an alias for Invoke-WebRequest, not curl at all). `curl.exe` and a trailing
    // `exit 0` are syntax the two shells agree on. Needs Windows 10 1803+, which
    // is where curl.exe ships.
    //
    // Every argument is double-quoted, which is a no-op for sh but load-bearing for
    // PowerShell: bare `@-` risks being read as the splatting operator, and an
    // unquoted header would split on its space. Quoting means neither parser gets
    // a chance to be clever.
    return `curl.exe -s -m 1 -X POST "${url}" -H "content-type: application/json" --data-binary "@-" ; exit 0`;
  }

  // -m 1 and `|| true` mean a missing or slow CodeCity can never block the agent.
  return `curl -sS -m 1 -X POST ${url} -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true`;
}

function settingsPath(root, shared) {
  return path.join(root, '.claude', shared ? 'settings.json' : 'settings.local.json');
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function installHooks(root, { port, shared = false } = {}) {
  const file = settingsPath(root, shared);
  const settings = read(file);
  settings.hooks ??= {};
  const command = hookCommand(port);

  for (const eventName of ['PostToolUse']) {
    const matchers = (settings.hooks[eventName] ??= []);
    const ours = matchers.find((entry) =>
      entry?.hooks?.some((hook) => typeof hook.command === 'string' && hook.command.includes(MARKER)),
    );
    if (ours) {
      ours.matcher = '*';
      ours.hooks = [{ type: 'command', command }];
    } else {
      matchers.push({ matcher: '*', hooks: [{ type: 'command', command }] });
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

export function uninstallHooks(root, { shared = false } = {}) {
  const file = settingsPath(root, shared);
  if (!fs.existsSync(file)) return null;
  const settings = read(file);
  for (const eventName of Object.keys(settings.hooks ?? {})) {
    settings.hooks[eventName] = settings.hooks[eventName].filter(
      (entry) => !entry?.hooks?.some((hook) => String(hook.command).includes(MARKER)),
    );
    if (settings.hooks[eventName].length === 0) delete settings.hooks[eventName];
  }
  if (Object.keys(settings.hooks ?? {}).length === 0) delete settings.hooks;
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

// 'missing' | 'foreign' | 'ok'. 'foreign' means a hook is there but was written for
// another shell — what you get when a --shared settings.json is committed on macOS
// and checked out on Windows. Silently doing nothing is the worst outcome for a
// tool whose whole job is showing you what the agent touched, so it is worth naming.
export function hookStatus(root, { port, shared = false } = {}) {
  const settings = read(settingsPath(root, shared));
  const installed = (settings.hooks?.PostToolUse ?? [])
    .flatMap((entry) => entry?.hooks ?? [])
    .map((hook) => String(hook.command))
    .filter((command) => command.includes(`:${port}/${MARKER}`));

  if (installed.length === 0) return 'missing';
  return installed.includes(hookCommand(port)) ? 'ok' : 'foreign';
}
