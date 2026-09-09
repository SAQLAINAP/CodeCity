const TILE_W = 40;
const TILE_H = 22;
const FOOTPRINT = 0.62;
const PAD = 1;
const GAP = 1;
const TERRACE = 5;        // px a district platform rises above its parent
const LINES_PER_FLOOR = 30;

// A read keeps a file "in context" for five minutes; after that the agent is
// acting on memory, which is exactly the moment a human should look.
const CONTEXT_MS = 300_000;
const GLYPH_MS = 14_000;
const LIVE_MS = 60_000;

// The chrome is deliberately monochrome. Colour in this tool means exactly one
// thing — agent attention — so no interface element is allowed to spend any.
const INK = '#c9d2db';
const DIM = '#69737e';
const ACCENT = '#f2f6f9';
const GRID = '#161b21';
const PLATE_TONES = ['#0d1014', '#11151a', '#151a20', '#1a2027', '#1f262e'];
const PLATE_LINE = '#232b34';

const STATES = {
  unseen: { color: '#39414b', label: 'untouched' },
  context: { color: '#3fb27a', label: 'read · in context' },
  stale: { color: '#d1462f', label: 'read · context cooled' },
  changed: { color: '#e0952b', label: 'changed by the agent' },
  new: { color: '#4d8fd6', label: 'new ground' },
  passed: { color: '#4d5661', label: 'seen in passing' },
};

const TOOL_LABELS = {
  construct: 'written from scratch',
  renovate: 'edited in place',
  survey: 'read',
  inspect: 'inspected',
  crew: 'crew on site',
  extract: 'extraction',
  deliver: 'delivery',
};

const RISK_LABELS = {
  unreviewed: 'written twice with no read between',
  burst: 'touched repeatedly in a short window',
};

const canvas = document.getElementById('city');
const ctx = canvas.getContext('2d');

const city = { buildings: new Map(), roads: [], root: '', truncated: false, totalFound: 0 };
const camera = { x: 0, y: 0, scale: 1 };
const drag = { active: false, x: 0, y: 0, moved: false };

let placements = new Map();
let districts = [];
let bounds = null;
let walkOrder = [];
let importsOut = new Map();
let importsIn = new Map();
let silhouettes = [];
let hovered = null;
let selected = null;
let dirFocus = null;
let needsDraw = true;

/* ---------- layout ---------- */

// The directory tree is the city's street plan: src/api/routes is a block inside a
// district inside a borough, and each level sits on its own raised platform. A flat
// list of directories can't show you that src/api and src/api/routes are related.
function treeOf(buildings) {
  const root = { name: '', dir: '', children: new Map(), files: [] };
  for (const building of buildings) {
    let node = root;
    for (const part of building.dir ? building.dir.split('/') : []) {
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          dir: node.dir ? `${node.dir}/${part}` : part,
          children: new Map(),
          files: [],
        });
      }
      node = node.children.get(part);
    }
    node.files.push(building);
  }
  return root;
}

// Bottom-up: work out how many cells each district needs before anyone is placed.
function measure(node) {
  node.files.sort((a, b) => a.path.localeCompare(b.path));
  const blocks = [];

  // A directory's own files sit at its heart, with sub-districts packed around them.
  if (node.files.length) {
    const cols = Math.ceil(Math.sqrt(node.files.length));
    blocks.push({ files: node.files, w: cols, h: Math.ceil(node.files.length / cols) });
  }
  for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const size = measure(child);
    blocks.push({ node: child, w: size.w, h: size.h });
  }

  // One guessed shelf width leaves whole blank quarters when a district's children
  // are lopsided. Trying every width and keeping the tightest, squarest result is
  // cheap here and it's the difference between a city and a scatter plot.
  const widths = blocks.map((block) => block.w);
  const low = Math.max(...widths);
  const high = widths.reduce((sum, w) => sum + w + GAP, 0);
  const step = Math.max(1, Math.ceil((high - low) / 48));

  let best = null;
  for (let limit = low; limit <= high; limit += step) {
    // Smallest area alone always picks a one-block-wide ribbon, because a narrow
    // shelf wastes nothing. The squared aspect term is what buys back the city.
    const trial = shelve(blocks, limit);
    const score = trial.w * trial.h + ((trial.w - trial.h) ** 2) / 2;
    if (!best || score < best.score) best = { ...trial, score };
  }

  blocks.forEach((block, index) => {
    block.ox = best.at[index].ox;
    block.oy = best.at[index].oy;
  });

  node.blocks = blocks;
  node.inner = { w: best.w, h: best.h };
  return { w: best.w + PAD * 2, h: best.h + PAD * 2 };
}

function shelve(blocks, limit) {
  const at = [];
  let cx = 0;
  let cy = 0;
  let shelf = 0;
  let widest = 0;
  for (const block of blocks) {
    if (cx > 0 && cx + block.w > limit) {
      cx = 0;
      cy += shelf + GAP;
      shelf = 0;
    }
    at.push({ ox: cx, oy: cy });
    cx += block.w + GAP;
    shelf = Math.max(shelf, block.h);
    widest = Math.max(widest, cx - GAP);
  }
  return { at, w: widest, h: cy + shelf };
}

function place(node, ox, oy, depth, out) {
  out.zones.push({
    dir: node.dir,
    name: node.name,
    depth,
    x: ox,
    y: oy,
    cols: node.inner.w + PAD * 2,
    rows: node.inner.h + PAD * 2,
  });
  for (const block of node.blocks) {
    const bx = ox + PAD + block.ox;
    const by = oy + PAD + block.oy;
    if (block.files) {
      block.files.forEach((building, index) => {
        out.placements.set(building.path, {
          gx: bx + (index % block.w),
          gy: by + Math.floor(index / block.w),
          depth,
        });
        out.walk.push(building.path);
      });
    } else {
      place(block.node, bx, by, depth + 1, out);
    }
  }
}

function layout() {
  const tree = treeOf([...city.buildings.values()]);
  const size = measure(tree);
  const out = { placements: new Map(), zones: [], walk: [] };
  place(tree, 0, 0, 0, out);

  placements = out.placements;
  districts = out.zones;
  walkOrder = out.walk;
  bounds = { x0: -0.5, y0: -0.5, x1: size.w - 0.5, y1: size.h - 0.5 };
}

const liftOf = (depth) => depth * TERRACE * camera.scale;

// Focusing a parent lights its whole borough, not just its loose files.
function inFocus(dir) {
  if (dirFocus === null) return true;
  if (dirFocus === '') return true;
  return dir === dirFocus || dir.startsWith(`${dirFocus}/`);
}

function indexRoads() {
  importsOut = new Map();
  importsIn = new Map();
  for (const road of city.roads) {
    if (!importsOut.has(road.from)) importsOut.set(road.from, []);
    importsOut.get(road.from).push(road.to);
    if (!importsIn.has(road.to)) importsIn.set(road.to, []);
    importsIn.get(road.to).push(road.from);
  }
}

/* ---------- camera ---------- */

// Measured rather than hardcoded: the chrome widths live in CSS, and a second copy
// here would silently disagree the moment a breakpoint changes.
function inset() {
  const width = (id) => {
    const element = document.getElementById(id);
    return element.offsetParent === null ? 0 : element.getBoundingClientRect().width;
  };
  return { left: width('sidebar'), right: width('panel'), top: 32, bottom: 26 };
}

function project(gx, gy) {
  return {
    x: (gx - gy) * (TILE_W / 2) * camera.scale + camera.x,
    y: (gx + gy) * (TILE_H / 2) * camera.scale + camera.y,
  };
}

function fitToView() {
  if (!bounds || placements.size === 0) return;
  const pad = inset();
  const viewW = canvas.clientWidth - pad.left - pad.right;
  const viewH = canvas.clientHeight - pad.top - pad.bottom;

  const corners = [
    [bounds.x0, bounds.y0], [bounds.x1, bounds.y0],
    [bounds.x1, bounds.y1], [bounds.x0, bounds.y1],
  ].map(([gx, gy]) => [(gx - gy) * (TILE_W / 2), (gx + gy) * (TILE_H / 2)]);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  camera.scale = Math.min(2.2, Math.max(0.16, Math.min(
    viewW / (maxX - minX + TILE_W * 2),
    viewH / (maxY - minY + TILE_H * 4),
  )));
  camera.x = pad.left + viewW / 2 - ((minX + maxX) / 2) * camera.scale;
  camera.y = pad.top + viewH / 2 - ((minY + maxY) / 2) * camera.scale;
}

function focusDistrict(dir) {
  const zone = districts.find((item) => item.dir === dir);
  if (!zone) return;
  const pad = inset();
  const centre = project(zone.x + zone.cols / 2 - 0.5, zone.y + zone.rows / 2 - 0.5);
  camera.x += pad.left + (canvas.clientWidth - pad.left - pad.right) / 2 - centre.x;
  camera.y += pad.top + (canvas.clientHeight - pad.top - pad.bottom) / 2 - centre.y;
  needsDraw = true;
}

/* ---------- state model: fill answers "should I look at this?" ---------- */

function stateOf(building, now) {
  if (building.created) return { key: 'new', color: STATES.new.color };
  if (building.lastWrite) return { key: 'changed', color: STATES.changed.color };
  if (building.lastRead) {
    const cooled = Math.min(1, (now - building.lastRead) / CONTEXT_MS);
    return { key: cooled >= 1 ? 'stale' : 'context', color: cool(cooled), cooled };
  }
  if (building.lastTs) return { key: 'passed', color: STATES.passed.color };
  return { key: 'unseen', color: STATES.unseen.color };
}

// Green straight to red passes through brown, which is indistinguishable from the
// amber "changed" state. Draining to grey first keeps the two channels separate.
function cool(t) {
  return t < 0.5
    ? mix(STATES.context.color, STATES.passed.color, t * 2)
    : mix(STATES.passed.color, STATES.stale.color, (t - 0.5) * 2);
}

function mix(from, to, amount) {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const channel = (shift) => {
    const x = (a >> shift) & 255;
    const y = (b >> shift) & 255;
    return Math.round(x + (y - x) * amount);
  };
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
}

function shade(color, factor) {
  const [r, g, b] = color.startsWith('#')
    ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    : color.slice(4, -1).split(',').map(Number);
  return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
}

/* ---------- drawing ---------- */

// Height is line count. Square-rooted, because linear scaling lets one 4000-line
// file hide a whole district behind it while every 40-line file flattens to nothing.
// A 30-line file is a shack, 300 lines is a mid-rise, 3000 lines is a tower.
function heightOf(building) {
  return (4 + Math.sqrt(Math.min(building.loc, 4000)) * 2.4) * camera.scale;
}

const floorsOf = (loc) => Math.max(1, Math.min(32, Math.round(loc / LINES_PER_FLOOR)));

function drawGrid() {
  if (!bounds || camera.scale < 0.22) return;
  ctx.save();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 3]);
  ctx.beginPath();
  for (let gx = Math.floor(bounds.x0); gx <= Math.ceil(bounds.x1) + 1; gx += 1) {
    const a = project(gx - 0.5, bounds.y0);
    const b = project(gx - 0.5, bounds.y1 + 1);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (let gy = Math.floor(bounds.y0); gy <= Math.ceil(bounds.y1) + 1; gy += 1) {
    const a = project(bounds.x0, gy - 0.5);
    const b = project(bounds.x1 + 1, gy - 0.5);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

// Corners run north, east, south, west — so corners[2] is always the lowest point
// on screen, which is where a district's name can sit without hitting anything.
function plateCorners(zone) {
  const lift = liftOf(zone.depth);
  return [
    project(zone.x - 0.5, zone.y - 0.5),
    project(zone.x + zone.cols - 0.5, zone.y - 0.5),
    project(zone.x + zone.cols - 0.5, zone.y + zone.rows - 0.5),
    project(zone.x - 0.5, zone.y + zone.rows - 0.5),
  ].map(({ x, y }) => ({ x, y: y - lift }));
}

// Each nesting level is a terrace standing proud of its parent, so depth in the
// directory tree is visible as elevation before you read a single label.
function drawDistrictPlates() {
  const thickness = TERRACE * camera.scale;
  for (const zone of [...districts].sort((a, b) => a.depth - b.depth)) {
    const c = plateCorners(zone);
    const tone = PLATE_TONES[Math.min(zone.depth, PLATE_TONES.length - 1)];
    const lit = dirFocus !== null && inFocus(zone.dir);

    ctx.fillStyle = shade(tone, 0.6);
    for (const [a, b] of [[c[3], c[2]], [c[2], c[1]]]) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y + thickness);
      ctx.lineTo(a.x, a.y + thickness);
      ctx.closePath();
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (const corner of c.slice(1)) ctx.lineTo(corner.x, corner.y);
    ctx.closePath();
    ctx.fillStyle = tone;
    ctx.fill();
    ctx.strokeStyle = lit ? ACCENT : PLATE_LINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Plates tile against each other, so a bare district name always lands on a
// neighbour. The chip is what makes it readable.
function drawDistrictLabels() {
  if (camera.scale < 0.45) return;
  const size = Math.round(9 * Math.min(camera.scale, 1.1));
  ctx.font = `${size}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  for (const zone of districts) {
    const focused = dirFocus === zone.dir;
    if (!inFocus(zone.dir)) continue;
    // Sub-districts only earn a name once you're close enough that they aren't noise.
    if (!focused && zone.depth > 1 && camera.scale < 0.85) continue;
    // South corner: the lowest point of the plate, so the name clears its own blocks.
    const corner = plateCorners(zone)[2];
    // The leaf name, not the full path — the nesting is already drawn as elevation.
    const text = (zone.name || city.root.split('/').pop() || 'root').toUpperCase();
    const width = ctx.measureText(text).width + 8;
    ctx.fillStyle = '#0a0b0de6';
    ctx.fillRect(corner.x - width / 2, corner.y + 2, width, size + 5);
    ctx.fillStyle = focused ? ACCENT : zone.depth === 0 ? INK : DIM;
    ctx.fillText(text, corner.x, corner.y + size + 4);
  }
}

function drawRoads(now) {
  ctx.lineWidth = 1;
  for (const road of city.roads) {
    const from = placements.get(road.from);
    const to = placements.get(road.to);
    if (!from || !to) continue;
    const a = project(from.gx, from.gy);
    const b = project(to.gx, to.gy);
    a.y -= liftOf(from.depth);
    b.y -= liftOf(to.depth);
    const linked = selected && (road.from === selected.path || road.to === selected.path);
    const hot = [road.from, road.to].some((key) => {
      const building = city.buildings.get(key);
      return building?.lastTs && now - building.lastTs <= GLYPH_MS;
    });
    ctx.save();
    if (!linked) ctx.setLineDash([2, 3]);
    ctx.strokeStyle = linked ? ACCENT : hot ? '#4a5049' : '#2c322e';
    // Blast radius is the reason roads exist, so the selected file's edges get to
    // shout while the other two hundred stay hairlines.
    ctx.lineWidth = linked ? 1.75 : 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
}

function silhouetteOf(px, py, hw, hh, h) {
  return [
    [px - hw, py - h], [px, py - hh - h], [px + hw, py - h],
    [px + hw, py], [px, py + hh], [px - hw, py],
  ];
}

function drawBlock(building, now) {
  const place = placements.get(building.path);
  if (!place) return;
  const projected = project(place.gx, place.gy);
  const px = projected.x;
  const py = projected.y - liftOf(place.depth);
  const hw = (TILE_W / 2) * FOOTPRINT * camera.scale;
  const hh = (TILE_H / 2) * FOOTPRINT * camera.scale;
  const h = heightOf(building);
  const state = stateOf(building, now);
  const focus = building === hovered || building === selected;
  const dimmed = !inFocus(building.dir);

  ctx.save();
  if (dimmed) ctx.globalAlpha = 0.18;

  const left = [[px - hw, py], [px, py + hh], [px, py + hh - h], [px - hw, py - h]];
  const right = [[px + hw, py], [px, py + hh], [px, py + hh - h], [px + hw, py - h]];
  const top = [[px - hw, py - h], [px, py - hh - h], [px + hw, py - h], [px, py + hh - h]];

  // Every file is a solid volume, touched or not. A codebase you can only see the
  // touched parts of hides the thing you most want to know: how much is left.
  ctx.fillStyle = shade(state.color, 0.44);
  trace(left);
  ctx.fill();
  ctx.fillStyle = shade(state.color, 0.66);
  trace(right);
  ctx.fill();

  drawFloors(building, px, py, hw, hh, h, state);

  ctx.fillStyle = state.color;
  trace(top);
  ctx.fill();
  // A lit parapet on the roofline is what separates a building from a coloured box.
  ctx.strokeStyle = mix(state.color, '#ffffff', 0.22);
  ctx.lineWidth = 1;
  ctx.stroke();

  if (building.risk) {
    drawHatch(px, py, hw, hh, h);
    ctx.strokeStyle = STATES.stale.color;
    ctx.lineWidth = 1;
    trace(silhouetteOf(px, py, hw, hh, h));
    ctx.stroke();
  }

  if (focus) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.25;
    trace(silhouetteOf(px, py, hw, hh, h).map(([x, y]) => [x, y]));
    ctx.stroke();
  }

  const fresh = building.lastTs && now - building.lastTs <= GLYPH_MS;
  if (building.action && (fresh || focus)) {
    drawAnnotation(building, px, py - hh - h, fresh, camera.scale);
  }

  ctx.restore();
  silhouettes.push({ building, polygon: silhouetteOf(px, py, hw, hh, h) });
}

function trace(points) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
}

// Storeys, one per thirty lines. Height alone is a bar chart you have to eyeball;
// bands give it a unit, so two neighbours can be compared by counting rather than
// squinting. Dropped entirely once they'd render closer together than they'd read.
function drawFloors(building, px, py, hw, hh, h, state) {
  const floors = floorsOf(building.loc);
  const band = h / floors;
  if (band < 3) return;
  ctx.save();
  ctx.strokeStyle = shade(state.color, 0.26);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < floors; i += 1) {
    const fy = band * i;
    ctx.moveTo(px - hw, py - fy);
    ctx.lineTo(px, py + hh - fy);
    ctx.lineTo(px + hw, py - fy);
  }
  ctx.stroke();
  // The corner post reads as structure and stops tall blocks looking like gradients.
  ctx.strokeStyle = shade(state.color, 0.3);
  ctx.beginPath();
  ctx.moveTo(px, py + hh);
  ctx.lineTo(px, py + hh - h);
  ctx.stroke();
  ctx.restore();
}

// Risk is a local heuristic, never a model judgment — so it gets its own channel:
// a surveyor's hatch over the roof, independent of the fill colour.
function drawHatch(px, py, hw, hh, h) {
  ctx.save();
  trace([[px - hw, py - h], [px, py - hh - h], [px + hw, py - h], [px, py + hh - h]]);
  ctx.clip();
  ctx.strokeStyle = STATES.stale.color;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let offset = -hw * 2; offset < hw * 2; offset += 3.5) {
    ctx.moveTo(px + offset, py - hh - h - 2);
    ctx.lineTo(px + offset + hh * 2 + 4, py + hh - h + 2);
  }
  ctx.stroke();
  ctx.restore();
}

// One glyph per tool class, on a leader line above the roof — the 1:1 mapping from
// tool call to visual state lives here, so fill colour is free to carry attention.
function drawAnnotation(building, px, roofY, fresh, scale) {
  const lead = 13 * Math.min(scale, 1.4);
  const r = 4.4 * Math.min(Math.max(scale, 0.7), 1.5);
  const cy = roofY - lead - r;

  ctx.globalAlpha *= fresh ? 1 : 0.5;
  ctx.strokeStyle = fresh ? ACCENT : DIM;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 1;

  ctx.save();
  ctx.setLineDash([1, 2]);
  ctx.beginPath();
  ctx.moveTo(px, roofY);
  ctx.lineTo(px, cy + r);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  switch (building.action) {
    case 'construct': // tower crane
      ctx.moveTo(px, cy + r);
      ctx.lineTo(px, cy - r);
      ctx.lineTo(px + r * 1.3, cy - r);
      ctx.lineTo(px + r * 1.3, cy - r * 0.2);
      break;
    case 'renovate': // scaffolding
      ctx.moveTo(px - r, cy - r);
      ctx.lineTo(px - r, cy + r);
      ctx.moveTo(px + r, cy - r);
      ctx.lineTo(px + r, cy + r);
      ctx.moveTo(px - r, cy - r * 0.3);
      ctx.lineTo(px + r, cy - r * 0.3);
      ctx.moveTo(px - r, cy + r * 0.5);
      ctx.lineTo(px + r, cy + r * 0.5);
      break;
    case 'survey': // surveyor's loupe
      ctx.arc(px - r * 0.2, cy - r * 0.2, r * 0.7, 0, Math.PI * 2);
      ctx.moveTo(px + r * 0.3, cy + r * 0.3);
      ctx.lineTo(px + r, cy + r);
      break;
    case 'inspect': // passed inspection
      ctx.moveTo(px - r, cy);
      ctx.lineTo(px - r * 0.2, cy + r * 0.7);
      ctx.lineTo(px + r, cy - r * 0.8);
      break;
    case 'crew': // hard hat
      ctx.arc(px, cy + r * 0.3, r * 0.7, Math.PI, 0);
      ctx.moveTo(px - r, cy + r * 0.3);
      ctx.lineTo(px + r, cy + r * 0.3);
      break;
    case 'extract': // on-site drill
      ctx.moveTo(px, cy - r);
      ctx.lineTo(px, cy + r * 0.4);
      ctx.moveTo(px - r * 0.5, cy - r * 0.1);
      ctx.lineTo(px, cy + r * 0.6);
      ctx.lineTo(px + r * 0.5, cy - r * 0.1);
      break;
    default: // material delivery
      ctx.moveTo(px - r, cy - r * 0.5);
      ctx.lineTo(px + r * 0.2, cy - r * 0.5);
      ctx.lineTo(px + r * 0.2, cy + r * 0.4);
      ctx.lineTo(px - r, cy + r * 0.4);
      ctx.closePath();
      ctx.moveTo(px + r * 0.2, cy - r * 0.1);
      ctx.lineTo(px + r, cy - r * 0.1);
      ctx.lineTo(px + r, cy + r * 0.4);
      ctx.lineTo(px + r * 0.2, cy + r * 0.4);
  }
  ctx.stroke();
}

// A colliding label is worse than no label, so overlaps are dropped, not stacked.
function drawLabels(now) {
  // The sidebar and the panel carry file names, so the map only spends space on
  // what the agent just did — until you zoom in far enough to read the rest.
  const showAll = camera.scale > 1.9;
  ctx.font = `${Math.round(9 * Math.min(camera.scale, 1.3))}px ui-monospace, monospace`;
  ctx.textAlign = 'center';

  const candidates = [];
  for (const building of city.buildings.values()) {
    const fresh = Boolean(building.lastTs) && now - building.lastTs <= GLYPH_MS;
    const focused = building === hovered || building === selected;
    if (!showAll && !fresh && !focused) continue;
    if (!inFocus(building.dir) && !focused) continue;
    const place = placements.get(building.path);
    if (!place) continue;
    candidates.push({ building, place, priority: focused ? 0 : fresh ? 1 : 2 });
  }
  candidates.sort((a, b) => a.priority - b.priority);

  const taken = [];
  for (const { building, place, priority } of candidates) {
    const { x, y } = project(place.gx, place.gy);
    const name = building.path.split('/').pop();
    const width = ctx.measureText(name).width + 6;
    const box = {
      x: x - width / 2,
      y: y - liftOf(place.depth) + 5 * camera.scale,
      w: width,
      h: 11,
    };
    if (taken.some((other) => box.x < other.x + other.w && other.x < box.x + box.w
      && box.y < other.y + other.h && other.y < box.y + box.h)) continue;
    taken.push(box);
    ctx.fillStyle = '#0a0b0dd9';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = priority === 2 ? DIM : priority === 1 ? ACCENT : INK;
    ctx.fillText(name, x, box.y + 8);
  }
}

function drawTooltip(now) {
  if (!hovered) return;
  const entry = silhouettes.find((item) => item.building === hovered);
  if (!entry) return;
  const [x, y] = entry.polygon[1];
  const state = stateOf(hovered, now);
  const storeys = floorsOf(hovered.loc);
  const text = `${hovered.path} · ${hovered.loc} lines / ${storeys} storey${storeys === 1 ? '' : 's'} · ${STATES[state.key].label}`;
  ctx.font = '10px ui-monospace, monospace';
  const width = ctx.measureText(text).width + 14;
  ctx.fillStyle = '#0a0b0df2';
  ctx.strokeStyle = PLATE_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x - width / 2, y - 42, width, 18);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y - 29);
}

function draw() {
  const now = Date.now();
  const ratio = window.devicePixelRatio || 1;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  silhouettes = [];
  drawGrid();
  drawDistrictPlates();
  drawRoads(now);

  const ordered = [...city.buildings.values()].sort((a, b) => {
    const pa = placements.get(a.path);
    const pb = placements.get(b.path);
    if (!pa || !pb) return 0;
    return pa.gx + pa.gy - (pb.gx + pb.gy) || pa.gx - pb.gx;
  });
  for (const building of ordered) drawBlock(building, now);

  drawDistrictLabels();
  drawLabels(now);
  drawTooltip(now);
}

// This thing is meant to sit open on a second monitor all day. A five-minute
// colour ramp does not need 60fps — only the glyphs do.
let lastCool = 0;

function frame() {
  const now = Date.now();
  const buildings = [...city.buildings.values()];
  const active = buildings.some((building) => building.lastTs && now - building.lastTs <= GLYPH_MS);
  const cooling = !active && buildings.some(
    (building) => building.lastRead && now - building.lastRead <= CONTEXT_MS,
  );

  if (needsDraw || active || (cooling && now - lastCool > 500)) {
    if (cooling) lastCool = now;
    draw();
    needsDraw = false;
  }
  requestAnimationFrame(frame);
}

/* ---------- interaction ---------- */

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * ratio;
  canvas.height = window.innerHeight * ratio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  needsDraw = true;
}

function inside(polygon, x, y) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function pick(x, y) {
  for (let i = silhouettes.length - 1; i >= 0; i -= 1) {
    if (inside(silhouettes[i].polygon, x, y)) return silhouettes[i].building;
  }
  return null;
}

canvas.addEventListener('mousedown', (event) => {
  drag.active = true;
  drag.x = event.clientX;
  drag.y = event.clientY;
  drag.moved = false;
  canvas.classList.add('dragging');
});

window.addEventListener('mousemove', (event) => {
  if (drag.active) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    camera.x += dx;
    camera.y += dy;
    drag.x = event.clientX;
    drag.y = event.clientY;
    needsDraw = true;
    return;
  }
  const next = event.target === canvas ? pick(event.clientX, event.clientY) : null;
  if (next !== hovered) {
    hovered = next;
    needsDraw = true;
  }
});

window.addEventListener('mouseup', (event) => {
  const wasDragging = drag.active;
  drag.active = false;
  canvas.classList.remove('dragging');
  if (!wasDragging || drag.moved || event.target !== canvas) return;
  const hit = pick(event.clientX, event.clientY);
  if (hit) select(hit);
  else clearSelection();
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * 0.0016);
  const next = Math.min(2.5, Math.max(0.12, camera.scale * factor));
  const ratio = next / camera.scale;
  camera.x = event.clientX - (event.clientX - camera.x) * ratio;
  camera.y = event.clientY - (event.clientY - camera.y) * ratio;
  camera.scale = next;
  needsDraw = true;
}, { passive: false });

window.addEventListener('resize', () => {
  resize();
  fitToView();
});

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  if (event.key === 'Escape') {
    clearSelection();
    return;
  }
  if (event.key === 'Enter' && selected) {
    showTab('what');
    explainButton.click();
    return;
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const pool = dirFocus === null ? walkOrder : walkOrder.filter((key) => city.buildings.get(key)?.dir === dirFocus);
  if (pool.length === 0) return;
  const at = selected ? pool.indexOf(selected.path) : -1;
  const step = event.key === 'ArrowDown' ? 1 : -1;
  const next = city.buildings.get(pool[(at + step + pool.length) % pool.length]);
  if (next) select(next);
});

/* ---------- panel ---------- */

const panel = document.getElementById('panel');
const panelEmpty = document.getElementById('panel-empty');
const panelBody = document.getElementById('panel-body');
const panelDir = document.getElementById('panel-dir');
const panelFile = document.getElementById('panel-file');
const panelState = document.getElementById('panel-state');
const panelMeta = document.getElementById('panel-meta');
const panelEvents = document.getElementById('panel-events');
const panelExplain = document.getElementById('panel-explain');
const explainButton = document.getElementById('explain');
const blastOut = document.getElementById('blast-out');
const blastIn = document.getElementById('blast-in');

function ago(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function showTab(name) {
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('on', button.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('#panel [data-pane]')) {
    pane.hidden = pane.dataset.pane !== name;
  }
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const name = event.target.dataset?.tab;
  if (name) showTab(name);
});

function select(building) {
  selected = building;
  dirFocus = null;
  renderDirectories();
  needsDraw = true;
  openPanel(building);
}

function clearSelection() {
  selected = null;
  panelBody.hidden = true;
  panelEmpty.hidden = false;
  needsDraw = true;
}

// Blast radius is pure graph data — zero tokens, and it answers the question the
// explain panel would otherwise be asked: what else does this touch?
function renderBlast(file) {
  const line = (key) => {
    const building = city.buildings.get(key);
    const state = building ? STATES[stateOf(building, Date.now()).key] : null;
    return `<li><span class="to">${escapeHtml(key)}</span>`
      + `<span class="note" style="color:${state ? state.color : DIM}">${state ? state.label : 'outside the city'}</span></li>`;
  };
  const out = importsOut.get(file) ?? [];
  const incoming = importsIn.get(file) ?? [];
  blastOut.innerHTML = out.length ? out.map(line).join('') : '<li>imports nothing in this city</li>';
  blastIn.innerHTML = incoming.length ? incoming.map(line).join('') : '<li>nothing here imports it</li>';
}

let panelRequest = 0;

async function openPanel(building) {
  const ticket = ++panelRequest;
  panelEmpty.hidden = true;
  panelBody.hidden = false;
  panelDir.textContent = building.dir || 'root';
  panelFile.textContent = building.path.split('/').pop();
  panelExplain.hidden = true;
  explainButton.disabled = false;
  explainButton.dataset.file = building.path;
  renderBlast(building.path);

  const response = await fetch(`/api/building?file=${encodeURIComponent(building.path)}`);
  const detail = await response.json();
  // A slower response for a previously clicked building must not repaint this one.
  if (ticket !== panelRequest) return;

  const state = stateOf(detail, Date.now());
  panelState.style.color = state.color;
  panelState.textContent = STATES[state.key].label
    + (detail.risk ? ` · ${RISK_LABELS[detail.risk]}` : '');
  panelMeta.textContent = [
    `${detail.loc} lines`,
    `${detail.touches} action${detail.touches === 1 ? '' : 's'}`,
    `${detail.reads} read · ${detail.writes} written`,
    detail.lastTs ? `last ${ago(detail.lastTs)} ago` : 'untouched',
  ].join(' · ');

  panelEvents.innerHTML = detail.events.length
    ? detail.events.map((event) => `<li><span class="when">${ago(event.ts)}</span>`
      + `<span class="tool">${escapeHtml(event.tool)}</span> ${TOOL_LABELS[event.action] ?? event.action}`
      + `<span class="note">${escapeHtml(event.detail ?? '')}</span></li>`).join('')
    : '<li>the agent has not touched this file</li>';
}

explainButton.addEventListener('click', async () => {
  const file = explainButton.dataset.file;
  if (!file) return;
  explainButton.disabled = true;
  explainButton.textContent = 'asking…';
  panelExplain.hidden = false;
  panelExplain.textContent = '…';
  try {
    const response = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const result = await response.json();
    const note = result.source === 'model' ? '' : `\n\n[${result.source}${result.error ? `: ${result.error}` : ''}]`;
    panelExplain.textContent = `${result.text}${note}`;
  } catch (error) {
    panelExplain.textContent = `Could not explain: ${error.message}`;
  }
  explainButton.disabled = false;
  explainButton.textContent = 'Ask what it does';
});

/* ---------- directory index ---------- */

const dirList = document.getElementById('dir-list');
const dirFilter = document.getElementById('dir-filter');

// The index mirrors the city: nested, and every level counts its whole subtree.
// A flat list of full paths makes src/api and src/api/routes look unrelated, which
// is exactly the relationship the terraces exist to show.
function renderDirectories() {
  const query = dirFilter.value.trim().toLowerCase();
  const rows = new Map();
  const tally = (dir, lit, loc) => {
    if (!rows.has(dir)) rows.set(dir, { total: 0, lit: 0, loc: 0 });
    const row = rows.get(dir);
    row.total += 1;
    row.loc += loc;
    if (lit) row.lit += 1;
  };

  for (const building of city.buildings.values()) {
    const lit = building.touches > 0;
    tally('', lit, building.loc);
    let dir = '';
    for (const part of building.dir ? building.dir.split('/') : []) {
      dir = dir ? `${dir}/${part}` : part;
      tally(dir, lit, building.loc);
    }
  }

  const repo = city.root.split('/').filter(Boolean).pop() || 'root';
  dirList.innerHTML = [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([dir]) => !query || (dir || repo).toLowerCase().includes(query))
    .map(([dir, row]) => {
      const depth = dir ? dir.split('/').length : 0;
      const name = dir ? dir.split('/').pop() : repo;
      const share = Math.round((row.lit / row.total) * 100);
      return `<li data-dir="${escapeHtml(dir)}" class="${dir === dirFocus ? 'on' : ''}"`
        + ` style="padding-left:${6 + depth * 10}px"`
        + ` title="${row.lit} of ${row.total} files touched · ${row.loc} lines">`
        + `<span class="name">${escapeHtml(name)}</span>`
        + `<span class="bar"><i style="width:${share}%"></i></span></li>`;
    })
    .join('');
}

dirFilter.addEventListener('input', renderDirectories);

dirList.addEventListener('click', (event) => {
  const row = event.target.closest('li');
  if (!row) return;
  const dir = row.dataset.dir;
  dirFocus = dirFocus === dir ? null : dir;
  renderDirectories();
  if (dirFocus !== null) focusDistrict(dirFocus);
  needsDraw = true;
});

/* ---------- status bar + live stream ---------- */

const ticker = document.getElementById('ticker');
const agentChip = document.getElementById('agent');
const statusCounts = document.getElementById('status-counts');
const feed = [];

function renderStatus() {
  const dirs = new Set([...city.buildings.values()].map((building) => building.dir)).size;
  const explored = [...city.buildings.values()].filter((building) => building.touches > 0).length;
  const risky = [...city.buildings.values()].filter((building) => building.risk).length;
  statusCounts.textContent = `${dirs} dirs · ${explored}/${city.buildings.size} explored`
    + `${risky ? ` · ${risky} flagged` : ''}${city.truncated ? ` · capped from ${city.totalFound}` : ''}`;

  // Agents repeat the same tool on the same file constantly; collapsing runs keeps
  // the ticker showing what changed rather than how often it changed.
  const runs = [];
  for (const event of feed) {
    const key = `${event.tool}\u0000${event.file ?? event.detail}`;
    if (runs.at(-1)?.key === key) runs.at(-1).count += 1;
    else runs.push({ key, event, count: 1 });
    if (runs.length > 4) break;
  }
  ticker.innerHTML = runs.slice(0, 4)
    .map(({ event, count }) => `<b>${escapeHtml(event.tool)}</b> `
      + `${escapeHtml(event.file ?? event.detail ?? '')}${count > 1 ? ` ×${count}` : ''}`)
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  const last = feed[0];
  const live = last && Date.now() - last.ts <= LIVE_MS;
  agentChip.className = `chip ${live ? 'live' : feed.length ? 'dead' : ''}`;
  agentChip.textContent = feed.length
    ? `claude · ${feed.length}${live ? '' : ` · idle ${ago(last.ts)}`}`
    : 'no agent yet';
}

function applyEvent(event, building, roads) {
  feed.unshift(event);
  if (feed.length > 200) feed.length = 200;

  if (roads?.length) {
    city.roads.push(...roads);
    indexRoads();
  }

  if (event.file) {
    if (city.buildings.has(event.file)) {
      Object.assign(city.buildings.get(event.file), building ?? {});
    } else if (building) {
      city.buildings.set(event.file, building);
      layout();
    }
    renderDirectories();
    if (selected?.path === event.file) openPanel(selected);
  }

  renderStatus();
  needsDraw = true;
}

async function boot() {
  resize();
  const snapshot = await (await fetch('/api/state')).json();
  city.root = snapshot.root;
  city.roads = snapshot.roads;
  city.truncated = snapshot.truncated;
  city.totalFound = snapshot.totalFound;
  for (const building of snapshot.buildings) city.buildings.set(building.path, building);
  for (const event of [...snapshot.feed].reverse()) feed.unshift(event);

  document.getElementById('root').textContent = snapshot.root;

  layout();
  indexRoads();
  renderDirectories();
  renderStatus();
  fitToView();
  needsDraw = true;
  requestAnimationFrame(frame);

  const stream = new EventSource('/api/stream');
  stream.addEventListener('event', (message) => {
    const { event, building, roads } = JSON.parse(message.data);
    applyEvent(event, building, roads);
  });
  stream.addEventListener('error', () => {
    agentChip.className = 'chip dead';
    agentChip.textContent = 'disconnected';
  });
}

boot();
