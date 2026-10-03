import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  injectWrapper, removeWrapper, mergeStopFailureHook, hookCommandPrefix, MARKER_START, MARKER_END,
  LEGACY_MARKER_START, LEGACY_MARKER_END, renderReconcileUnit, renderReconcilePlist,
  stopFailureHookEntry, shouldWriteEvent,
} from '../bin/cli.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Finding 7: the generated systemd unit was fragile — unquoted ExecStart paths broke
//     on spaces, and Persistent=true is a no-op on a monotonic (OnUnitActiveSec) timer. ---
describe('renderReconcileUnit (Finding 7)', () => {
  it('substitutes into the quoted ExecStart so a path with spaces survives', () => {
    const out = renderReconcileUnit(
      'ExecStart="__NODE_PATH__" "__CLI_PATH__" reconcile\n',
      '/home/a b/.nvm/node', '/home/a b/cli.js',
    );
    assert.match(out, /ExecStart="\/home\/a b\/\.nvm\/node" "\/home\/a b\/cli\.js" reconcile/);
    assert.ok(!out.includes('__NODE_PATH__') && !out.includes('__CLI_PATH__'));
  });
  it('the shipped .service template quotes the ExecStart placeholders', async () => {
    const svc = await readFile(join(REPO_ROOT, 'systemd', 'claude-keep-going-reconcile.service'), 'utf-8');
    assert.match(svc, /ExecStart="__NODE_PATH__" "__CLI_PATH__" reconcile/);
  });
  it('the shipped .timer template has no no-op Persistent=true', async () => {
    const timer = await readFile(join(REPO_ROOT, 'systemd', 'claude-keep-going-reconcile.timer'), 'utf-8');
    assert.ok(!/Persistent\s*=\s*true/.test(timer));
  });
});

describe('renderReconcilePlist (macOS launchd)', () => {
  it('substitutes and XML-escapes the node/CLI paths', () => {
    const out = renderReconcilePlist(
      '<string>__NODE_PATH__</string><string>__CLI_PATH__</string>',
      '/Users/a&b/.nvm/node', '/Users/a<b>/cli.js',
    );
    assert.equal(out, '<string>/Users/a&amp;b/.nvm/node</string><string>/Users/a&lt;b&gt;/cli.js</string>');
    assert.ok(!out.includes('__NODE_PATH__') && !out.includes('__CLI_PATH__'));
  });
  it('the shipped plist template has the placeholders and detaches monitors from the job', async () => {
    const plist = await readFile(join(REPO_ROOT, 'launchd', 'com.claude-keep-going.reconcile.plist'), 'utf-8');
    assert.match(plist, /<string>__NODE_PATH__<\/string>\s*<string>__CLI_PATH__<\/string>\s*<string>reconcile<\/string>/);
    // Same reason the systemd unit needs KillMode=process: without it the short-lived
    // reconcile job's exit reaps the freshly-armed detached monitors.
    assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  });
  it('the shipped plist sets a PATH that reaches a Homebrew tmux', async () => {
    // launchd jobs get only the system default PATH; without both Homebrew prefixes
    // reconcile dies with `spawn tmux ENOENT` on every timer fire.
    const plist = await readFile(join(REPO_ROOT, 'launchd', 'com.claude-keep-going.reconcile.plist'), 'utf-8');
    assert.match(plist, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*\/usr\/local\/bin[^<]*<\/string>/);
  });
});

describe('package.json files whitelist (Finding 1)', () => {
  it('includes systemd/ so install-timer works from an npm install', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('systemd/'), 'package.json "files" must include "systemd/"');
  });
  it('includes launchd/ so install-timer works from an npm install on macOS', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('launchd/'), 'package.json "files" must include "launchd/"');
  });
});

describe('injectWrapper', () => {
  const testFile = join(tmpdir(), `car-rc-test-${Date.now()}`);
  afterEach(async () => { try { await unlink(testFile); } catch {} });

  it('adds wrapper to empty file', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.includes('/path/to/launcher.js'));
  });
  it('unaliases claude before defining the wrapper function (#10)', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    const unaliasIdx = content.indexOf('unalias claude');
    const fnIdx = content.indexOf('\nclaude() {');
    assert.ok(unaliasIdx !== -1, 'wrapper should unalias claude');
    assert.ok(unaliasIdx < fnIdx, 'unalias must come before the function definition');
  });
  it('adds wrapper to file with existing content', async () => {
    await writeFile(testFile, 'export PATH=$HOME/bin:$PATH\n');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('export PATH'));
    assert.ok(content.includes(MARKER_START));
  });
  it('replaces existing wrapper', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nold stuff\n${MARKER_END}\nafter\n`);
    await injectWrapper(testFile, '/new/path/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('/new/path'));
    assert.ok(!content.includes('old stuff'));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
  it('removes a claude-auto-retry block and reports it', async () => {
    await writeFile(testFile, `before\n${LEGACY_MARKER_START}\nclaude() { old; }\n${LEGACY_MARKER_END}\nafter\n`);
    const result = await injectWrapper(testFile, '/new/path/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.equal(result.replacedLegacy, true);
    assert.ok(!content.includes(LEGACY_MARKER_START));
    assert.ok(!content.includes('claude() { old; }'));
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
  it('reports no legacy block when there is none', async () => {
    await writeFile(testFile, 'before\n');
    const result = await injectWrapper(testFile, '/new/path/launcher.js');
    assert.equal(result.replacedLegacy, false);
  });
});

describe('mergeStopFailureHook', () => {
  const entry = { matcher: 'overloaded|server_error', hooks: [{ type: 'command', command: '/new/bin/claude-keep-going _stopfailure-hook', timeout: 5 }] };

  it('replaces an entry written by claude-auto-retry', () => {
    const old = { matcher: 'overloaded|server_error', hooks: [{ type: 'command', command: 'node /nix/store/x-claude-auto-retry-0.7.3/lib/claude-auto-retry/bin/cli.js _stopfailure-hook', timeout: 5 }] };
    assert.deepEqual(mergeStopFailureHook([old], entry), [entry]);
  });
  it('keeps unrelated entries', () => {
    const other = { matcher: 'rate_limit', hooks: [{ type: 'command', command: 'notify-send limit' }] };
    assert.deepEqual(mergeStopFailureHook([other], entry), [other, entry]);
  });
  it('is idempotent', () => {
    assert.deepEqual(mergeStopFailureHook(mergeStopFailureHook([], entry), entry), [entry]);
  });
});

describe('hookCommandPrefix', () => {
  it('uses the packaged entry point when CLAUDE_KEEP_GOING_BIN is set', () => {
    assert.equal(hookCommandPrefix({ CLAUDE_KEEP_GOING_BIN: '/nix/store/x/bin/claude-keep-going' }, '/usr/bin/node', '/x/cli.js'),
      '"/nix/store/x/bin/claude-keep-going"');
  });
  it('pins the node binary otherwise, instead of relying on PATH', () => {
    assert.equal(hookCommandPrefix({}, '/home/u/.nvm/node', '/home/u/lib/cli.js'), '"/home/u/.nvm/node" "/home/u/lib/cli.js"');
  });
});

describe('removeWrapper', () => {
  const testFile = join(tmpdir(), `car-rm-test-${Date.now()}`);
  afterEach(async () => { try { await unlink(testFile); } catch {} });

  it('removes wrapper and preserves surrounding content', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nwrapper stuff\n${MARKER_END}\nafter\n`);
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.ok(!content.includes(MARKER_START));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
  it('does nothing when no wrapper present', async () => {
    await writeFile(testFile, 'just normal content\n');
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.equal(content, 'just normal content\n');
  });
});

describe('stopFailureHookEntry', () => {
  it('matcher includes rate_limit alongside the overload classes', () => {
    assert.match(stopFailureHookEntry().matcher, /\brate_limit\b/);
    assert.match(stopFailureHookEntry().matcher, /\boverloaded\b/);
    assert.match(stopFailureHookEntry().matcher, /\bserver_error\b/);
  });
});

describe('shouldWriteEvent', () => {
  it('accepts the overload classes and rate_limit', () => {
    for (const e of ['overloaded', 'server_error', 'rate_limit']) {
      assert.equal(shouldWriteEvent(e), true, e);
    }
  });
  it('rejects permanent/unknown classes', () => {
    for (const e of ['billing_error', 'invalid_request', '', undefined]) {
      assert.equal(shouldWriteEvent(e), false, String(e));
    }
  });
});
