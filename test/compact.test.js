import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompactState, compactTick, inWindow, compactFireAt } from '../src/compact.js';
import { inputBoxEmpty } from '../src/patterns.js';
import { DEFAULT_CONFIG, DEFAULT_COMPACT, loadConfig } from '../src/config.js';
import { processOneTick, createMonitorState } from '../src/monitor.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = 1_800_000_000_000;
const MIN = 60_000;

function cfg(compact = {}) {
  return { ...DEFAULT_CONFIG, compact: { ...DEFAULT_COMPACT, enabled: true, ...compact, settle: { ...DEFAULT_COMPACT.settle, ...(compact.settle || {}) } } };
}

const settledStop = (ts = NOW - MIN) => ({ ts, background: 0, crons: 0, hasBackgroundInfo: true, last: 'All done.' });

function fakeIo({ markers = {}, snapshot = null, activity = null, foreground = true, inputEmpty = true } = {}) {
  const io = {
    sent: [], cleared: [], markers: { ...markers },
    readMarker: async (k) => io.markers[k] ?? null,
    clearMarker: async (k) => { io.cleared.push(k); delete io.markers[k]; },
    readStatusline: async () => snapshot,
    clientActivity: async () => activity,
    isForeground: async () => foreground,
    inputEmpty: async () => inputEmpty,
    send: async (t) => { io.sent.push(t); },
  };
  return io;
}

const warm = (expiresInMs) => ({ prompt_cache: { warm: true, expires_at: (NOW + expiresInMs) / 1000 }, context_window: { used_percentage: 60 } });

describe('compactTick', () => {
  it('does nothing when disabled', async () => {
    const io = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } } });
    assert.equal(await compactTick(createCompactState(), io, cfg({ enabled: false }), NOW), null);
  });

  it('waits until five minutes before the cache expires, then sends /compact once', async () => {
    const cs = createCompactState();
    const io = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact', focus: 'keep the TODO list' } }, snapshot: warm(30 * MIN) });
    assert.equal(await compactTick(cs, io, cfg(), NOW), 'compact-scheduled');
    assert.equal(cs.fireAt, NOW + 25 * MIN);
    assert.equal(await compactTick(cs, io, cfg(), NOW + MIN), null);
    assert.equal(await compactTick(cs, io, cfg(), NOW + 25 * MIN), 'compact-sent');
    assert.deepEqual(io.sent, ['/compact keep the TODO list']);
    assert.deepEqual(io.cleared, ['request']);
    assert.equal(await compactTick(cs, io, cfg(), NOW + 25 * MIN + 1000), null);
    assert.equal(io.sent.length, 1);
  });

  it('confirms when the PostCompact marker arrives', async () => {
    const cs = createCompactState();
    const io = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(cs, io, cfg(), NOW), 'compact-sent');
    io.markers.compact = { ts: NOW + 20_000 };
    assert.equal(await compactTick(cs, io, cfg(), NOW + 30_000), 'compact-confirmed');
  });

  it('warns once when no PostCompact marker arrives', async () => {
    const cs = createCompactState();
    const io = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2) });
    await compactTick(cs, io, cfg(), NOW);
    assert.equal(await compactTick(cs, io, cfg(), NOW + 6 * MIN), 'compact-unconfirmed');
    assert.equal(await compactTick(cs, io, cfg(), NOW + 7 * MIN), null);
  });

  it('falls back to a fixed delay after the turn without a statusline snapshot', async () => {
    const cs = createCompactState();
    const io = fakeIo({ markers: { stop: settledStop(NOW), request: { ts: NOW - MIN, action: 'compact' } } });
    assert.equal(await compactTick(cs, io, cfg(), NOW), 'compact-scheduled');
    assert.equal(cs.fireAt, NOW + 4 * MIN);
  });

  it('uses the fixed delay when asked to', () => {
    const at = compactFireAt({ config: cfg({ settle: { mode: 'fixed', minutes: 55 } }), stop: { ts: NOW }, snapshot: warm(60 * MIN) });
    assert.equal(at, NOW + 55 * MIN);
  });

  it('waits while a turn is running', async () => {
    const io = fakeIo({ markers: { stop: settledStop(NOW - 5 * MIN), prompt: { ts: NOW - MIN }, request: { ts: NOW - 6 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(createCompactState(), io, cfg(), NOW), null);
    assert.deepEqual(io.sent, []);
  });

  it('waits while scheduled wakeups are pending or hook info is missing', async () => {
    for (const stop of [{ ...settledStop(), crons: 1 }, { ...settledStop(), hasBackgroundInfo: false }]) {
      const io = fakeIo({ markers: { stop, request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2) });
      assert.equal(await compactTick(createCompactState(), io, cfg(), NOW), null);
    }
  });

  it('ignores running background agents when waitForAgents is off', async () => {
    const stop = { ...settledStop(), background: 2 };
    const run = (c) => compactTick(createCompactState(), fakeIo({ markers: { stop, request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2) }), cfg(c), NOW);
    assert.equal(await run({}), null);
    assert.notEqual(await run({ waitForAgents: false }), null);
  });

  it('waits while a permission prompt is open', async () => {
    const io = fakeIo({ markers: { stop: settledStop(), notify: { ts: NOW - 10_000, type: 'permission_prompt' }, request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(createCompactState(), io, cfg(), NOW), null);
  });

  it('needs a trigger', async () => {
    const io = fakeIo({ markers: { stop: settledStop() }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(createCompactState(), io, cfg(), NOW), null);
  });

  it('compacts on context size with the policy trigger', async () => {
    const io = fakeIo({ markers: { stop: settledStop() }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(createCompactState(), io, cfg({ trigger: 'policy', minContextPercent: 50 }), NOW), 'compact-sent');
    const small = fakeIo({ markers: { stop: settledStop() }, snapshot: { ...warm(MIN / 2), context_window: { used_percentage: 20 } } });
    assert.equal(await compactTick(createCompactState(), small, cfg({ trigger: 'policy', minContextPercent: 50 }), NOW), null);
  });

  it('requires minContextTokens when set', async () => {
    const snap = (n) => ({ ...warm(MIN / 2), context_window: { used_percentage: 15, current_usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: n } } });
    const c = cfg({ trigger: 'policy', minContextPercent: 0, minContextTokens: 100_000 });
    assert.equal(await compactTick(createCompactState(), fakeIo({ markers: { stop: settledStop() }, snapshot: snap(150_000) }), c, NOW), 'compact-sent');
    assert.equal(await compactTick(createCompactState(), fakeIo({ markers: { stop: settledStop() }, snapshot: snap(50_000) }), c, NOW), null);
  });

  it('acts on a last message asking for /compact only when enabled, and once per message', async () => {
    const stop = { ...settledStop(), last: 'The session is at a clean point. Please run /compact now.' };
    const off = fakeIo({ markers: { stop }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(createCompactState(), off, cfg(), NOW), null);
    const cs = createCompactState();
    const on = fakeIo({ markers: { stop }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(cs, on, cfg({ matchLastMessage: true, minIntervalMinutes: 0 }), NOW), 'compact-sent');
    on.markers.stop = { ...stop, ts: NOW + MIN };
    assert.equal(await compactTick(cs, on, cfg({ matchLastMessage: true, minIntervalMinutes: 0 }), NOW + 2 * MIN), null);
  });

  it('does not match a path that merely contains /compact', async () => {
    const stop = { ...settledStop(), last: 'Edited src/compact.js and tests.' };
    const io = fakeIo({ markers: { stop }, snapshot: warm(MIN / 2) });
    assert.equal(await compactTick(createCompactState(), io, cfg({ matchLastMessage: true }), NOW), null);
  });

  it('respects the time window', async () => {
    const io = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2) });
    const hour = new Date(NOW).getHours();
    const outside = { start: `${String((hour + 2) % 24).padStart(2, '0')}:00`, end: `${String((hour + 3) % 24).padStart(2, '0')}:00` };
    assert.equal(await compactTick(createCompactState(), io, cfg({ window: outside }), NOW), null);
    const inside = { start: `${String(hour).padStart(2, '0')}:00`, end: `${String((hour + 1) % 24).padStart(2, '0')}:00` };
    assert.equal(await compactTick(createCompactState(), io, cfg({ window: inside }), NOW), 'compact-sent');
  });

  it('waits while someone is typing in an attached client', async () => {
    const recent = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2), activity: (NOW - 5 * MIN) / 1000 });
    assert.equal(await compactTick(createCompactState(), recent, cfg({ awayMinutes: 30 }), NOW), null);
    const detached = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2), activity: null });
    assert.equal(await compactTick(createCompactState(), detached, cfg({ awayMinutes: 30 }), NOW), 'compact-sent');
  });

  it('skips once the cache has gone cold', async () => {
    const cs = createCompactState();
    const io = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: { prompt_cache: { warm: false } } });
    assert.equal(await compactTick(cs, io, cfg(), NOW), 'compact-skipped-cold');
    assert.equal(await compactTick(cs, io, cfg(), NOW + MIN), null);
    assert.deepEqual(io.sent, []);
  });

  it('reports a busy input box once and sends when it clears', async () => {
    const cs = createCompactState();
    const io = fakeIo({ markers: { stop: settledStop(), request: { ts: NOW - 2 * MIN, action: 'compact' } }, snapshot: warm(MIN / 2), inputEmpty: false });
    assert.equal(await compactTick(cs, io, cfg(), NOW), 'compact-input-busy');
    assert.equal(await compactTick(cs, io, cfg(), NOW + 5000), null);
    io.inputEmpty = async () => true;
    assert.equal(await compactTick(cs, io, cfg(), NOW + 10_000), 'compact-sent');
  });

  it('leaves at least minIntervalMinutes between compactions', async () => {
    const cs = createCompactState();
    const io = fakeIo({ markers: { stop: settledStop() }, snapshot: warm(MIN / 2) });
    const c = cfg({ trigger: 'policy', minContextPercent: 10 });
    assert.equal(await compactTick(cs, io, c, NOW), 'compact-sent');
    io.markers.stop = settledStop(NOW + 2 * MIN);
    io.markers.compact = { ts: NOW + MIN };
    await compactTick(cs, io, c, NOW + 3 * MIN);   // confirmation
    assert.equal(await compactTick(cs, io, c, NOW + 4 * MIN), null);
    assert.equal(io.sent.length, 1);
  });
});

describe('inWindow', () => {
  const at = (h, m = 0) => new Date(2026, 9, 3, h, m);
  it('handles a same-day window', () => {
    assert.equal(inWindow({ start: '01:00', end: '07:00' }, at(3)), true);
    assert.equal(inWindow({ start: '01:00', end: '07:00' }, at(7)), false);
  });
  it('handles a window past midnight', () => {
    assert.equal(inWindow({ start: '22:00', end: '06:00' }, at(23, 30)), true);
    assert.equal(inWindow({ start: '22:00', end: '06:00' }, at(5, 59)), true);
    assert.equal(inWindow({ start: '22:00', end: '06:00' }, at(12)), false);
  });
});

describe('inputBoxEmpty', () => {
  const R = '─'.repeat(40);
  it('reads a real idle capture from Claude Code 2.1.287', () => {
    assert.equal(inputBoxEmpty(readFileSync(join(FIXTURES, 'pane-idle-input-2.1.287.txt'), 'utf-8')), true);
  });
  it('sees typed text, including on a second line', () => {
    assert.equal(inputBoxEmpty([R, '❯ half a prompt', R].join('\n')), false);
    assert.equal(inputBoxEmpty([R, '❯ ', '  second line', R].join('\n')), false);
  });
  it('is false when there is no input box', () => {
    assert.equal(inputBoxEmpty('just some output'), false);
  });
});

describe('compact config', () => {
  it('is off by default', () => assert.equal(DEFAULT_CONFIG.compact.enabled, false));
  it('falls back to defaults for bad values', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'ckg-compact-cfg-'));
    await writeFile(join(dir, 'c.json'), JSON.stringify({ compact: { enabled: true, trigger: 'sometimes', window: { start: '25:00', end: '07:00' }, settle: { mode: 'fixed', minutes: 55 } } }));
    const c = (await loadConfig(join(dir, 'c.json'))).compact;
    await rm(dir, { recursive: true });
    assert.equal(c.enabled, true);
    assert.equal(c.trigger, 'request');
    assert.equal(c.window, null);
    assert.deepEqual(c.settle, { mode: 'fixed', marginSeconds: 300, minutes: 55 });
  });
});

describe('monitor integration', () => {
  it('sends /compact from processOneTick when idle compaction is due', async () => {
    const R = '─'.repeat(40);
    const sent = [];
    const markers = { stop: settledStop(Date.now() - MIN), request: { ts: Date.now() - 2 * MIN, action: 'compact' } };
    const adapter = {
      capturePane: async () => ['● Done.', '', R, '❯ ', R, '  status'].join('\n'),
      getPaneCommand: async () => 'node',
      isClaudeForeground: async () => true,
      sendKeys: async (_p, t) => { sent.push(t); },
      readMarker: async (k) => markers[k] ?? null,
      clearMarker: async (k) => { delete markers[k]; },
      readStatusline: async () => ({ prompt_cache: { warm: true, expires_at: Date.now() / 1000 + 30 } }),
    };
    const result = await processOneTick(createMonitorState(), adapter, '%0', cfg(), () => true);
    assert.equal(result, 'compact-sent');
    assert.deepEqual(sent, ['/compact']);
  });
});
