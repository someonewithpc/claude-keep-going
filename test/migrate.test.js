import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../src/paths.js';
import { planMigration, applyMigration, sweepLegacyDir, olderMonitorPids, legacyPaths } from '../src/migrate.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('migration from ~/.claude-auto-retry*', () => {
  let home, paths, legacy;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ckg-migrate-'));
    paths = resolvePaths({}, { home, tmp: join(home, 'tmp'), uid: 1 });
    legacy = legacyPaths(home);
    await mkdir(join(legacy.dir, 'logs'), { recursive: true });
    await mkdir(join(legacy.dir, 'status'), { recursive: true });
    await writeFile(legacy.config, '{"maxRetries": 7}');
    await writeFile(join(legacy.dir, 'logs', '2026-10-01.log'), 'old day\n');
    await writeFile(join(legacy.dir, 'logs', '2026-10-03.log'), 'old today\n');
    await writeFile(join(legacy.dir, 'status', 'default__1.json'), '{}');
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('plans the config, the logs and the old directory', async () => {
    const plan = await planMigration({ home, paths });
    assert.deepEqual(plan.steps.map((s) => s.kind), ['config', 'logs', 'remove-dir']);
  });

  it('moves config and logs, keeps earlier log lines first, and deletes the old directory', async () => {
    await mkdir(paths.logs, { recursive: true });
    await writeFile(join(paths.logs, '2026-10-03.log'), 'new today\n');
    await applyMigration(await planMigration({ home, paths }));
    assert.equal(await readFile(paths.config, 'utf-8'), '{"maxRetries": 7}');
    assert.equal(await readFile(join(paths.logs, '2026-10-01.log'), 'utf-8'), 'old day\n');
    assert.equal(await readFile(join(paths.logs, '2026-10-03.log'), 'utf-8'), 'old today\nnew today\n');
    assert.equal(existsSync(legacy.config), false);
    assert.equal(existsSync(legacy.dir), false);
  });

  it('does not overwrite a config that already exists in the new place', async () => {
    await mkdir(dirname(paths.config), { recursive: true });
    await writeFile(paths.config, '{"maxRetries": 1}');
    const plan = await planMigration({ home, paths });
    assert.equal(plan.steps[0].kind, 'config-conflict');
    await applyMigration(plan);
    assert.equal(await readFile(paths.config, 'utf-8'), '{"maxRetries": 1}');
    assert.equal(existsSync(legacy.config), true);
  });

  it('keeps the old directory while older monitors still use it', async () => {
    const lines = await applyMigration(await planMigration({ home, paths }), { olderMonitorsRunning: true });
    assert.equal(existsSync(join(legacy.dir, 'status', 'default__1.json')), true);
    assert.equal(existsSync(join(legacy.dir, 'logs', '2026-10-01.log')), false);
    assert.ok(lines.some((l) => l.startsWith('kept')));
  });

  it('warns about an old config that is not valid JSON but still moves it', async () => {
    await writeFile(legacy.config, '{ broken');
    const lines = await applyMigration(await planMigration({ home, paths }));
    assert.ok(lines.some((l) => l.startsWith('warning')));
    assert.equal(await readFile(paths.config, 'utf-8'), '{ broken');
  });

  it('has nothing to do once migrated', async () => {
    await applyMigration(await planMigration({ home, paths }));
    assert.deepEqual((await planMigration({ home, paths })).steps, []);
  });

  it('runs end to end through the CLI with --yes', async () => {
    const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, 'run') };
    for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_DIRS']) delete env[k];
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'bin', 'cli.js'), 'migrate', '--yes'], { env, encoding: 'utf-8' });
    assert.match(out, /moved/);
    assert.equal(await readFile(join(home, '.config', 'claude-keep-going', 'config.json'), 'utf-8'), '{"maxRetries": 7}');
    assert.equal(existsSync(join(home, '.local', 'state', 'claude-keep-going', 'logs', '2026-10-01.log')), true);
  });

  it('moves nothing without a terminal unless --yes is given', async () => {
    const env = { ...process.env, HOME: home };
    for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_DIRS']) delete env[k];
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'bin', 'cli.js'), 'migrate'], { env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.match(out, /nothing was moved/);
    assert.equal(existsSync(legacy.config), true);
  });
});

describe('sweepLegacyDir', () => {
  let home;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ckg-sweep-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('deletes a directory that only holds throwaway state', async () => {
    await mkdir(join(home, '.claude-auto-retry', 'status'), { recursive: true });
    assert.equal(await sweepLegacyDir({ home }), true);
    assert.equal(existsSync(join(home, '.claude-auto-retry')), false);
  });
  it('leaves it while logs or the old config are still there', async () => {
    await mkdir(join(home, '.claude-auto-retry', 'logs'), { recursive: true });
    await writeFile(join(home, '.claude-auto-retry', 'logs', 'a.log'), 'x');
    assert.equal(await sweepLegacyDir({ home }), false);
    await rm(join(home, '.claude-auto-retry', 'logs'), { recursive: true });
    await writeFile(join(home, '.claude-auto-retry.json'), '{}');
    assert.equal(await sweepLegacyDir({ home }), false);
  });
  it('leaves it while older monitors run', async () => {
    await mkdir(join(home, '.claude-auto-retry'), { recursive: true });
    assert.equal(await sweepLegacyDir({ home, olderMonitorsRunning: true }), false);
  });
});

describe('olderMonitorPids', () => {
  it('lists monitors that are not from this install', () => {
    const out = [
      '101 node /nix/store/aaa-claude-keep-going-0.9.0/lib/claude-keep-going/src/monitor.js %1 500',
      '102 node /nix/store/zzz-claude-auto-retry-0.7.3/lib/claude-auto-retry/src/monitor.js %2 501',
      '103 vim notes.md',
    ].join('\n');
    assert.deepEqual(olderMonitorPids(out, '/nix/store/aaa-claude-keep-going-0.9.0/lib/claude-keep-going/src'), [102]);
  });
});
