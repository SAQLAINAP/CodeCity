import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.output', '.parcel-cache', '.turbo',
  '.cache', '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.tox', 'site-packages', 'target', 'vendor', '.gradle', '.idea', '.vscode',
  '.codecity', '.terraform', '.dart_tool', '.expo', 'Pods', 'DerivedData', 'Carthage',
  'elm-stuff', '.bundle', '.serverless', '.vercel', '.yarn', '.pnpm-store', 'obj',
]);

// Deliberately wide. A city that only knows web apps is not a city, it is a linter —
// a Terraform repo, a notebook, a docs site and a Unity project all have shape.
const EXT_LANG = new Map(Object.entries({
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js',
  '.mts': 'js', '.cts': 'js', '.vue': 'js', '.svelte': 'js', '.astro': 'js',
  '.py': 'py', '.pyi': 'py', '.ipynb': 'nb',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm', '.scala': 'jvm', '.groovy': 'jvm',
  '.cs': 'dotnet', '.fs': 'dotnet', '.vb': 'dotnet',
  '.rb': 'ruby', '.rake': 'ruby',
  '.php': 'php',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c',
  '.m': 'c', '.mm': 'c', '.cu': 'c',
  '.swift': 'swift',
  '.dart': 'dart',
  '.lua': 'lua',
  '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hrl': 'erlang',
  '.hs': 'haskell',
  '.ml': 'plain', '.mli': 'plain', '.clj': 'plain', '.cljs': 'plain', '.zig': 'plain',
  '.nim': 'plain', '.jl': 'plain', '.r': 'plain', '.R': 'plain', '.pl': 'plain',
  '.pm': 'plain', '.f90': 'plain', '.vim': 'plain', '.el': 'plain', '.asm': 'plain',
  '.sol': 'js', '.proto': 'proto',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css', '.styl': 'css',
  '.html': 'html', '.htm': 'html', '.hbs': 'html', '.ejs': 'html', '.twig': 'html',
  '.jinja': 'html', '.j2': 'html', '.erb': 'html', '.blade.php': 'html',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell', '.ps1': 'shell',
  '.tf': 'tf', '.tfvars': 'tf', '.hcl': 'tf',
  '.md': 'md', '.mdx': 'md', '.rst': 'md', '.adoc': 'md',
  '.sql': 'plain', '.graphql': 'plain', '.gql': 'plain',
  '.yml': 'plain', '.yaml': 'plain', '.toml': 'plain', '.json': 'plain', '.xml': 'plain',
  '.ini': 'plain', '.cfg': 'plain', '.env.example': 'plain',
  '.gradle': 'jvm', '.cmake': 'plain', '.mk': 'plain', '.bzl': 'plain',
  '.tsx.snap': 'plain', '.plist': 'plain', '.storyboard': 'plain', '.xib': 'plain',
  '.tscn': 'plain', '.gd': 'plain', '.unity': 'plain', '.shader': 'plain',
}));

// Build systems and container definitions carry no extension but are load-bearing.
const NAMED = new Map(Object.entries({
  Makefile: 'plain', Dockerfile: 'plain', Justfile: 'plain', Rakefile: 'ruby',
  Gemfile: 'ruby', Procfile: 'plain', Brewfile: 'plain', Vagrantfile: 'ruby',
  Jenkinsfile: 'jvm', CMakeLists: 'plain', BUILD: 'plain', WORKSPACE: 'plain',
}));

// A directory named by an import resolves to its front door rather than to all of it.
const DIR_ENTRY = ['index', '__init__', 'mod', 'lib', 'main', 'init', 'package'];

const bounded = '[\\s\\S]{0,400}?';

// An import written inside a comment is documentation, not a dependency. The `//`
// rule skips a slash pair preceded by a colon or quote so URLs survive intact.
const COMMENT_RULES = {
  c: [[/\/\*[\s\S]*?\*\//g, ''], [/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1']],
  hash: [[/(^|\s)#[^\n]*/g, '$1']],
  dash: [[/(^|\s)--[^\n]*/g, '$1']],
  html: [[/<!--[\s\S]*?-->/g, '']],
};

function stripComments(source, kinds) {
  let out = source;
  for (const kind of kinds ?? []) {
    for (const [rule, replacement] of COMMENT_RULES[kind]) out = out.replace(rule, replacement);
  }
  return out;
}

// A pattern is `{ re, split, map }`. `split` turns one match into several specifiers
// (Go's parenthesised import block); `map` turns one specifier into the candidate
// repo paths to try, in order. Both are per-pattern because the same language spells
// relative and absolute imports differently — `require_relative 'x'` is a sibling
// file, `require 'x'` is a gem, and conflating them is how false roads get drawn.
const here = (spec) => [`./${clean(spec)}`];
const hereOrAway = (spec) => [`./${clean(spec)}`, clean(spec)];
const quoted = (raw) => [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

const LANGS = {
  js: {
    comments: ['c'], targets: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'],
    patterns: [
      { re: new RegExp(`(?:import|export)${bounded}from\\s*['"]([^'"\\n]+)['"]`, 'g') },
      { re: /(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g },
      { re: /^\s*import\s*['"]([^'"\n]+)['"]/gm },
    ],
  },
  py: {
    comments: ['hash'], targets: ['.py', '.pyi'],
    patterns: [{ re: /^[ \t]*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm, map: pythonPaths }],
  },
  nb: {
    comments: ['hash'], targets: ['.py', '.ipynb'],
    patterns: [{ re: /(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/g, map: pythonPaths }],
  },
  go: {
    comments: ['c'], targets: ['.go'],
    patterns: [
      { re: /import\s+\(([\s\S]{0,4000}?)\)/g, split: quoted },
      { re: /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm },
    ],
  },
  rust: {
    comments: ['c'], targets: ['.rs'],
    patterns: [
      { re: /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm, map: (spec) => [`./${spec}`, `./${spec}/mod`], local: true },
      // `crate::`/`self::`/`super::` name this crate, so a miss is a miss, not a package.
      { re: /\buse\s+((?:crate|self|super)(?:::[\w*{}]+)+)/g, map: rustPaths, local: true },
      { re: /\buse\s+(?!crate::|self::|super::)([a-z_]\w*(?:::[\w*{}]+)+)/g, map: rustPaths },
    ],
  },
  jvm: {
    comments: ['c'], targets: ['.java', '.kt', '.kts', '.scala', '.groovy', '.gradle'],
    patterns: [{ re: /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/gm, map: dottedPaths }],
  },
  dotnet: {
    comments: ['c'], targets: ['.cs', '.fs', '.vb'],
    patterns: [{ re: /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm, map: dottedPaths }],
  },
  ruby: {
    comments: ['hash'], targets: ['.rb', '.rake'],
    patterns: [
      { re: /\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g, map: here },
      { re: /\b(?:require|load)\s*\(?\s*['"]([^'"]+)['"]/g },
    ],
  },
  php: {
    comments: ['c', 'hash'], targets: ['.php'],
    patterns: [
      { re: /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g, map: hereOrAway },
      { re: /^\s*use\s+([\w\\]+)/gm },
    ],
  },
  c: {
    comments: ['c'], targets: ['.h', '.hpp', '.hh', '.c', '.cc', '.cpp', '.cxx', '.m', '.mm', '.cu'],
    patterns: [
      { re: /^\s*#\s*(?:include|import)\s*"([^"]+)"/gm, map: hereOrAway },
      { re: /^\s*#\s*(?:include|import)\s*<([^>]+)>/gm },
    ],
  },
  swift: { comments: ['c'], targets: ['.swift'], patterns: [{ re: /^\s*import\s+(\w+)/gm }] },
  dart: {
    comments: ['c'], targets: ['.dart'],
    patterns: [{ re: /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm, map: (spec) => [clean(spec.replace(/^package:/, ''))] }],
  },
  lua: { comments: ['dash'], targets: ['.lua'], patterns: [{ re: /\brequire\s*\(?\s*['"]([^'"]+)['"]/g, map: dottedPaths }] },
  elixir: { comments: ['hash'], targets: ['.ex', '.exs'], patterns: [{ re: /^\s*(?:import|alias|use)\s+([\w.]+)/gm, map: dottedPaths }] },
  erlang: { namespaced: false, targets: ['.erl', '.hrl'], patterns: [{ re: /-include(?:_lib)?\(\s*"([^"]+)"/g, map: hereOrAway }] },
  haskell: { comments: ['dash'], targets: ['.hs'], patterns: [{ re: /^import\s+(?:qualified\s+)?([\w.]+)/gm, map: dottedPaths }] },
  proto: { comments: ['c'], targets: ['.proto'], patterns: [{ re: /^\s*import\s+(?:public\s+)?"([^"]+)"/gm, map: hereOrAway }] },
  css: {
    namespaced: false, comments: ['c'], targets: ['.css', '.scss', '.sass', '.less', '.styl'],
    patterns: [
      { re: /@(?:import|use|forward)\s+(?:\([^)]*\)\s*)?['"]([^'"]+)['"]/g, map: partialPaths },
      { re: /\burl\(\s*['"]?([^'")]+)/g, map: hereOrAway },
    ],
  },
  html: {
    namespaced: false, comments: ['html'], targets: ['.js', '.mjs', '.ts', '.css', '.scss', '.html', '.htm'],
    patterns: [
      { re: /\b(?:src|href|data-src)\s*=\s*['"]([^'"]+)['"]/g },
      { re: /\b(?:include|extends)\s+['"]([^'"]+)['"]/g, map: hereOrAway },
    ],
  },
  shell: {
    namespaced: false, comments: ['hash'], targets: ['.sh', '.bash', '.zsh', '.ps1'],
    patterns: [{ re: /^\s*(?:\.|source)\s+["']?([^"'\s;]+)/gm, map: hereOrAway }],
  },
  tf: {
    namespaced: false, comments: ['c', 'hash'], targets: ['.tf'],
    patterns: [{ re: /source\s*=\s*"([^"]+)"/g }],
  },
  md: {
    namespaced: false, targets: null,
    patterns: [
      { re: /\]\(([^)\s#]+\.[a-z0-9]{1,6})\)/gi, map: hereOrAway },
      { re: /^\s*(?:\.\.\s+include|include)::\s*(\S+)/gm, map: hereOrAway },
    ],
  },
  plain: { targets: null, patterns: [] },
};

function slash(value) {
  return value.replace(/\\/g, '/');
}

function clean(spec) {
  return slash(spec).trim().split(/[?#]/)[0].replace(/\/+$/, '').replace(/^\/+/, '');
}

function dottedPaths(spec) {
  const parts = spec.replace(/\.\*$/, '').split('.').filter(Boolean);
  if (parts.length === 0) return [];
  // `com.example.svc.Client` may name a file or a class inside one, so offer both.
  return parts.length > 1 ? [parts.join('/'), parts.slice(0, -1).join('/')] : [parts[0]];
}

function pythonPaths(spec) {
  let up = 0;
  while (up < spec.length && spec[up] === '.') up += 1;
  const tail = spec.slice(up).split('.').filter(Boolean).join('/');
  if (up === 0) return tail ? [tail] : [];
  const prefix = `${'../'.repeat(Math.max(0, up - 1))}./`;
  return tail ? [prefix + tail] : [prefix];
}

// `self::` and `super::` are directory-relative; `crate::` is relative to the crate
// root, which we approximate with a plain repo-path lookup.
function rustPaths(spec) {
  const parts = spec.split('::').filter((part) => part && !part.includes('{') && part !== '*');
  const scope = ['crate', 'self', 'super'].includes(parts[0]) ? parts[0] : null;
  const rest = scope ? parts.slice(1) : parts;
  if (rest.length === 0) return [];
  const prefix = scope === 'super' ? '../' : scope === 'self' ? './' : '';
  // The last segment is as likely to be a type inside the module as the module.
  const trails = rest.length > 1 ? [rest.join('/'), rest.slice(0, -1).join('/')] : [rest[0]];
  return trails.map((trail) => prefix + trail);
}

// `@import 'buttons'` in Sass means the sibling file `_buttons.scss`.
function partialPaths(spec) {
  const value = clean(spec);
  const at = value.lastIndexOf('/');
  const dir = at === -1 ? '' : `${value.slice(0, at)}/`;
  const base = value.slice(at + 1);
  const forms = base.startsWith('_') ? [value] : [value, `${dir}_${base}`];
  return [...forms.map((form) => `./${form}`), ...forms];
}

function langOf(absolute) {
  const base = path.basename(absolute);
  const ext = path.extname(base);
  return EXT_LANG.get(ext) ?? NAMED.get(base) ?? NAMED.get(base.split('.')[0]) ?? null;
}

function walk(dir, out, depth = 0) {
  if (depth > 24) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      walk(full, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(full);
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

/* ---------- manifests: how a bare specifier becomes a path in this repo ---------- */

function readJsonish(absolute) {
  try {
    // tsconfig.json is JSON with comments and trailing commas in practice.
    const raw = stripComments(fs.readFileSync(absolute, 'utf8'), ['c']).replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readText(absolute) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return '';
  }
}

// A monorepo's `@acme/core` is not an external package — it is a building two
// directories away, and drawing no road there is the single biggest thing the old
// relative-only resolver got wrong.
function readManifests(root, dirs) {
  const rewrites = [];
  const addRewrite = (prefix, target) => {
    if (prefix) rewrites.push({ prefix: clean(prefix), target: clean(target) });
  };

  for (const dir of dirs) {
    const rel = slash(path.relative(root, dir));
    const at = (name) => path.join(dir, name);
    const under = (sub) => (rel ? `${rel}/${sub}` : sub).replace(/\/$/, '');

    const pkg = fs.existsSync(at('package.json')) ? readJsonish(at('package.json')) : null;
    if (pkg?.name) addRewrite(pkg.name, under(''));

    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const config = fs.existsSync(at(name)) ? readJsonish(at(name)) : null;
      const options = config?.compilerOptions;
      if (!options) continue;
      const baseUrl = under(clean(options.baseUrl ?? '.'));
      for (const [pattern, list] of Object.entries(options.paths ?? {})) {
        for (const target of list) {
          addRewrite(pattern.replace(/\*$/, ''), `${baseUrl}/${clean(target).replace(/\*$/, '')}`);
        }
      }
      if (options.baseUrl) addRewrite('', baseUrl);
    }

    if (fs.existsSync(at('go.mod'))) {
      const module = /^module\s+(\S+)/m.exec(readText(at('go.mod')));
      if (module) addRewrite(module[1], under(''));
    }

    for (const name of ['pyproject.toml', 'Cargo.toml']) {
      if (!fs.existsSync(at(name))) continue;
      const found = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readText(at(name)));
      if (found) addRewrite(found[1].replace(/-/g, '_'), under(''));
    }

    const composer = fs.existsSync(at('composer.json')) ? readJsonish(at('composer.json')) : null;
    for (const [space, target] of Object.entries(composer?.autoload?.['psr-4'] ?? {})) {
      addRewrite(space.replace(/\\/g, '/'), under(clean(Array.isArray(target) ? target[0] : target)));
    }
  }

  // Longest prefix first, so `@acme/core/utils` never matches a bare `@acme` rule.
  rewrites.sort((a, b) => b.prefix.length - a.prefix.length);
  return { rewrites };
}

/* ---------- the index ---------- */

function addAlias(map, alias, value) {
  if (!alias) return;
  const list = map.get(alias);
  if (!list) map.set(alias, [value]);
  else if (!list.includes(value)) list.push(value);
}

function suffixes(relative) {
  const parts = relative.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(i).join('/'));
  return out;
}

export function indexFile(index, absolute) {
  const rel = slash(path.relative(index.root, absolute));
  // Outside the root it is not part of the city, and indexing it would let a road
  // point at `../../tmp/foo.ts`.
  if (rel.startsWith('..') || index.files.has(absolute)) return;
  index.files.add(absolute);

  const dir = path.posix.dirname(rel);
  if (!index.dirFiles.has(dir) && dir !== '.') {
    for (const alias of suffixes(dir)) addAlias(index.byDir, alias, dir);
  }
  addAlias(index.dirFiles, dir, absolute);

  const bare = rel.replace(/\.[^./]+$/, '');
  for (const alias of suffixes(rel)) addAlias(index.byPath, alias, absolute);
  for (const alias of suffixes(bare)) addAlias(index.byPath, alias, absolute);

  const base = path.posix.basename(bare);
  if (DIR_ENTRY.includes(base) && dir !== '.') {
    for (const alias of suffixes(dir)) addAlias(index.byPath, alias, absolute);
  }
}

export function buildIndex(root, absoluteFiles) {
  // Every ancestor, not just the directories holding code: `go.mod` and `package.json`
  // routinely sit one level above the source they describe.
  const dirs = new Set([root]);
  for (const absolute of absoluteFiles) {
    let dir = path.dirname(absolute);
    while (dir.startsWith(root) && dir.length > root.length && !dirs.has(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }

  const index = {
    root,
    files: new Set(),
    byPath: new Map(),
    byDir: new Map(),
    dirFiles: new Map(),
    ...readManifests(root, dirs),
  };
  for (const absolute of absoluteFiles) indexFile(index, absolute);
  return index;
}

const stem = (absolute) => path.basename(absolute).replace(/\.[^.]+$/, '');

// A name that only matches files of another language is not a match — Go's `fmt` is
// the standard library, not somebody's fmt.ts. And a wrong road is worse than a
// missing one in a tool whose whole job is to be trusted, so ties resolve to nothing.
function pick(candidates, targets, from) {
  if (!candidates || candidates.length === 0) return null;
  const pool = candidates.filter((abs) => abs !== from
    && (!targets || targets.includes(path.extname(abs))));
  return pool.length === 1 ? pool[0] : null;
}

// Go, Java and Rust import a package directory rather than a file. The road goes to
// the file that shares the directory's name, else to a conventional entry point.
function pickInDir(index, relDir, targets, from) {
  const list = index.dirFiles.get(relDir);
  if (!list) return null;
  const pool = list.filter((abs) => abs !== from && (!targets || targets.includes(path.extname(abs))));
  if (pool.length <= 1) return pool[0] ?? null;
  const named = path.posix.basename(relDir);
  return pool.find((abs) => stem(abs) === named)
    ?? pool.find((abs) => DIR_ENTRY.includes(stem(abs)))
    ?? null;
}

function matchFile(index, baseAbs, targets, from) {
  if (index.files.has(baseAbs) && baseAbs !== from) return baseAbs;
  const exts = targets ?? [];
  for (const ext of exts) {
    if (index.files.has(baseAbs + ext) && baseAbs + ext !== from) return baseAbs + ext;
  }
  // `src` and `lib` because a workspace package is almost never flat.
  for (const nest of ['', 'src', 'lib']) {
    for (const entry of DIR_ENTRY) {
      for (const ext of exts) {
        const candidate = path.join(baseAbs, nest, entry + ext);
        if (index.files.has(candidate) && candidate !== from) return candidate;
      }
    }
  }
  const rel = slash(path.relative(index.root, baseAbs)) || '.';
  return rel.startsWith('..') ? null : pickInDir(index, rel, targets, from);
}

function resolve(index, spec, from, { targets, namespaced }) {
  const value = clean(spec);
  if (!value || value.startsWith('http:') || value.startsWith('https:') || value.startsWith('data:')) return null;

  if (value.startsWith('.')) {
    return matchFile(index, path.resolve(path.dirname(from), value), targets, from);
  }

  for (const rule of index.rewrites) {
    if (rule.prefix && value !== rule.prefix && !value.startsWith(`${rule.prefix}/`)) continue;
    const tail = rule.prefix ? value.slice(rule.prefix.length).replace(/^\//, '') : value;
    const hit = matchFile(index, path.resolve(index.root, rule.target, tail), targets, from);
    if (hit) return hit;
  }

  // In a language with a module namespace, a one-word bare specifier is a standard
  // library or a package: `import "log"` is Go's logger, `import logging` is Python's.
  // Matching those against a same-named file anywhere in the repo is the single
  // easiest way to draw a confidently wrong road, so they are refused. HTML, CSS and
  // shell have no such namespace — there `/style.css` is simply a path.
  if (namespaced !== false && !value.includes('/')) return null;

  const rooted = matchFile(index, path.resolve(index.root, value), targets, from);
  if (rooted) return rooted;

  const bySuffix = pick(index.byPath.get(value), targets, from);
  if (bySuffix) return bySuffix;

  const dirs = index.byDir.get(value);
  if (dirs && dirs.length === 1) return pick(index.dirFiles.get(dirs[0]), targets, from);
  return null;
}

function packageName(value) {
  const parts = clean(value).split('/');
  if (parts[0].startsWith('@')) return parts.slice(0, 2).join('/');
  // `github.com/spf13/cobra` is one package; `os/exec` is the `os` package.
  if (parts[0].includes('.') && parts.length >= 3) return parts.slice(0, 3).join('/');
  return parts[0];
}

export function importsOf(absolute, index) {
  const lang = LANGS[langOf(absolute)];
  if (!lang || lang.patterns.length === 0) return { targets: [], deps: [] };

  let source;
  try {
    if (fs.statSync(absolute).size > 2_000_000) return { targets: [], deps: [] };
    source = stripComments(fs.readFileSync(absolute, 'utf8'), lang.comments);
  } catch {
    return { targets: [], deps: [] };
  }

  const found = [];
  for (const { re, split, map, local } of lang.patterns) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const captured = match.slice(1).find(Boolean);
      if (!captured) continue;
      for (const spec of split ? split(captured) : [captured]) {
        found.push({ spec, local, candidates: map ? map(spec) : [clean(spec)] });
      }
    }
  }

  const rule = { targets: lang.targets, namespaced: lang.namespaced };
  const targets = new Set();
  const deps = new Set();
  for (const { spec, local, candidates } of found) {
    let hit = null;
    for (const candidate of candidates) {
      hit = resolve(index, candidate, absolute, rule);
      if (hit) break;
    }
    if (hit) {
      targets.add(hit);
      continue;
    }
    // Unresolved and not a path into this repo means it lives outside the city.
    const away = candidates.filter((candidate) => !candidate.startsWith('.'));
    if (local || away.length === 0 || slash(spec).startsWith('/')) continue;
    const name = packageName(away[0]);
    if (name && !name.includes('*')) deps.add(name);
  }
  return { targets: [...targets], deps: [...deps] };
}

/* ---------- scan ---------- */

// Truncation was alphabetical, which amputated every directory late in the alphabet.
// Ranking individual files by size is worse: the survivors land one per directory and
// every road goes with them. So the unit of truncation is the directory — whole
// districts, biggest first, until the budget runs out. A city with missing
// neighbourhoods still reads as a city; a city of scattered single houses does not.
function selectFiles(found, maxFiles) {
  const loc = new Map();
  for (const absolute of found) loc.set(absolute, lineCount(absolute));
  if (found.length <= maxFiles) return { selected: found, loc };

  const byDir = new Map();
  for (const absolute of found) {
    const dir = path.dirname(absolute);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(absolute);
  }

  const districts = [...byDir.values()]
    .map((list) => ({ list, loc: list.reduce((sum, a) => sum + loc.get(a), 0) }))
    .sort((a, b) => b.loc - a.loc);

  const kept = [];
  for (const district of districts) {
    const room = maxFiles - kept.length;
    if (room <= 0) break;
    const list = district.list.length <= room
      ? district.list
      : [...district.list].sort((a, b) => loc.get(b) - loc.get(a)).slice(0, room);
    kept.push(...list);
  }
  return { selected: kept.sort(), loc };
}

export function scanProject(root, { maxFiles = 400 } = {}) {
  const all = [];
  walk(root, all);
  const found = all.filter((absolute) => langOf(absolute) !== null).sort();

  const truncated = found.length > maxFiles;
  const { selected, loc } = selectFiles(found, maxFiles);
  const index = buildIndex(root, selected);

  const files = [];
  const roads = [];
  const seen = new Set();
  for (const absolute of selected) {
    const rel = slash(path.relative(root, absolute));
    const { targets, deps } = importsOf(absolute, index);
    files.push({
      path: rel,
      dir: path.posix.dirname(rel),
      loc: loc.get(absolute) ?? lineCount(absolute),
      deps,
    });
    for (const target of targets) {
      const to = slash(path.relative(root, target));
      const alias = `${rel}\u0000${to}`;
      if (seen.has(alias)) continue;
      seen.add(alias);
      roads.push({ from: rel, to });
    }
  }

  return { files, roads, index, totalFound: found.length, truncated };
}
