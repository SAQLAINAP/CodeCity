import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookCommand, installHooks, uninstallHooks, hookStatus, MARKER } from '../src/install.js';

const PORT = 4317;

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codecity-install-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every platform posts to the same marker and port', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.match(hookCommand(PORT, platform), new RegExp(`:${PORT}/${MARKER}`));
  }
});

// The hook fires after every tool call, so a non-zero exit would surface an error
// once per call whenever CodeCity simply isn't running.
test('every platform swallows the exit code', () => {
  assert.match(hookCommand(PORT, 'darwin'), /\|\| true$/);
  assert.match(hookCommand(PORT, 'win32'), /; exit 0$/);
});

test('windows avoids the two syntaxes PowerShell 5.1 does not share with sh', () => {
  const command = hookCommand(PORT, 'win32');
  // `curl` in PowerShell 5.1 is an alias for Invoke-WebRequest, not curl.
  assert.match(command, /^curl\.exe /);
  // PowerShell 5.1 has no `||` operator at all.
  assert.doesNotMatch(command, /\|\|/);
  // No /dev/null on Windows.
  assert.doesNotMatch(command, /\/dev\/null/);
  // Bare @- can read as PowerShell's splatting operator; quoting settles it.
  assert.match(command, /--data-binary "@-"/);
});

test('the windows command is still valid POSIX, because Git Bash may run it', () => {
  // Claude Code picks Git Bash when it is installed and PowerShell when it is not,
  // and install time cannot know which — so one string has to satisfy both.
  const command = hookCommand(PORT, 'win32');
  const shim = tempRoot();
  fs.writeFileSync(path.join(shim, 'curl.exe'), '#!/bin/sh\nexit 7\n');
  fs.chmodSync(path.join(shim, 'curl.exe'), 0o755);

  for (const shell of ['sh', 'bash']) {
    // The exit code has to be read from the shell process itself: the command ends
    // in `exit 0`, so nothing appended to it would ever run.
    const result = spawnSync(shell, ['-c', command], {
      input: '{}',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    // curl.exe exited 7 and the hook still reports success, silently.
    assert.equal(result.status, 0, `${shell} should exit 0`);
    assert.equal(result.stdout, '', `${shell} should print nothing`);
    assert.equal(result.stderr, '', `${shell} should stay quiet`);
  }
});

test('install writes a hook, uninstall removes it cleanly', () => {
  const root = tempRoot();
  const file = installHooks(root, { port: PORT });

  assert.equal(hookStatus(root, { port: PORT }), 'ok');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PostToolUse.length, 1);

  uninstallHooks(root, { port: PORT });
  assert.equal(hookStatus(root, { port: PORT }), 'missing');
  // The hooks key goes away entirely rather than being left as an empty husk.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, undefined);
});

test('installing twice does not stack duplicate hooks', () => {
  const root = tempRoot();
  installHooks(root, { port: PORT });
  const file = installHooks(root, { port: PORT });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PostToolUse.length, 1);
});

test('uninstall leaves someone else\'s hooks alone', () => {
  const root = tempRoot();
  const file = path.join(root, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }));

  installHooks(root, { port: PORT });
  uninstallHooks(root, { port: PORT });

  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(settings.hooks.PostToolUse.map((e) => e.hooks[0].command), ['echo mine']);
});

// A --shared settings.json committed on one OS and checked out on another leaves a
// hook that is present but will never fire. Silence is the worst outcome here.
test('a hook written for another shell reports as foreign, not ok', () => {
  const root = tempRoot();
  const file = installHooks(root, { port: PORT });
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const other = process.platform === 'win32' ? 'darwin' : 'win32';
  settings.hooks.PostToolUse[0].hooks[0].command = hookCommand(PORT, other);
  fs.writeFileSync(file, JSON.stringify(settings));

  assert.equal(hookStatus(root, { port: PORT }), 'foreign');
  // Re-running install repairs it.
  installHooks(root, { port: PORT });
  assert.equal(hookStatus(root, { port: PORT }), 'ok');
});

test('a hook on a different port is not mistaken for ours', () => {
  const root = tempRoot();
  installHooks(root, { port: 4317 });
  assert.equal(hookStatus(root, { port: 4318 }), 'missing');
});
