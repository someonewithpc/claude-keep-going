// Moves files left by claude-auto-retry (and claude-keep-going before 0.9) from
// ~/.claude-auto-retry.json and ~/.claude-auto-retry/ to the XDG locations in paths.js.
//
// Config and logs are copied, checked, and only then removed from the old place. The
// rest of the old directory (status files, markers, lock, env snapshots) only matters to
// monitors that are still running from an older install, so it is deleted once none are
// left, and kept until then.

import { readFile, writeFile, readdir, rm, unlink, stat, copyFile, mkdir, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { PATHS } from './paths.js';

export function legacyPaths(home = homedir()) {
  return {
    config: join(home, '.claude-auto-retry.json'),
    dir: join(home, '.claude-auto-retry'),
    logs: join(home, '.claude-auto-retry', 'logs'),
  };
}

export async function planMigration({ home = homedir(), paths = PATHS } = {}) {
  const legacy = legacyPaths(home);
  const steps = [];
  if (existsSync(legacy.config)) {
    steps.push(existsSync(paths.config)
      ? { kind: 'config-conflict', from: legacy.config, to: paths.config }
      : { kind: 'config', from: legacy.config, to: paths.config });
  }
  let logFiles = [];
  try { logFiles = (await readdir(legacy.logs)).filter((f) => f.endsWith('.log')); } catch { /* none */ }
  if (logFiles.length > 0) steps.push({ kind: 'logs', from: legacy.logs, to: paths.logs, files: logFiles });
  if (existsSync(legacy.dir)) steps.push({ kind: 'remove-dir', path: legacy.dir });
  return { legacy, steps };
}

export function describeStep(step) {
  switch (step.kind) {
    case 'config': return `move config ${step.from} -> ${step.to}`;
    case 'config-conflict': return `keep ${step.from}: ${step.to} already exists, merge it by hand`;
    case 'logs': return `move ${step.files.length} log file(s) ${step.from} -> ${step.to}`;
    case 'remove-dir': return `delete ${step.path} (status files, markers, lock; nothing to keep)`;
    default: return step.kind;
  }
}

async function sameBytes(a, b) {
  const [x, y] = await Promise.all([readFile(a), readFile(b)]);
  return x.equals(y);
}

// Returns one line per action taken. `olderMonitorsRunning` keeps the old directory in
// place for monitors from a previous install that still write there.
export async function applyMigration(plan, { olderMonitorsRunning = false } = {}) {
  const done = [];
  for (const step of plan.steps) {
    if (step.kind === 'config') {
      await mkdir(dirname(step.to), { recursive: true });
      await copyFile(step.from, step.to, constants.COPYFILE_EXCL);
      if (!(await sameBytes(step.from, step.to))) throw new Error(`copy of ${step.from} does not match, left it in place`);
      try { JSON.parse(await readFile(step.to, 'utf-8')); } catch {
        done.push(`warning: ${step.to} is not valid JSON, so the defaults apply until you fix it`);
      }
      await unlink(step.from);
      done.push(`moved ${step.from} -> ${step.to}`);
    } else if (step.kind === 'config-conflict') {
      done.push(`kept ${step.from}: ${step.to} already exists`);
    } else if (step.kind === 'logs') {
      await mkdir(step.to, { recursive: true });
      for (const f of step.files) {
        const src = join(step.from, f);
        const dest = join(step.to, f);
        const old = await readFile(src);
        // A log for the same day may already exist if the new version ran first. The
        // old lines are earlier, so they go in front.
        const current = existsSync(dest) ? await readFile(dest) : Buffer.alloc(0);
        await writeFile(dest, Buffer.concat([old, current]));
        if ((await stat(dest)).size < old.length) throw new Error(`copy of ${src} is short, left it in place`);
        await unlink(src);
      }
      done.push(`moved ${step.files.length} log file(s) to ${step.to}`);
    } else if (step.kind === 'remove-dir') {
      if (olderMonitorsRunning) {
        done.push(`kept ${step.path}: monitors from an older install still use it (reconcile deletes it once they exit)`);
      } else {
        await rm(step.path, { recursive: true, force: true });
        done.push(`deleted ${step.path}`);
      }
    }
  }
  return done;
}

// For reconcile: delete the old directory once it only holds throwaway state, meaning
// the config and logs are gone and no older monitor is running.
export async function sweepLegacyDir({ home = homedir(), olderMonitorsRunning = false } = {}) {
  const legacy = legacyPaths(home);
  if (olderMonitorsRunning || !existsSync(legacy.dir) || existsSync(legacy.config)) return false;
  try {
    if ((await readdir(legacy.logs)).some((f) => f.endsWith('.log'))) return false;
  } catch { /* no logs dir */ }
  await rm(legacy.dir, { recursive: true, force: true });
  return true;
}

// Monitors whose script is not this install's src/monitor.js, from `pgrep -af` output.
export function olderMonitorPids(pgrepOutput, srcDir) {
  const own = join(srcDir, 'monitor.js');
  const pids = [];
  for (const line of String(pgrepOutput).split('\n')) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m || !/src\/monitor\.js/.test(m[2])) continue;
    if (!m[2].includes(own)) pids.push(Number(m[1]));
  }
  return pids;
}
