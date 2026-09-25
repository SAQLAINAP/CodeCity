#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { installHooks, uninstallHooks, hookStatus, hookCommand } from '../src/install.js';
import { THEME_IDS, isTheme } from '../src/themes.js';

const DEFAULT_PORT = 4317;

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// `open` is macOS-only, and spawning a binary that isn't there emits an 'error'
// event that would otherwise go unhandled and take the whole server down with it —
// so a missing browser opener has to stay the cosmetic failure it deserves to be.
const OPENERS = { darwin: 'open', win32: 'explorer', linux: 'xdg-open' };

function openBrowser(url) {
  const child = spawn(OPENERS[process.platform] ?? 'xdg-open', [url], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => {});
  child.unref();
}

const COMMANDS = new Set(['start', 'init', 'uninstall']);

const USAGE = `codecity — a visual trust layer for AI coding agents

  codecity [start]        scan, serve, and open the browser
  codecity init           write the PostToolUse hook into this project
  codecity uninstall      remove the hook again

  --port <n>              local server port (default ${DEFAULT_PORT}); must match what init wrote
  --root <dir>            project to visualise (default: cwd)
  --max-files <n>         building cap for large repos (default 400)
  --theme <name>          ${THEME_IDS.join(' | ')}
  --shared                write the hook to settings.json instead of settings.local.json
  --no-open               don't launch a browser
  --fresh                 ignore the previous session log instead of replaying it
  -h, --help              this text
  -v, --version           print the version
`;

function fail(message) {
  console.error(`codecity: ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    command: null, port: DEFAULT_PORT, root: fs.realpathSync(process.cwd()),
    shared: false, maxFiles: 400, open: true, resume: true, theme: null,
  };

  // A flag that needs a value must actually get one. Without this, `--port` at the end
  // of the line silently became NaN and the server bound to a random port.
  const value = (flag, raw) => {
    if (raw === undefined || raw.startsWith('--')) fail(`${flag} needs a value`);
    return raw;
  };
  const count = (flag, raw) => {
    const n = Number(value(flag, raw));
    if (!Number.isInteger(n) || n <= 0) fail(`${flag} needs a positive whole number, got "${raw}"`);
    return n;
  };

  for (let i = 0; i < argv.length; i += 1) {
    // Both `--port 4317` and `--port=4317` — the second is what people type by reflex,
    // and silently ignoring it was worse than not supporting it.
    const split = argv[i].indexOf('=');
    const arg = argv[i].startsWith('--') && split > 2 ? argv[i].slice(0, split) : argv[i];
    const inline = argv[i].startsWith('--') && split > 2 ? argv[i].slice(split + 1) : null;
    const next = () => (inline ?? argv[++i]);

    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else if (arg === '--version' || arg === '-v') { console.log(VERSION); process.exit(0); }
    else if (COMMANDS.has(arg)) {
      if (args.command) fail(`only one command at a time (got "${args.command}" and "${arg}")`);
      args.command = arg;
    } else if (arg === '--port') args.port = count('--port', next());
    else if (arg === '--max-files') args.maxFiles = count('--max-files', next());
    // realpath so the root matches the paths agents report (macOS /tmp -> /private/tmp).
    else if (arg === '--root') {
      const dir = path.resolve(value('--root', next()));
      if (!fs.existsSync(dir)) fail(`--root does not exist: ${dir}`);
      args.root = fs.realpathSync(dir);
    } else if (arg === '--theme') {
      const name = value('--theme', next());
      if (!isTheme(name)) fail(`unknown theme "${name}". Try: ${THEME_IDS.join(', ')}`);
      args.theme = name;
    } else if (arg === '--shared') args.shared = true;
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--fresh') args.resume = false;
    // Silently ignoring a typo'd flag is the worst option: you get the default
    // behaviour and no reason to suspect the flag didn't take.
    else fail(`unknown ${arg.startsWith('-') ? 'option' : 'command'} "${arg}"`);
  }

  args.command ??= 'start';
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.command === 'uninstall') {
  const file = uninstallHooks(args.root, { shared: args.shared });
  console.log(file ? `Removed CodeCity hook from ${file}` : 'No CodeCity hook found.');
  process.exit(0);
}

if (args.command === 'init') {
  const file = installHooks(args.root, { port: args.port, shared: args.shared });
  console.log(`Installed CodeCity hook in ${file}`);
  console.log(`  ${hookCommand(args.port)}`);
  console.log('\nRestart Claude Code in this project, then run: npx codecity');
  process.exit(0);
}

const status = hookStatus(args.root, { port: args.port, shared: args.shared });
if (status === 'missing') {
  console.warn(`No CodeCity hook found for port ${args.port}. Run "npx codecity init" first, or the city will stay still.`);
} else if (status === 'foreign') {
  console.warn(`The CodeCity hook here was written for another shell and will not fire on ${process.platform}. Run "npx codecity init" to rewrite it.`);
}

const { server, state } = createServer(args.root, {
  maxFiles: args.maxFiles, resume: args.resume, theme: args.theme,
});

server.listen(args.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${args.port}`;
  console.log(`CodeCity watching ${args.root}`);
  console.log(`  ${state.buildings.size} buildings, ${state.roads.length} roads${state.truncated ? ` (capped from ${state.totalFound} files — raise with --max-files)` : ''}`);
  if (state.resumedFrom) console.log(`  resumed ${state.resumedEvents} events from ${state.resumedFrom} (--fresh to start clean)`);
  console.log(`  ${url}`);
  if (args.open) openBrowser(url);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${args.port} is already in use. Try --port 4318.`);
  else console.error(error.message);
  process.exit(1);
});
