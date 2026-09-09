import fs from 'node:fs';
import path from 'node:path';

export const MARKER = 'codecity/event';

export function hookCommand(port) {
  // -m 1 and `|| true` mean a missing or slow CodeCity can never block the agent.
  return `curl -sS -m 1 -X POST http://127.0.0.1:${port}/${MARKER} -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true`;
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

export function isInstalled(root, { port, shared = false } = {}) {
  const settings = read(settingsPath(root, shared));
  return (settings.hooks?.PostToolUse ?? []).some((entry) =>
    entry?.hooks?.some((hook) => String(hook.command).includes(`:${port}/${MARKER}`)),
  );
}
