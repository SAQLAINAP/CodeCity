#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { installHooks, uninstallHooks, isInstalled, hookCommand } from '../src/install.js';

const DEFAULT_PORT = 4317;

function parseArgs(argv) {
  const args = { command: 'start', port: DEFAULT_PORT, root: fs.realpathSync(process.cwd()), shared: false, maxFiles: 400, open: true, resume: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'init' || arg === 'start' || arg === 'uninstall') args.command = arg;
    else if (arg === '--port') args.port = Number(argv[++i]);
    // realpath so the root matches the paths agents report (macOS /tmp -> /private/tmp).
    else if (arg === '--root') args.root = fs.realpathSync(path.resolve(argv[++i]));
    else if (arg === '--max-files') args.maxFiles = Number(argv[++i]);
    else if (arg === '--shared') args.shared = true;
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--fresh') args.resume = false;
  }
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

if (!isInstalled(args.root, { port: args.port, shared: args.shared })) {
  console.warn(`No CodeCity hook found for port ${args.port}. Run "npx codecity init" first, or the city will stay still.`);
}

const { server, state } = createServer(args.root, { maxFiles: args.maxFiles, resume: args.resume });

server.listen(args.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${args.port}`;
  console.log(`CodeCity watching ${args.root}`);
  console.log(`  ${state.buildings.size} buildings, ${state.roads.length} roads${state.truncated ? ` (capped from ${state.totalFound} files — raise with --max-files)` : ''}`);
  if (state.resumedFrom) console.log(`  resumed ${state.resumedEvents} events from ${state.resumedFrom} (--fresh to start clean)`);
  console.log(`  ${url}`);
  if (args.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${args.port} is already in use. Try --port 4318.`);
  else console.error(error.message);
  process.exit(1);
});
