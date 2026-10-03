import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processOneTick, createMonitorState } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { fullWindowReset } from '../src/statusline.js';

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

describe('statusline reset correction', () => {
  it('replaces a fallback wait with the reset of the full window', async () => {
    const s = createMonitorState();
    s.status = 'waiting';
    s._waitIsFallback = true;
    s.waitUntil = Date.now() + 5 * 3600_000;
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 86400;
    // No reset time on screen (the case a fallback wait comes from), so only the
    // statusline can correct it; a banner with a time would win.
    const a = adapter({ pane: '', statusline: { rate_limits: { five_hour: { used_percentage: 40, resets_at: resetsAt - 86400 }, seven_day: { used_percentage: 100, resets_at: resetsAt } } } });
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'wait-corrected');
    assert.equal(s.waitUntil, resetsAt * 1000 + DEFAULT_CONFIG.marginSeconds * 1000);
    assert.match(s.lastRateLimitMessage, /seven_day/);
    assert.equal(s._waitIsFallback, false);
  });

  it('leaves a wait from a real banner alone', async () => {
    const s = createMonitorState();
    s.status = 'waiting';
    s._waitIsFallback = false;
    const until = Date.now() + 3600_000;
    s.waitUntil = until;
    const a = adapter({ statusline: { rate_limits: { seven_day: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 86400 } } } });
    assert.equal(await processOneTick(s, a, '%0', cfg(), () => true), 'waiting');
    assert.equal(s.waitUntil, until);
  });

  it('fullWindowReset picks the later of several full windows', () => {
    assert.deepEqual(fullWindowReset({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 10 }, seven_day: { used_percentage: 101, resets_at: 20 } } }), { window: 'seven_day', resetsAt: 20_000 });
    assert.equal(fullWindowReset({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 10 } } }), null);
    assert.equal(fullWindowReset(null), null);
  });
});

