import { spawn } from 'node:child_process';
import os from 'node:os';
import { ACTIONS } from './schema.js';

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 25_000;
const MAX_EVENTS = 3;

const cache = new Map();

function prompt(file, events) {
  const lines = events
    .slice(0, MAX_EVENTS)
    .reverse()
    .map((event) => `- ${event.tool}: ${event.detail ?? ACTIONS[event.action].hint}`)
    .join('\n');

  return `A coding agent just made these tool calls on the file "${file}":\n${lines}\n\nIn one or two plain sentences, tell a junior developer what the agent did to this file and why it likely did it. No preamble, no bullet points, no code.`;
}

// Deterministic fallback so the city is still legible with no model available at all.
function localSummary(file, events) {
  if (events.length === 0) return `Nothing has happened to ${file} yet this session.`;
  const counts = new Map();
  for (const event of events) counts.set(event.action, (counts.get(event.action) ?? 0) + 1);
  const parts = [...counts].map(([action, n]) => `${n}× ${ACTIONS[action].hint}`);
  return `${file}: ${parts.join(', ')} (most recent: ${events[0].tool}).`;
}

function runClaude(text) {
  return new Promise((resolve, reject) => {
    // cwd is a temp dir on purpose: running inside the project would load the
    // project's own CodeCity hook and this explain call would feed itself events.
    const child = spawn('claude', ['-p', '--model', MODEL, '--output-format', 'text'], {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('explain timed out'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) {
        resolve(out.trim());
        return;
      }
      // claude reports setup problems (auth, config) on stdout, so include both.
      const reason = [err.trim(), out.trim()].filter(Boolean).join(' — ');
      reject(new Error(reason ? `claude exited ${code}: ${reason}` : `claude exited ${code}`));
    });

    child.stdin.end(text);
  });
}

export async function explain(file, events) {
  const key = `${file}\u0000${events[0]?.id ?? 'empty'}`;
  if (cache.has(key)) return { text: cache.get(key), source: 'cache' };
  if (events.length === 0) return { text: localSummary(file, events), source: 'local' };

  try {
    const text = await runClaude(prompt(file, events));
    cache.set(key, text);
    return { text, source: 'model' };
  } catch (error) {
    return { text: localSummary(file, events), source: 'local', error: error.message };
  }
}
