import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.svelte-kit', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'target', 'vendor', '.gradle', '.idea', '.vscode', '.codecity', '.turbo', '.cache',
]);

const CODE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rb', '.rs',
  '.java', '.kt', '.php', '.swift', '.c', '.h', '.cc', '.cpp', '.cs',
  '.vue', '.svelte', '.css', '.scss', '.html', '.sql', '.sh',
]);

const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte']);
const JS_RESOLVE = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js', '/index.tsx', '/index.jsx'];

const JS_IMPORT = /(?:import\s+[\s\S]*?from\s*|import\s*|require\(\s*|export\s+[\s\S]*?from\s*)['"]([^'"]+)['"]/g;
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;

function walk(root, dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, full, files);
    } else if (entry.isFile() && CODE_EXT.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
}

export function lineCount(absolute) {
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > 2_000_000) return 0;
    return fs.readFileSync(absolute, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}

function resolveJs(fromAbs, specifier, known) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromAbs), specifier);
  for (const suffix of JS_RESOLVE) {
    const candidate = base + suffix;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function resolvePy(fromAbs, specifier, known) {
  if (!specifier.startsWith('.')) return null;
  let up = 0;
  while (up < specifier.length && specifier[up] === '.') up += 1;
  let dir = path.dirname(fromAbs);
  for (let i = 1; i < up; i += 1) dir = path.dirname(dir);
  const tail = specifier.slice(up).split('.').join(path.sep);
  for (const suffix of ['.py', `${path.sep}__init__.py`]) {
    const candidate = path.join(dir, tail) + suffix;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

export function importsOf(absolute, known) {
  const ext = path.extname(absolute);
  let source;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    return [];
  }

  const targets = new Set();
  if (JS_EXT.has(ext)) {
    for (const match of source.matchAll(JS_IMPORT)) {
      const resolved = resolveJs(absolute, match[1], known);
      if (resolved && resolved !== absolute) targets.add(resolved);
    }
  } else if (ext === '.py') {
    for (const match of source.matchAll(PY_IMPORT)) {
      const resolved = resolvePy(absolute, match[1] || match[2], known);
      if (resolved && resolved !== absolute) targets.add(resolved);
    }
  }
  return [...targets];
}

// Roads are drawn from real imports, so spatial coupling in the city reflects
// actual coupling in the code.
export function scanProject(root, { maxFiles = 400 } = {}) {
  const found = [];
  walk(root, root, found);
  found.sort();

  const truncated = found.length > maxFiles;
  const selected = truncated ? found.slice(0, maxFiles) : found;
  const known = new Set(selected);

  const files = selected.map((absolute) => ({
    path: path.relative(root, absolute),
    dir: path.dirname(path.relative(root, absolute)),
    loc: lineCount(absolute),
  }));

  const roads = [];
  const seen = new Set();
  for (const absolute of selected) {
    for (const target of importsOf(absolute, known)) {
      const from = path.relative(root, absolute);
      const to = path.relative(root, target);
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roads.push({ from, to });
    }
  }

  return { files, roads, totalFound: found.length, truncated };
}
