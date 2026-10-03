import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  markerFromHook, writeMarker, readMarker, clearMarker, turnState, isSettled, paneKeyFromEnv,
} from '../src/markers.js';
import { snapshotFromStatusline, cacheExpiresAtMs, contextPercent, readStatuslineSnapshot } from '../src/statusline.js';
import { applyHooks, removeHooks } from '../bin/cli.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = { TMUX: '/tmp/tmux-1000/default,1,0' };

describe('markerFromHook', () => {
  it('summarises a Stop payload', () => {
    const m = markerFromHook('stop', {
      session_id: 's', transcript_path: '/t.jsonl', last_assistant_message: 'x'.repeat(3000),
      background_tasks: [{ id: 1 }], session_crons: [],
    }, 5);
    assert.deepEqual({ ...m, last: m.last.length }, {
      ts: 5, session_id: 's', background: 1, crons: 0, hasBackgroundInfo: true, last: 2000, transcript_path: '/t.jsonl',
    });
  });
  it('marks a Stop payload without background_tasks as unknown', () => {
    assert.equal(markerFromHook('stop', {}).hasBackgroundInfo, false);
  });
  it('keeps the source and head of a prompt', () => {
    const m = markerFromHook('prompt', { prompt: '/compact keep the TODOs', source: 'user' }, 1);
    assert.equal(m.source, 'user');
    assert.equal(m.head, '/compact keep the TODOs');
  });
  it('keeps the notification type', () => {
    assert.equal(markerFromHook('notify', { notification_type: 'quota_auto_resume_fired' }).type, 'quota_auto_resume_fired');
  });
  it('keeps both models of a switch', () => {
    const m = markerFromHook('model', { from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', source: 'command' });
    assert.equal(m.from, 'claude-opus-5-5');
    assert.equal(m.to, 'claude-sonnet-5-5');
  });
});

describe('marker files', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'ckg-markers-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips per pane and kind', async () => {
    await writeMarker('stop', '%3', { ts: Date.now(), background: 0 }, dir, ENV);
    await writeMarker('prompt', '%3', { ts: Date.now() }, dir, ENV);
    assert.equal((await readMarker('stop', '%3', { dir, env: ENV })).background, 0);
    assert.ok(await readMarker('prompt', '%3', { dir, env: ENV }));
    assert.equal(await readMarker('stop', '%4', { dir, env: ENV }), null);
    assert.deepEqual((await readdir(dir)).sort(), ['_tmp_tmux-1000_default__3.prompt.json', '_tmp_tmux-1000_default__3.stop.json']);
  });
  it('treats an old marker as absent when maxAgeMs is given', async () => {
    await writeMarker('notify', '%5', { ts: Date.now() - 10_000 }, dir, ENV);
    assert.equal(await readMarker('notify', '%5', { maxAgeMs: 1000, dir, env: ENV }), null);
    assert.ok(await readMarker('notify', '%5', { dir, env: ENV }));
  });
  it('clears a marker', async () => {
    await writeMarker('request', '%6', { ts: Date.now() }, dir, ENV);
    await clearMarker('request', '%6', dir, ENV);
    assert.equal(await readMarker('request', '%6', { dir, env: ENV }), null);
  });
});

describe('turnState and isSettled', () => {
  it('is unknown without markers', () => assert.equal(turnState({}), 'unknown'));
  it('is busy when a prompt follows the last stop', () => assert.equal(turnState({ stop: { ts: 1 }, prompt: { ts: 2 } }), 'busy'));
  it('is idle when the last stop follows the prompt', () => assert.equal(turnState({ stop: { ts: 3 }, prompt: { ts: 2 } }), 'idle'));
  it('is idle with only a stop, busy with only a prompt', () => {
    assert.equal(turnState({ stop: { ts: 1 } }), 'idle');
    assert.equal(turnState({ prompt: { ts: 1 } }), 'busy');
  });
  it('is settled only when nothing is in flight and the payload said so', () => {
    assert.equal(isSettled({ hasBackgroundInfo: true, background: 0, crons: 0 }), true);
    assert.equal(isSettled({ hasBackgroundInfo: true, background: 1, crons: 0 }), false);
    assert.equal(isSettled({ hasBackgroundInfo: true, background: 0, crons: 1 }), false);
    assert.equal(isSettled({ hasBackgroundInfo: false, background: 0, crons: 0 }), false);
  });
  it('prefers the launcher pane over $TMUX_PANE', () => {
    assert.equal(paneKeyFromEnv({ CLAUDE_KEEP_GOING_PANE: '%1', TMUX_PANE: '%2' }), '%1');
    assert.equal(paneKeyFromEnv({ TMUX_PANE: '%2' }), '%2');
    assert.equal(paneKeyFromEnv({}), null);
  });
});

describe('statusline snapshot', () => {
  const input = {
    session_id: 's', model: { display_name: 'Opus 5.5' }, workspace: { current_dir: '/x' },
    context_window: { used_percentage: 42 },
    prompt_cache: { warm: true, ttl: '1h', expires_at: 1_800_000_000 },
    rate_limits: { five_hour: { resets_at: 1_800_003_600 } },
  };
  it('keeps only the fields the monitor reads', () => {
    const s = snapshotFromStatusline(input, 7);
    assert.deepEqual(Object.keys(s).sort(), ['context_window', 'model', 'prompt_cache', 'rate_limits', 'session_id', 'ts']);
    assert.equal(cacheExpiresAtMs(s), 1_800_000_000_000);
    assert.equal(contextPercent(s), 42);
  });
  it('has no expiry for a cold cache', () => {
    assert.equal(cacheExpiresAtMs({ prompt_cache: { warm: false, expires_at: 1 } }), null);
    assert.equal(cacheExpiresAtMs({}), null);
  });
});

describe('applyHooks and removeHooks', () => {
  const other = { hooks: [{ type: 'command', command: '/home/u/notify.sh', async: true }] };
  const settings = { theme: 'dark', hooks: { Stop: [other], Notification: [other] } };

  it('adds our hooks next to existing ones, once', () => {
    const once = applyHooks(settings, { prefix: '/bin/ckg' });
    const twice = applyHooks(once, { prefix: '/bin/ckg2' });
    assert.equal(twice.theme, 'dark');
    for (const event of ['Stop', 'UserPromptSubmit', 'Notification', 'PostCompact', 'PostModelSwitch']) {
      const ours = twice.hooks[event].filter((e) => JSON.stringify(e).includes('_ckg-hook'));
      assert.equal(ours.length, 1, event);
      assert.equal(ours[0].hooks[0].command, `/bin/ckg2 _ckg-hook ${event}`);
      assert.equal(ours[0].hooks[0].async, true);
    }
    assert.deepEqual(twice.hooks.Stop[0], other);
    assert.equal(twice.hooks.StopFailure.length, 1);
  });
  it('adds payload recording only with dump', () => {
    const plain = applyHooks({}, { prefix: '/bin/ckg' });
    assert.ok(!JSON.stringify(plain).includes('_hook-dump'));
    const dumped = applyHooks({}, { prefix: '/bin/ckg', dump: true });
    assert.ok(dumped.hooks.SubagentStop.some((e) => JSON.stringify(e).includes('_hook-dump')));
  });
  it('removes ours and leaves the rest', () => {
    const cleaned = removeHooks(applyHooks(settings, { prefix: '/bin/ckg', dump: true }));
    assert.deepEqual(cleaned, settings);
  });
  it('removes only the recording with onlyDump', () => {
    const installed = applyHooks(settings, { prefix: '/bin/ckg' });
    assert.deepEqual(removeHooks(applyHooks(installed, { prefix: '/bin/ckg', dump: true }), { onlyDump: true }), installed);
  });
});

describe('hook and tap commands', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'ckg-hookcli-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });
  const env = () => ({ ...process.env, XDG_RUNTIME_DIR: dir, TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7', CLAUDE_KEEP_GOING_PANE: '' });

  it('writes a marker and prints nothing', () => {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'bin', 'cli.js'), '_ckg-hook', 'UserPromptSubmit'], {
      env: env(), input: JSON.stringify({ prompt: 'hello', source: 'user' }), encoding: 'utf-8',
    });
    assert.equal(out, '');
  });
  it('the marker is readable for the pane', async () => {
    const m = await readMarker('prompt', '%7', { dir: join(dir, 'claude-keep-going', 'events'), env: env() });
    assert.equal(m.head, 'hello');
  });
  it('statusline-tap saves the snapshot and passes input through to the real command', async () => {
    const input = JSON.stringify({ prompt_cache: { warm: true, expires_at: 123 } });
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'bin', 'cli.js'), 'statusline-tap', '--', 'cat'], {
      env: env(), input, encoding: 'utf-8',
    });
    assert.equal(out, input);
    const snap = await readStatuslineSnapshot('%7', { dir: join(dir, 'claude-keep-going', 'statusline'), env: env() });
    assert.equal(snap.prompt_cache.expires_at, 123);
  });
  it('statusline-tap still renders when the input is not JSON', () => {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'bin', 'cli.js'), 'statusline-tap', '--', 'cat'], {
      env: env(), input: 'not json', encoding: 'utf-8',
    });
    assert.equal(out, 'not json');
  });
});
