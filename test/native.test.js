import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processOneTick, createMonitorState } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const BANNER = "You've hit your limit · resets 3pm (UTC)";
const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over });

function adapter({ markers = {}, statusline = null, pane = BANNER } = {}) {
  const a = {
    _sent: [],
    capturePane: async () => pane,
    getPaneCommand: async () => 'node',
    isClaudeForeground: async () => true,
    sendKeys: async (_p, t) => { a._sent.push(t); },
    readMarker: async (k) => a.markers[k] ?? null,
    clearMarker: async () => {},
    readStatusline: async () => statusline,
    markers: { ...markers },
  };
  return a;
}

// A usage wait that has just expired.
function expiredWait(enteredAgoMs = 3600_000) {
  const s = createMonitorState();
  s.status = 'waiting';
  s.waitEnteredAt = Date.now() - enteredAgoMs;
  s.waitUntil = Date.now() - 1000;
  return s;
}

const hooksSeen = () => ({ stop: { ts: Date.now() - 3600_000, background: 0, crons: 0, hasBackgroundInfo: true } });

describe('deferring to Claude Code auto-continue', () => {
  it('waits out the grace period once, then sends and notes that native missed', async () => {
    const s = expiredWait();
    const a = adapter({ markers: hooksSeen() });
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'native-grace');
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'waiting');
    assert.deepEqual(a._sent, []);
    s.waitUntil = Date.now() - 181_000;
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'retried');
    assert.equal(s._nativeOutcome, 'missed');
    assert.equal(a._sent.length, 1);
  });

  it('stands down when native resumed the session', async () => {
    const s = expiredWait();
    const a = adapter({ markers: { ...hooksSeen(), notify: { ts: Date.now() - 500, type: 'quota_auto_resume_fired' }, prompt: { ts: Date.now() - 400 } } });
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'native-resumed');
    assert.equal(s.status, 'monitoring');
    assert.deepEqual(a._sent, []);
  });

  it('sends at once when native reports it gave up', async () => {
    for (const type of ['quota_auto_resume_stale', 'quota_auto_resume_disabled']) {
      const s = expiredWait();
      const a = adapter({ markers: { ...hooksSeen(), notify: { ts: Date.now() - 500, type } } });
      assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'retried', type);
      assert.equal(s._nativeOutcome, type);
    }
  });

  it('sends at once without hooks, or with native set to ignore', async () => {
    const noHooks = adapter();
    assert.equal(await processOneTick(expiredWait(), noHooks, '%0', cfg(), () => true), 'retried');
    const ignore = adapter({ markers: hooksSeen() });
    assert.equal(await processOneTick(expiredWait(), ignore, '%0', cfg({ native: { usageLimit: 'ignore', graceSeconds: 180 } }), () => true), 'retried');
  });

  it('ignores a prompt from before the wait began', async () => {
    const s = expiredWait();
    const a = adapter({ markers: { ...hooksSeen(), prompt: { ts: Date.now() - 7200_000 } } });
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'native-grace');
  });
});
