import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/scan.js';
import { CityState } from '../src/state.js';

function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codecity-roads-')));
  write(root, files);
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

const roadsFrom = (roads, from) => roads.filter((r) => r.from === from).map((r) => r.to).sort();

test('a relative import becomes a road', () => {
  const root = project({
    'src/main.js': "import { a } from './alpha.js';\n",
    'src/alpha.js': 'export const a = 1;\n',
  });
  assert.deepEqual(roadsFrom(scanProject(root).roads, 'src/main.js'), ['src/alpha.js']);
});

// A road that outlives the import it came from is a lie about the codebase, which
// is the one failure mode a trust tool cannot have.
test('deleting an import removes its road', () => {
  const root = project({
    'src/main.js': "import { a } from './alpha.js';\nimport { b } from './beta.js';\n",
    'src/alpha.js': 'export const a = 1;\n',
    'src/beta.js': 'export const b = 2;\n',
  });
  const state = new CityState(root, { resume: false });
  assert.deepEqual(roadsFrom(state.roads, 'src/main.js'), ['src/alpha.js', 'src/beta.js']);

  write(root, { 'src/main.js': "import { a } from './alpha.js';\n" });
  state.apply({ ts: Date.now(), action: 'construct', file: 'src/main.js', tool: 'Write' });

  assert.deepEqual(roadsFrom(state.roads, 'src/main.js'), ['src/alpha.js']);
});

test('removing every import leaves no roads behind', () => {
  const root = project({
    'src/main.js': "import { a } from './alpha.js';\n",
    'src/alpha.js': 'export const a = 1;\n',
  });
  const state = new CityState(root, { resume: false });

  write(root, { 'src/main.js': 'console.log("nothing");\n' });
  state.apply({ ts: Date.now(), action: 'construct', file: 'src/main.js', tool: 'Write' });

  assert.deepEqual(roadsFrom(state.roads, 'src/main.js'), []);
  assert.deepEqual(state.buildings.get('src/main.js').deps, []);
});

test('a file the agent creates mid-session gets roads immediately', () => {
  const root = project({ 'src/main.js': 'export const m = 1;\n' });
  const state = new CityState(root, { resume: false });

  write(root, {
    'src/gamma.js': 'export const g = 3;\n',
    'src/main.js': "import { g } from './gamma.js';\n",
  });
  state.apply({ ts: Date.now(), action: 'construct', file: 'src/gamma.js', tool: 'Write' });
  state.apply({ ts: Date.now(), action: 'construct', file: 'src/main.js', tool: 'Write' });

  assert.deepEqual(roadsFrom(state.roads, 'src/main.js'), ['src/gamma.js']);
  assert.equal(state.buildings.get('src/gamma.js').created, true);
});

test('a read never touches roads', () => {
  const root = project({
    'src/main.js': "import { a } from './alpha.js';\n",
    'src/alpha.js': 'export const a = 1;\n',
  });
  const state = new CityState(root, { resume: false });
  const { roads } = state.apply({ ts: Date.now(), action: 'survey', file: 'src/main.js', tool: 'Read' });

  // null means "this event says nothing about roads" — distinct from [] meaning
  // "this file has none", which is what lets the client tell replace from ignore.
  assert.equal(roads, null);
  assert.deepEqual(roadsFrom(state.roads, 'src/main.js'), ['src/alpha.js']);
});

test('third-party packages are dependencies, not roads', () => {
  const root = project({ 'src/main.js': "import axios from 'axios';\n" });
  const { roads, files } = scanProject(root);
  assert.deepEqual(roads, []);
  assert.deepEqual(files.find((f) => f.path === 'src/main.js').deps, ['axios']);
});

// Regression: `import logging` used to draw a road to any app/util/logging.py that
// happened to exist. A single-segment specifier in a namespaced language is a
// stdlib or package name, never a path.
test('a stdlib import does not draw a road to a same-named local file', () => {
  const root = project({
    'app/main.py': 'import logging\nimport json\n',
    'app/util/logging.py': 'x = 1\n',
    'app/util/json.py': 'y = 2\n',
  });
  assert.deepEqual(roadsFrom(scanProject(root).roads, 'app/main.py'), []);
});

test('an ambiguous specifier resolves to nothing rather than guessing', () => {
  const root = project({
    'src/main.js': "import x from 'shared/util';\n",
    'a/shared/util.js': 'export default 1;\n',
    'b/shared/util.js': 'export default 2;\n',
  });
  assert.deepEqual(roadsFrom(scanProject(root).roads, 'src/main.js'), []);
});

test('roads cross languages, not just JavaScript', () => {
  const root = project({
    'index.html': '<link rel="stylesheet" href="site.css">\n',
    'site.css': "@import './theme.css';\n",
    'theme.css': ':root{}\n',
    // go.mod sits above the code it describes, so the module root is go/, not the
    // repo root — example.com/m/internal/store means go/internal/store.
    'go/go.mod': 'module example.com/m\n',
    'go/cmd/main.go': 'package main\nimport "example.com/m/internal/store"\n',
    'go/internal/store/store.go': 'package store\n',
  });
  const { roads } = scanProject(root);
  assert.deepEqual(roadsFrom(roads, 'index.html'), ['site.css']);
  assert.deepEqual(roadsFrom(roads, 'site.css'), ['theme.css']);
  assert.deepEqual(roadsFrom(roads, 'go/cmd/main.go'), ['go/internal/store/store.go']);
});

test('a comment mentioning an import does not create a road', () => {
  const root = project({
    'src/main.js': "// import ghost from './ghost.js';\n/* @import 'ghost' */\n",
    'src/ghost.js': 'export default 1;\n',
  });
  assert.deepEqual(roadsFrom(scanProject(root).roads, 'src/main.js'), []);
});

// Found during a dry run on a Vite-shaped repo: .tsx was missing from the html
// target list, so the page's only edge into the app never resolved.
test('an html script tag reaches a .tsx entry point', () => {
  const root = project({
    'index.html': '<script type="module" src="src/main.tsx"></script>\n<link rel="stylesheet" href="src/app.css">\n',
    'src/main.tsx': "import React from 'react';\n",
    'src/app.css': 'body{}\n',
  });
  assert.deepEqual(roadsFrom(scanProject(root).roads, 'index.html'), ['src/app.css', 'src/main.tsx']);
});

// Same dry run: when that path failed to resolve it was reported as an external
// package named `src`. Inventing a dependency is worse than missing one.
test('an unresolved path is not reported as an external package', () => {
  const root = project({
    'index.html': '<script src="src/missing.tsx"></script>\n',
    'src/present.tsx': 'export default 1;\n',
  });
  const { files } = scanProject(root);
  assert.deepEqual(files.find((f) => f.path === 'index.html').deps, []);
});

test('a real package is still reported even when it ends in a file extension', () => {
  const root = project({ 'src/main.js': "import 'bootstrap/dist/css/bootstrap.min.css';\n" });
  const { files } = scanProject(root);
  assert.deepEqual(files.find((f) => f.path === 'src/main.js').deps, ['bootstrap']);
});

test('a file never has a road to itself', () => {
  const root = project({ 'src/main.js': "import x from './main.js';\n" });
  assert.deepEqual(roadsFrom(scanProject(root).roads, 'src/main.js'), []);
});
