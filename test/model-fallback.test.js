import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processOneTick, createMonitorState } from '../src/monitor.js';
import { DEFAULT_CONFIG, DEFAULT_MODEL_FALLBACK } from '../src/config.js';
import { scopedModelFromBanner, fallbackTarget } from '../src/model-fallback.js';

const R = '─'.repeat(40);
const OPUS_BANNER = "You've hit your Opus limit · resets Oct 9, 10am (UTC)";
const idlePane = (above) => [above, '', R, '❯ ', R, '  status'].join('\n');

const cfg = (mf = {}) => ({ ...DEFAULT_CONFIG, modelFallback: { ...DEFAULT_MODEL_FALLBACK, enabled: true, ...mf } });

function adapter(pane, markers = {}) {
  const a = {
    _sent: [], pane, markers: { ...markers },
    capturePane: async () => a.pane,
    getPaneCommand: async () => 'node',
    isClaudeForeground: async () => true,
    sendKeys: async (_p, t) => { a._sent.push(t); },
    readMarker: async (k) => a.markers[k] ?? null,
    clearMarker: async () => {},
    readStatusline: async () => ({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } }),
  };
  return a;
}

describe('scopedModelFromBanner', () => {
  it('names the model of a model-scoped limit', () => {
    assert.equal(scopedModelFromBanner(OPUS_BANNER), 'Opus');
    assert.equal(scopedModelFromBanner("You’ve hit your Sonnet limit · resets 3pm"), 'Sonnet');
  });
  it('is null for limits that cover every model', () => {
    for (const b of ["You've hit your session limit · resets 2am", "You've hit your weekly limit · resets Oct 9", "You've hit your limit · resets 3pm", "You've hit your monthly spend limit."]) {
      assert.equal(scopedModelFromBanner(b), null, b);
    }
  });
  it('maps without regard to case, only when enabled', () => {
    assert.equal(fallbackTarget(cfg({ map: { opus: 'sonnet' } }), 'Opus'), 'sonnet');
    assert.equal(fallbackTarget(cfg({ enabled: false }), 'Opus'), null);
    assert.equal(fallbackTarget(cfg(), 'Sonnet'), null);
  });
});

describe('model fallback in the monitor', () => {
  it('switches model, continues once the switch is confirmed, and ignores the old banner', async () => {
    const s = createMonitorState();
    const a = adapter(idlePane(OPUS_BANNER));
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'model-fallback-switched');
    assert.deepEqual(a._sent, ['/model sonnet']);
    assert.equal(s.fallback.original, 'claude-opus-5-5');
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'fallback-waiting');
    a.markers.model = { ts: Date.now() + 1, from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' };
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'model-fallback-continued');
    assert.equal(a._sent[1], DEFAULT_CONFIG.retryMessage);
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'monitoring');
    assert.equal(a._sent.length, 2);
  });

  it('continues after 10 s without the hook', async () => {
    const s = createMonitorState();
    const a = adapter(idlePane(OPUS_BANNER));
    await processOneTick(s, a, '%0', cfg(), () => true);
    s.fallback.switchedAt = Date.now() - 11_000;
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'model-fallback-continued');
    assert.equal(s.fallback.confirmed, false);
  });

  it('switches back at an idle prompt once the limit has reset', async () => {
    const s = createMonitorState();
    const a = adapter(idlePane(OPUS_BANNER));
    await processOneTick(s, a, '%0', cfg(), () => true);
    s.fallback.switchedAt = Date.now() - 11_000;
    await processOneTick(s, a, '%0', cfg(), () => true);
    a.pane = idlePane('● All done.');
    a.markers.stop = { ts: Date.now() };
    s.fallback.resetAt = Date.now() - 1;
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'model-fallback-restored');
    assert.equal(a._sent.at(-1), '/model claude-opus-5-5');
    assert.equal(s.fallback.active, false);
  });

  it('does not switch back while a turn is running', async () => {
    const s = createMonitorState();
    s.fallback = { active: true, from: 'Opus', to: 'sonnet', original: 'opus', resetAt: Date.now() - 1, switchedAt: 0 };
    const a = adapter(idlePane('● working'), { stop: { ts: 1 }, prompt: { ts: 2 } });
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'monitoring');
    assert.deepEqual(a._sent, []);
  });

  it('waits as usual for a limit that covers every model, or when disabled', async () => {
    const weekly = adapter(idlePane("You've hit your weekly limit · resets Oct 9, 10am (UTC)"));
    assert.equal(await processOneTick(createMonitorState(), weekly, '%0', cfg(), () => true), 'waiting');
    const off = adapter(idlePane(OPUS_BANNER));
    assert.equal(await processOneTick(createMonitorState(), off, '%0', cfg({ enabled: false }), () => true), 'waiting');
    assert.deepEqual([...weekly._sent, ...off._sent], []);
  });
});
