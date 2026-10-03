import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePaths, ensurePrivateDir } from '../src/paths.js';
import { loadConfig } from '../src/config.js';

const OPTS = { home: '/home/u', tmp: '/tmp', uid: 1000 };

describe('resolvePaths', () => {
  it('uses the XDG defaults when nothing is set', () => {
    const p = resolvePaths({}, OPTS);
    assert.equal(p.config, '/home/u/.config/claude-keep-going/config.json');
    assert.deepEqual(p.systemConfigs, ['/etc/xdg/claude-keep-going/config.json']);
    assert.equal(p.logs, '/home/u/.local/state/claude-keep-going/logs');
    assert.equal(p.runtime, '/tmp/claude-keep-going-1000');
  });
  it('follows the XDG variables', () => {
    const p = resolvePaths({
      XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s', XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CONFIG_DIRS: '/a:/b',
    }, OPTS);
    assert.equal(p.config, '/c/claude-keep-going/config.json');
    assert.deepEqual(p.systemConfigs, ['/a/claude-keep-going/config.json', '/b/claude-keep-going/config.json']);
    assert.equal(p.logs, '/s/claude-keep-going/logs');
    assert.equal(p.status, '/run/user/1000/claude-keep-going/status');
    assert.equal(p.events, '/run/user/1000/claude-keep-going/events');
    assert.equal(p.tmp, '/run/user/1000/claude-keep-going/tmp');
    assert.equal(p.lock, '/run/user/1000/claude-keep-going/reconcile.lock');
    assert.equal(p.exclude, '/run/user/1000/claude-keep-going/reconcile-exclude');
  });
  it('ignores relative values, as the spec requires', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: 'rel', XDG_RUNTIME_DIR: 'run', XDG_CONFIG_DIRS: 'x:/ok' }, OPTS);
    assert.equal(p.config, '/home/u/.config/claude-keep-going/config.json');
    assert.equal(p.runtime, '/tmp/claude-keep-going-1000');
    assert.deepEqual(p.systemConfigs, ['/ok/claude-keep-going/config.json']);
  });
});

describe('ensurePrivateDir', () => {
  let dir;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('creates the runtime root and subdirectories with mode 0700', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ckg-paths-'));
    const root = join(dir, 'rt');
    ensurePrivateDir(join(root, 'status'), root);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'status'))).mode & 0o777, 0o700);
  });
  it('tightens a runtime root that is too open', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ckg-paths-'));
    const root = join(dir, 'rt');
    await mkdir(root);
    await chmod(root, 0o755);
    ensurePrivateDir(join(root, 'events'), root);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  });
  it('refuses a runtime root that is a symlink', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ckg-paths-'));
    await mkdir(join(dir, 'elsewhere'));
    await symlink(join(dir, 'elsewhere'), join(dir, 'rt'));
    assert.throws(() => ensurePrivateDir(join(dir, 'rt', 'status'), join(dir, 'rt')), /not a directory/);
  });
  it('refuses a runtime root owned by someone else', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ckg-paths-'));
    const root = join(dir, 'rt');
    assert.throws(() => ensurePrivateDir(root, root, process.getuid() + 1), /owned by uid/);
  });
});

describe('loadConfig layering', () => {
  let dir;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('puts the user file over system files, merging nested blocks', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ckg-config-'));
    const sysLow = join(dir, 'low.json');
    const sysHigh = join(dir, 'high.json');
    const user = join(dir, 'user.json');
    await writeFile(sysLow, JSON.stringify({ maxRetries: 2, marginSeconds: 10, overload: { jitterPct: 5 } }));
    await writeFile(sysHigh, JSON.stringify({ maxRetries: 3, overload: { maxTotalWaitMinutes: 30 } }));
    await writeFile(user, JSON.stringify({ maxRetries: 9, overload: { enabled: false } }));
    const cfg = await loadConfig(user, [sysHigh, sysLow]);
    assert.equal(cfg.maxRetries, 9);
    assert.equal(cfg.marginSeconds, 10);
    assert.equal(cfg.overload.enabled, false);
    assert.equal(cfg.overload.jitterPct, 5);
    assert.equal(cfg.overload.maxTotalWaitMinutes, 30);
  });
  it('reads only the given file when no system paths are passed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ckg-config-'));
    const user = join(dir, 'user.json');
    await writeFile(user, JSON.stringify({ maxRetries: 4 }));
    assert.equal((await loadConfig(user)).maxRetries, 4);
  });
  it('skips an unreadable system file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ckg-config-'));
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{ not json');
    const cfg = await loadConfig(join(dir, 'missing.json'), [bad]);
    assert.equal(cfg.maxRetries, 5);
  });
});
