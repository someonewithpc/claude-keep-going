// Snapshot of the JSON Claude Code feeds its statusLine command.
//
// That input carries numbers the monitor can't get any other way: when the prompt cache
// expires (prompt_cache.expires_at), when each usage window resets
// (rate_limits.*.resets_at), how full the context is (context_window.used_percentage),
// and which model is running. `claude-keep-going statusline-tap -- <your command>` sits
// in front of the real statusline command, saves the fields below for the pane, and
// passes the input through unchanged.
//
// Claude Code refreshes the statusline after each message and on refreshInterval, so
// the snapshot is at most that old.

import { writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, ensurePrivateDir } from './paths.js';
import { sanitizeKey, socketIdFromEnv } from './pane-key.js';

export const STATUSLINE_DIR = join(PATHS.runtime, 'statusline');

function fileFor(paneKey, dir, env) {
  return join(dir, `${sanitizeKey(socketIdFromEnv(env))}_${sanitizeKey(paneKey)}.json`);
}

export function snapshotFromStatusline(input, now = Date.now()) {
  return {
    ts: now,
    session_id: input?.session_id ?? null,
    model: input?.model ?? null,
    context_window: input?.context_window ?? null,
    prompt_cache: input?.prompt_cache ?? null,
    rate_limits: input?.rate_limits ?? null,
  };
}

export async function writeStatuslineSnapshot(paneKey, input, dir = STATUSLINE_DIR, env = process.env) {
  if (!paneKey) return null;
  ensurePrivateDir(dir);
  const file = fileFor(paneKey, dir, env);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshotFromStatusline(input)));
  await rename(tmp, file);
  return file;
}

export async function readStatuslineSnapshot(paneKey, { maxAgeMs, dir = STATUSLINE_DIR, env = process.env } = {}) {
  if (!paneKey) return null;
  try {
    const s = JSON.parse(await readFile(fileFor(paneKey, dir, env), 'utf-8'));
    if (typeof s.ts !== 'number') return null;
    if (maxAgeMs !== undefined && Date.now() - s.ts > maxAgeMs) return null;
    return s;
  } catch {
    return null;
  }
}

// Epoch ms when the prompt cache expires, or null when unknown or already cold.
export function cacheExpiresAtMs(snap) {
  const pc = snap?.prompt_cache;
  if (!pc || pc.warm === false || typeof pc.expires_at !== 'number') return null;
  return pc.expires_at * 1000;
}

export function contextPercent(snap) {
  const p = snap?.context_window?.used_percentage;
  return typeof p === 'number' ? p : null;
}
