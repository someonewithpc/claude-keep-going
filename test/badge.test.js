import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatBadge } from '../src/status-file.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_800_000_000;

const CASES = [
  ['monitoring', { status: 'monitoring', updatedAt: NOW }, '🟢KG'],
  ['waiting, under an hour', { status: 'waiting', updatedAt: NOW, waitUntil: NOW + 25 * 60 }, '⏳KG 25m'],
  ['waiting, over an hour', { status: 'waiting', updatedAt: NOW, waitUntil: NOW + 3600 + 5 * 60 }, '⏳KG 1h05m'],
  ['overload', { status: 'overload', updatedAt: NOW, overloadWaitUntil: NOW + 45 }, '🟠KG 45s'],
  ['safeguard', { status: 'safeguard', updatedAt: NOW, safeguardWaitUntil: NOW + 8 }, '🛡KG 8s'],
  ['gave up', { status: 'waiting', updatedAt: NOW, waitUntil: NOW + 60, gaveUp: true }, '🔴KG'],
  ['stale', { status: 'monitoring', updatedAt: NOW - 31 }, ''],
  ['stale by its own interval', { status: 'monitoring', updatedAt: NOW - 50, pollIntervalSeconds: 30 }, '🟢KG'],
  ['compaction scheduled', { status: 'monitoring', updatedAt: NOW, compactAt: NOW + 150 }, '🟢KG 🗜3m'],
  ['compaction time passed', { status: 'monitoring', updatedAt: NOW, compactAt: NOW - 5 }, '🟢KG'],
  ['unknown status', { status: 'interrupted', updatedAt: NOW }, ''],
];

describe('formatBadge', () => {
  for (const [name, snap, want] of CASES) {
    it(name, () => assert.equal(formatBadge(snap, NOW), want));
  }
  it('shows nothing without a snapshot', () => assert.equal(formatBadge(null, NOW), ''));
});

// bin/tmux-status.sh renders the same badge in POSIX sh. Run both on the same snapshot.
describe('formatBadge matches bin/tmux-status.sh', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'ckg-badge-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const [name, snap] of CASES) {
    it(name, async () => {
      const now = Math.floor(Date.now() / 1000);
      // Shift the snapshot onto the real clock, since the script reads `date +%s`.
      const shifted = Object.fromEntries(Object.entries(snap).map(([k, v]) =>
        [k, typeof v === 'number' && k !== 'pollIntervalSeconds' ? v - NOW + now : v]));
      const runtime = join(dir, 'claude-keep-going');
      await mkdir(join(runtime, 'status'), { recursive: true });
      await writeFile(join(runtime, 'status', 'sock_pane.json'), JSON.stringify(shifted));
      const out = execFileSync('sh', [join(REPO_ROOT, 'bin', 'tmux-status.sh'), 'pane', 'sock'], {
        env: { ...process.env, XDG_RUNTIME_DIR: dir }, encoding: 'utf-8',
      });
      assert.equal(out, formatBadge(shifted, now));
    });
  }
});

describe('status --pane', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'ckg-badge-cli-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('prints the badge for a pane from the runtime dir', async () => {
    const runtime = join(dir, 'claude-keep-going');
    await mkdir(join(runtime, 'status'), { recursive: true });
    await writeFile(join(runtime, 'status', '_tmp_tmux-1000_default__3.json'),
      JSON.stringify({ status: 'monitoring', updatedAt: Math.floor(Date.now() / 1000) }));
    const out = execFileSync(process.execPath,
      [join(REPO_ROOT, 'bin', 'cli.js'), 'status', '--pane', '%3', '--socket', '/tmp/tmux-1000/default'],
      { env: { ...process.env, XDG_RUNTIME_DIR: dir }, encoding: 'utf-8' });
    assert.equal(out, '🟢KG');
  });
  it('prints nothing for a pane without a monitor', () => {
    const out = execFileSync(process.execPath,
      [join(REPO_ROOT, 'bin', 'cli.js'), 'status', '--pane', '%99', '--socket', 'x'],
      { env: { ...process.env, XDG_RUNTIME_DIR: dir }, encoding: 'utf-8' });
    assert.equal(out, '');
  });
});
