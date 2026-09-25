import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_IDS, DEFAULT_THEME, isTheme } from '../src/themes.js';

const BIN = fileURLToPath(new URL('../bin/codecity.js', import.meta.url));

function root() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codecity-cli-')));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export const a = 1;\n');
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The CLI is spawned rather than imported because the thing under test is the whole
// contract a user meets: exit codes and stderr, not just the parsed object.
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

/* ---------- commands, with and without a subcommand ---------- */

test('the bare binary and an explicit `start` mean the same thing', () => {
  const cwd = root();
  // --help short-circuits before the server binds, so this compares parse results
  // without either invocation needing a port.
  const bare = run(['--help'], cwd);
  const explicit = run(['start', '--help'], cwd);
  assert.equal(bare.status, 0);
  assert.equal(explicit.status, 0);
  assert.equal(bare.stdout, explicit.stdout);
});

test('init writes a hook and uninstall takes it away again', () => {
  const cwd = root();
  const settings = path.join(cwd, '.claude', 'settings.local.json');

  const installed = run(['init', '--port', '4399'], cwd);
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /Installed CodeCity hook/);
  assert.match(fs.readFileSync(settings, 'utf8'), /4399\/codecity\/event/);

  const removed = run(['uninstall', '--port', '4399'], cwd);
  assert.equal(removed.status, 0);
  assert.doesNotMatch(fs.readFileSync(settings, 'utf8'), /codecity\/event/);
});

test('--help and --version answer without touching the project', () => {
  const cwd = root();
  for (const flag of ['--help', '-h']) {
    const result = run([flag], cwd);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /codecity \[start\]/);
  }
  for (const flag of ['--version', '-v']) {
    const result = run([flag], cwd);
    assert.equal(result.status, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  }
  assert.equal(fs.existsSync(path.join(cwd, '.claude')), false);
});

/* ---------- bad input has to be loud ---------- */

// A typo'd flag used to be skipped in silence, so you got default behaviour and no
// reason to suspect the flag hadn't taken. That is the worst failure mode a CLI has.
test('an unknown flag fails instead of being ignored', () => {
  const result = run(['--prot', '4399'], root());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option "--prot"/);
});

test('an unknown command fails', () => {
  const result = run(['bogus'], root());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command "bogus"/);
});

test('two commands at once fails rather than picking one', () => {
  const result = run(['init', 'uninstall'], root());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only one command/);
});

test('a flag that needs a value says so when it does not get one', () => {
  const cwd = root();
  assert.match(run(['--port'], cwd).stderr, /--port needs a value/);
  assert.match(run(['--port', '--fresh'], cwd).stderr, /--port needs a value/);
});

test('a non-numeric or non-positive count is rejected', () => {
  const cwd = root();
  for (const bad of ['abc', '0', '-3', '1.5']) {
    const result = run(['--max-files', bad], cwd);
    assert.equal(result.status, 1, `--max-files ${bad} should fail`);
    assert.match(result.stderr, /positive whole number/);
  }
});

test('--root must exist, because scanning nothing looks identical to a broken scan', () => {
  const result = run(['--root', '/nope/does/not/exist'], root());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--root does not exist/);
});

/* ---------- flag syntax ---------- */

test('--flag=value works as well as --flag value', () => {
  const cwd = root();
  const spaced = run(['init', '--port', '4401'], cwd);
  const joined = run(['init', '--port=4401'], cwd);
  assert.equal(spaced.status, 0);
  assert.equal(joined.status, 0);
  assert.equal(spaced.stdout, joined.stdout);
});

/* ---------- themes ---------- */

test('--theme accepts every registered theme and nothing else', () => {
  const cwd = root();
  for (const theme of THEME_IDS) {
    // init ignores --theme but still parses it, which is the cheap way to exercise
    // validation without binding a port.
    const result = run(['init', '--theme', theme, '--port', '4402'], cwd);
    assert.equal(result.status, 0, `${theme} should be accepted`);
  }
  const bad = run(['--theme', 'neon'], cwd);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown theme "neon"/);
  // The error names the alternatives, so the fix doesn't need a second command.
  for (const theme of THEME_IDS) assert.match(bad.stderr, new RegExp(theme));
});

test('the theme registry is self-consistent', () => {
  assert.ok(THEME_IDS.length > 1);
  assert.equal(THEME_IDS.length, new Set(THEME_IDS).size, 'ids must be unique');
  assert.equal(DEFAULT_THEME, THEME_IDS[0]);
  assert.ok(isTheme(DEFAULT_THEME));
  assert.equal(isTheme('nope'), false);
});

// A theme id with no stylesheet block would switch the attribute, resolve every token
// to the default, and look like nothing happened — the hardest kind of bug to see.
test('every registered theme has a stylesheet block', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME) {
      assert.match(css, /^:root \{/m, 'the default theme is the bare :root block');
      continue;
    }
    assert.ok(css.includes(`[data-theme='${id}']`), `${id} has no block in style.css`);
  }
});

// The canvas reads its palette from these, so one missing token in one theme is a
// colour silently inherited from the default — off-palette and hard to spot.
test('every theme defines every token the renderer reads', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/:root(?:\[data-theme='([^']+)'\])?\s*\{([^}]*)\}/g)];
  const named = new Map(blocks.map((m) => [m[1] ?? DEFAULT_THEME, m[2]]));

  const base = named.get(DEFAULT_THEME);
  assert.ok(base, 'the default block must exist');
  const required = [...base.matchAll(/^\s*(--[\w-]+):/gm)]
    .map((m) => m[1])
    // Form tokens are deliberately inherited when a theme is happy with the default.
    .filter((name) => !['--font', '--tracking', '--border-w', '--radius', '--shadow', '--blur', '--weight'].includes(name));

  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME) continue;
    const block = named.get(id);
    assert.ok(block, `${id} block missing`);
    for (const token of required) {
      assert.ok(block.includes(`${token}:`), `${id} is missing ${token}`);
    }
  }
});
