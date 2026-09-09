import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CityState } from './state.js';
import { normalize } from './schema.js';
import { explain } from './explain.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = requested === '/' ? 'index.html' : requested.slice(1);
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

export function createServer(root, options = {}) {
  const state = new CityState(root, options);
  const clients = new Set();

  const broadcast = (type, data) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && pathname === '/codecity/event') {
      // Answer the hook immediately — it must never slow the agent down.
      res.writeHead(204).end();
      try {
        const raw = await readBody(req);
        if (!raw) return;
        const event = normalize(JSON.parse(raw), root);
        const { building, roads } = state.apply(event);
        broadcast('event', {
          event,
          building: building ? { ...building, events: undefined, writeStamps: undefined } : null,
          roads,
        });
      } catch {
        // A malformed hook payload should never take the server down.
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      json(res, 200, state.snapshot());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('event: ready\ndata: {}\n\n');
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/explain') {
      try {
        const { file } = JSON.parse(await readBody(req, 10_000));
        if (!file || !state.buildings.has(file)) {
          json(res, 404, { error: 'unknown building' });
          return;
        }
        json(res, 200, await explain(file, state.eventsFor(file)));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/building') {
      const file = new URL(req.url, 'http://localhost').searchParams.get('file');
      const building = state.buildings.get(file);
      if (!building) {
        json(res, 404, { error: 'unknown building' });
        return;
      }
      json(res, 200, building);
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    res.writeHead(405).end('method not allowed');
  });

  return { server, state };
}
