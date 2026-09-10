import fs from 'node:fs';
import path from 'node:path';
import { scanProject, lineCount, importsOf, indexFile } from './scan.js';

const EVENTS_PER_BUILDING = 12;
const FEED_LENGTH = 200;
const BURST_WINDOW_MS = 120_000;
const BURST_LIMIT = 3;
const UNREVIEWED_LIMIT = 2;

const WRITE_ACTIONS = new Set(['construct', 'renovate']);

export class CityState {
  constructor(root, options = {}) {
    this.root = root;
    this.buildings = new Map();
    this.roads = [];
    this.feed = [];
    this.startedAt = Date.now();

    const { files, roads, index, totalFound, truncated } = scanProject(root, options);
    this.index = index;
    this.totalFound = totalFound;
    this.truncated = truncated;
    for (const file of files) this.buildings.set(file.path, this.#newBuilding(file));
    this.roads.push(...roads);

    this.logDir = path.join(root, '.codecity');
    fs.mkdirSync(this.logDir, { recursive: true });
    if (options.resume !== false) this.#resume();
    this.logPath = path.join(this.logDir, `session-${this.startedAt}.jsonl`);
  }

  #newBuilding(file) {
    return {
      path: file.path,
      dir: file.dir === '.' ? '' : file.dir,
      loc: file.loc,
      deps: file.deps ?? [],
      action: null,
      lastTs: null,
      lastRead: null,
      lastWrite: null,
      touches: 0,
      reads: 0,
      writes: 0,
      created: false,
      unreviewedWrites: 0,
      writeStamps: [],
      risk: null,
      events: [],
    };
  }

  // Replaying the newest log means a server restart (or a crash) doesn't reset the
  // city — the developer keeps the session they were watching.
  #resume() {
    let newest = null;
    try {
      newest = fs.readdirSync(this.logDir)
        .filter((name) => name.startsWith('session-') && name.endsWith('.jsonl'))
        .sort()
        .pop();
    } catch {
      return;
    }
    if (!newest) return;

    let lines;
    try {
      lines = fs.readFileSync(path.join(this.logDir, newest), 'utf8').split('\n');
    } catch {
      return;
    }

    const remeasure = new Set();
    for (const line of lines) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        this.#ingest(event, { measure: false });
        if (event.file && WRITE_ACTIONS.has(event.action)) remeasure.add(event.file);
      } catch {
        // A truncated last line is normal if the previous process was killed.
      }
    }
    // One stat per touched file instead of one per event.
    for (const file of remeasure) {
      const building = this.buildings.get(file);
      if (building) building.loc = lineCount(path.join(this.root, file));
    }
    this.resumedFrom = newest;
    this.resumedEvents = this.feed.length;
  }

  #ingest(event, { measure = true } = {}) {
    this.feed.unshift(event);
    if (this.feed.length > FEED_LENGTH) this.feed.length = FEED_LENGTH;

    if (!event.file) return { building: null, roads: null };

    let building = this.buildings.get(event.file);
    if (!building) {
      // The agent created a file that didn't exist when we scanned — a new plot.
      building = this.#newBuilding({ path: event.file, dir: path.dirname(event.file), loc: 0 });
      this.buildings.set(event.file, building);
      indexFile(this.index, path.join(this.root, event.file));
      // Stamped on the event, not just the building: after a restart the file
      // exists, so the log is the only remaining evidence the agent made it.
      event.created = true;
    }
    if (event.created) building.created = true;

    building.action = event.action;
    building.lastTs = event.ts;
    building.touches += 1;

    if (event.action === 'survey') {
      building.reads += 1;
      building.lastRead = event.ts;
      building.unreviewedWrites = 0;
    }

    // null means "this event says nothing about roads"; [] means "it has none".
    let roads = null;
    if (WRITE_ACTIONS.has(event.action)) {
      building.writes += 1;
      building.lastWrite = event.ts;
      building.unreviewedWrites += 1;
      building.writeStamps.push(event.ts);
      if (measure) building.loc = lineCount(path.join(this.root, event.file));
      roads = this.#refreshRoads(event.file);
    }

    building.writeStamps = building.writeStamps.filter((ts) => event.ts - ts <= BURST_WINDOW_MS);
    building.risk = building.writeStamps.length >= BURST_LIMIT
      ? 'burst'
      : building.unreviewedWrites >= UNREVIEWED_LIMIT ? 'unreviewed' : null;

    building.events.unshift(event);
    if (building.events.length > EVENTS_PER_BUILDING) building.events.length = EVENTS_PER_BUILDING;

    return { building, roads };
  }

  // Imports are re-read after every write, so a dependency added mid-session shows up
  // as a road immediately instead of waiting for a restart. The file's whole outgoing
  // set is replaced rather than appended to: an import the agent just deleted has to
  // take its road with it, or the city keeps advertising a dependency that is gone.
  #refreshRoads(relative) {
    const { targets, deps } = importsOf(path.join(this.root, relative), this.index);
    const building = this.buildings.get(relative);
    if (building) building.deps = deps;

    const outgoing = targets.map((target) => ({
      from: relative,
      to: path.relative(this.root, target).split(path.sep).join('/'),
    }));
    this.roads = this.roads.filter((road) => road.from !== relative);
    this.roads.push(...outgoing);
    return outgoing;
  }

  apply(event) {
    const result = this.#ingest(event);
    fs.appendFile(this.logPath, `${JSON.stringify(event)}\n`, () => {});
    return { event, ...result };
  }

  eventsFor(file) {
    return this.buildings.get(file)?.events ?? [];
  }

  snapshot() {
    return {
      root: this.root,
      startedAt: this.startedAt,
      totalFound: this.totalFound,
      truncated: this.truncated,
      resumedFrom: this.resumedFrom ?? null,
      resumedEvents: this.resumedEvents ?? 0,
      buildings: [...this.buildings.values()].map(({ events, writeStamps, ...rest }) => ({
        ...rest,
        lastDetail: events[0]?.detail ?? null,
        lastTool: events[0]?.tool ?? null,
      })),
      roads: this.roads,
      feed: this.feed,
    };
  }
}
