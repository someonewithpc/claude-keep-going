// Idle compaction: send /compact when a session has finished its work and nobody is
// around, timed to land while the prompt cache is still warm.
//
// A compaction re-reads the whole context once. Done while the cache is warm, that read
// is billed at the cache-read rate. Left until the cache expires (an hour on Claude
// Code's subscription TTL, five minutes in overage), the next message re-sends all of it
// cold, and a compaction then costs the same cold read on top. So the default fires
// marginSeconds before prompt_cache.expires_at, taken from the statusline tap.
//
// Everything it needs comes from hook markers (src/markers.js) and the statusline
// snapshot (src/statusline.js). The only thing still read off the screen is whether the
// input box is empty, so a half-typed prompt is never submitted with /compact glued on.

import { turnState, isSettled } from './markers.js';
import { cacheExpiresAtMs, contextPercent, contextTokens } from './statusline.js';

const REQUEST_MAX_AGE_MS = 24 * 3600_000;
const LAST_MESSAGE_PATTERN = /(^|[^\w/])\/compact\b/;

export function createCompactState() {
  return {
    idleSince: null,       // ts of the stop marker for the idle period being considered
    handledStop: null,     // stop ts already acted on (sent, skipped cold), never retried
    scheduledFor: null,    // stop ts a compact-scheduled was reported for
    fireAt: null,
    sentAt: null,
    confirmed: false,
    lastSentAt: 0,
    lastMatchedMessage: null,
    trigger: null,
    lastBlocked: null,
  };
}

function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// start <= now < end in local time; a window like 22:00-06:00 wraps past midnight.
export function inWindow(window, date = new Date()) {
  if (!window) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

// What would make this idle period compact, or null.
export function compactTrigger({ config, stop, request, snapshot, lastMatchedMessage, now }) {
  const c = config.compact;
  if ((c.trigger === 'request' || c.trigger === 'both')
      && request && request.action === 'compact' && now - request.ts < REQUEST_MAX_AGE_MS) {
    return { kind: 'request', focus: request.focus || c.focus };
  }
  if (c.trigger === 'policy' || c.trigger === 'both') {
    const pct = contextPercent(snapshot);
    const tokens = contextTokens(snapshot);
    const pctOk = pct !== null && pct >= c.minContextPercent;
    const tokensOk = c.minContextTokens === null || (tokens !== null && tokens >= c.minContextTokens);
    if (pctOk && tokensOk) return { kind: 'policy', focus: c.focus, percent: pct, tokens };
  }
  if (c.matchLastMessage && stop?.last && stop.last !== lastMatchedMessage && LAST_MESSAGE_PATTERN.test(stop.last)) {
    return { kind: 'last-message', focus: c.focus };
  }
  return null;
}

// When to send: before the cache expires, or a fixed delay after the turn ended.
export function compactFireAt({ config, stop, snapshot }) {
  const s = config.compact.settle;
  const expires = cacheExpiresAtMs(snapshot);
  if (s.mode === 'before-expiry' && expires !== null) return expires - s.marginSeconds * 1000;
  return stop.ts + s.minutes * 60_000;
}

function isCold(snapshot, now) {
  const pc = snapshot?.prompt_cache;
  if (!pc) return false;
  if (pc.warm === false) return true;
  return typeof pc.expires_at === 'number' && now >= pc.expires_at * 1000;
}

// One monitor tick's worth of compaction. Returns a result label, or null when there is
// nothing to say. `io` supplies markers, the statusline snapshot, tmux client activity,
// the input-box check and sending; see startMonitor for the real one.
export async function compactTick(cs, io, config, now = Date.now()) {
  const c = config.compact;
  if (!c || !c.enabled) return null;

  // Report how the last compaction went before looking for a new one.
  if (cs.sentAt && !cs.confirmed) {
    const done = await io.readMarker('compact');
    if (done && done.ts >= cs.sentAt) {
      cs.confirmed = true;
      return 'compact-confirmed';
    }
    if (now - cs.sentAt > c.confirmMinutes * 60_000) {
      cs.confirmed = true;
      return 'compact-unconfirmed';
    }
  }

  const [stop, prompt] = await Promise.all([io.readMarker('stop'), io.readMarker('prompt')]);
  if (turnState({ stop, prompt }) !== 'idle') { cs.idleSince = null; return null; }
  if (cs.idleSince !== stop.ts) { cs.idleSince = stop.ts; cs.fireAt = null; }
  if (cs.handledStop === stop.ts) return null;
  if (!isSettled(stop, { waitForAgents: c.waitForAgents })) return null;

  const notify = await io.readMarker('notify');
  if (notify && notify.ts > stop.ts && notify.type === 'permission_prompt') return null;
  if (now - cs.lastSentAt < c.minIntervalMinutes * 60_000) return null;

  const [request, snapshot] = await Promise.all([io.readMarker('request'), io.readStatusline()]);
  const trigger = compactTrigger({ config, stop, request, snapshot, lastMatchedMessage: cs.lastMatchedMessage, now });
  if (!trigger) return null;
  if (!inWindow(c.window, new Date(now))) return null;
  if (c.awayMinutes !== null) {
    const activity = await io.clientActivity();
    // activity: epoch seconds of the latest input from any client on this session,
    // null when no client is attached (which counts as away).
    if (activity !== null && now - activity * 1000 < c.awayMinutes * 60_000) return null;
  }

  if (isCold(snapshot, now)) {
    cs.handledStop = stop.ts;
    return 'compact-skipped-cold';
  }

  const fireAt = compactFireAt({ config, stop, snapshot });
  cs.fireAt = fireAt;
  cs.trigger = trigger;
  if (now < fireAt) {
    if (cs.scheduledFor === stop.ts) return null;
    cs.scheduledFor = stop.ts;
    return 'compact-scheduled';
  }

  // Both can last a while (vim in the pane, a half-typed prompt); report each once.
  const blocked = !(await io.isForeground()) ? 'compact-not-foreground'
    : !(await io.inputEmpty()) ? 'compact-input-busy' : null;
  if (blocked) {
    const key = `${blocked}:${stop.ts}`;
    if (cs.lastBlocked === key) return null;
    cs.lastBlocked = key;
    return blocked;
  }

  await io.send(trigger.focus ? `/compact ${trigger.focus}` : '/compact');
  if (trigger.kind === 'request') await io.clearMarker('request');
  if (trigger.kind === 'last-message') cs.lastMatchedMessage = stop.last;
  cs.handledStop = stop.ts;
  cs.sentAt = now;
  cs.lastSentAt = now;
  cs.confirmed = false;
  return 'compact-sent';
}
