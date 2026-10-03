import { readFile } from 'node:fs/promises';
import { PATHS } from './paths.js';

// Transient API-error backoff (529 Overloaded / 500 / 503). Separate block from
// the usage-limit knobs above: those wait in *hours* until a reset, these wait in
// *seconds* on an exponential backoff. See README "Overload backoff".
export const DEFAULT_OVERLOAD = {
  enabled: true,
  // Anchored to Claude Code's actual TERMINAL error render — NOT bare status numbers.
  // A bare "503"/"529" matches ordinary code (res.status(503)), ports, byte counts and
  // quoted logs, which is what caused false "Continue where you left off." injections.
  // Matched as case-insensitive regexes against only the pane tail (see detectOverload).
  //
  // Claude Code (verified against the v2.1.x binary) has TWO render forms:
  //   terminal (retries exhausted):  "API Error: 529 {…}"  / "API Error: 503 no healthy upstream"
  //   transient (still retrying):     "API Error (529 …) · Retrying in 5s · attempt 3/10"
  // We REQUIRE the colon form to skip the parens form, and the retry SUFFIX
  // ("· Retrying in…" / "attempt n/m") is separately suppressed by the working gate
  // in patterns.js — together they ensure we never interrupt Claude's own backoff.
  patterns: [
    // Terminal error line. Covers the full retryable set (429+5xx) in the colon form.
    'API Error:\\s*(429|500|502|503|504|529)\\b',
    // JSON error.type for a sustained overload (survives the collapsed non-JSON render).
    'overloaded_error',
    // API-level 429 uses a dedicated render with no 3-digit code in the generic slot:
    //   "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
    'temporarily limiting requests',
  ],
  backoffSeconds: [30, 60, 120, 240, 300],
  steadyStateSeconds: 300,
  jitterPct: 15,
  maxTotalWaitMinutes: 120,
  // StopFailure event markers older than this are ignored (guards against a recycled
  // tmux pane id replaying a stale failure, or acting on a marker left while down).
  eventMaxAgeSeconds: 120,
  retryMessage: 'Continue where you left off.',
  // Gating: by default we only act when claude is alive at its prompt (the
  // foreground safety check passes). If a 500 ever drops you to the shell, the
  // send-keys is correctly blocked and nothing resumes; flip relaunchOnExit to
  // re-enter via relaunchCommand. Off by default — never type into a shell the
  // user may be using. See README "Gating decision".
  relaunchOnExit: false,
  relaunchCommand: 'claude --continue',
};

// Safeguard / AUP false-positive retry. Distinct from usage limits (hours) and overload
// (5xx, exponential): the model's safeguards flag a message — often a false positive, so
// an immediate re-send usually clears it. Bounded by maxRetries so a *sticky* flag can't
// loop forever. See README "Safeguard retry".
export const DEFAULT_SAFEGUARD = {
  enabled: true,
  // Case-insensitive regexes matched against the pane tail; a match only counts with an
  // `API Error` line nearby (see safeguardMatch) so quoting/discussing these phrases in
  // conversation can't trigger a retry. Match the stable phrases of the render, not the
  // model name (which varies).
  patterns: [
    "safeguards flagged this message",
    "can't respond to this request with",   // "Claude Code can't respond to this request with <model>"
    "legal/aup",                             // the AUP link Anthropic includes
  ],
  maxRetries: 3,          // small — if it keeps flagging, retrying won't help
  retryDelaySeconds: 8,   // brief pause between re-sends (semi-random flag; quick retry helps)
  retryMessage: 'continue',
};

// Interrupted-stream resume. A third failure family, distinct from usage limits (hours)
// and overload (5xx, exponential): Claude Code's byte watchdog aborted a stream mid-turn
// and finalized whatever had already been yielded. The turn is OVER — the prompt returns
// idle and nothing resumes it — so the session sits untouched until something is typed.
// Claude Code retries these by itself only while the response is still thinking-only; once
// real content has been yielded it declines to retry, which is precisely when this renders.
// A single "continue" picks the work back up. Bounded, because a machine that just woke may
// not have its network back yet and the resumed turn can fail the same way.
export const DEFAULT_STREAM_INTERRUPTED = {
  enabled: true,
  // Case-insensitive regexes matched against the pane tail, and only against a line that
  // BEGINS with the `API Error:` render (see streamInterruptedMatch). These phrases are
  // ordinary English about a common event, so the "anchor nearby" rule the safeguard and
  // overload families use is not enough here — a session explaining them quotes the whole
  // render, anchor included, mid-sentence.
  // The full set the stream finalizer emits, by cause:
  //   suspend      → "Your computer went to sleep {mid-response | before a response was produced}"
  //   idle timeout → "The response stopped arriving" / "The response stalled before …"
  //   connection   → "Connection lost {mid-response | before a response was produced}"
  //   server error → "Server error mid-response"
  // All seven leave the pane in the same truncated-turn state, so they share one remedy.
  patterns: [
    'went to sleep mid-response',
    'went to sleep before a response was produced',
    'response stopped arriving',
    'response stalled before a response was produced',
    'Connection lost mid-response',
    'Connection lost before a response was produced',
    'Server error mid-response',
  ],
  maxRetries: 2,          // small — if resuming keeps truncating, something else is wrong
  retryDelaySeconds: 5,   // let the network settle after a wake before typing
  retryMessage: 'continue',
};

// Near-limit wrap-up (#78). At ~95% of the 5-hour window Claude Code injects a checkpoint
// instruction into the model's context and prints "⏺ Approaching your 5-hour usage limit —
// Claude will wrap up the current step." The model finishes the step, lists what's left and
// ENDS THE TURN: no limit banner, an idle prompt, and nothing resumes the session — the
// window resets hours later with the session still parked. One nudge picks the work back
// up; the session then either finishes or hits the real limit, which the usage-wait
// handles. Not a bounded-retry machine like the families above: the nudge renders as a
// user row under the notice, which is the dedup — one nudge per notice, by construction.
// maxRetries only bounds the pathological case where the nudge never renders.
export const DEFAULT_NEAR_LIMIT_WRAP_UP = {
  enabled: true,
  maxRetries: 3,
  retryMessage: 'continue',
};

// Idle compaction: send /compact once a session has finished its work, while the prompt
// cache is still warm, so the next message doesn't re-send the whole context cold.
// Off by default. See src/compact.js.
export const DEFAULT_COMPACT = {
  enabled: false,
  // request: only when the model ran `claude-keep-going request compact`.
  // policy: whenever the context is at least minContextPercent full.
  // both: either.
  trigger: 'request',
  // {start: "01:00", end: "07:00"} in local time, may wrap past midnight. null: any time.
  window: null,
  // Only when no tmux client has had input for this many minutes (or none is attached).
  // null: don't check.
  awayMinutes: null,
  minContextPercent: 40,
  // before-expiry: marginSeconds before the statusline's prompt_cache.expires_at, falling
  // back to 4 minutes after the turn when that is unknown. fixed: minutes after the turn.
  settle: { mode: 'before-expiry', marginSeconds: 60, minutes: 4 },
  focus: '',
  // Also act when the last message mentions /compact (a model asking a person to run it).
  matchLastMessage: false,
  confirmMinutes: 5,
  minIntervalMinutes: 30,
};

// Claude Code's own usage-limit auto-continue (setting autoContinueAtUsageLimit, behind
// a server flag). defer: when the hooks are installed, give it graceSeconds past the
// reset to resume the session before sending our own continue; act at once if it
// reports that it gave up. ignore: behave as if it didn't exist.
export const DEFAULT_NATIVE = {
  usageLimit: 'defer',
  graceSeconds: 180,
};

// Before sending a continue after a wait, check that the API host accepts a TCP
// connection, since right after a resume from suspend the network is often not back
// yet. Gives up checking after maxWaitMinutes and sends anyway.
export const DEFAULT_NETWORK_CHECK = {
  enabled: true,
  host: 'api.anthropic.com',
  port: 443,
  maxWaitMinutes: 10,
};

export const DEFAULT_CONFIG = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
  overload: DEFAULT_OVERLOAD,
  safeguard: DEFAULT_SAFEGUARD,
  streamInterrupted: DEFAULT_STREAM_INTERRUPTED,
  nearLimitWrapUp: DEFAULT_NEAR_LIMIT_WRAP_UP,
  compact: DEFAULT_COMPACT,
  native: DEFAULT_NATIVE,
  networkCheck: DEFAULT_NETWORK_CHECK,
};


function validNumber(val, min, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

function clamp(val, lo, hi, fallback) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(hi, Math.max(lo, val));
}

function validateOverload(raw) {
  // Shallow-merge so a partial user block keeps the documented defaults for the
  // keys it omits (JSON.parse's spread would otherwise replace the whole block).
  const o = { ...DEFAULT_OVERLOAD, ...(raw && typeof raw === 'object' ? raw : {}) };

  o.enabled = typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_OVERLOAD.enabled;

  // Patterns are case-insensitive regexes (see detectOverload).
  o.patterns = validPatterns(o.patterns, DEFAULT_OVERLOAD.patterns);

  const backoff = Array.isArray(o.backoffSeconds)
    ? o.backoffSeconds.filter(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  o.backoffSeconds = backoff.length > 0 ? backoff : [...DEFAULT_OVERLOAD.backoffSeconds];

  o.steadyStateSeconds = validNumber(o.steadyStateSeconds, 1, DEFAULT_OVERLOAD.steadyStateSeconds);
  o.jitterPct = clamp(o.jitterPct, 0, 100, DEFAULT_OVERLOAD.jitterPct);
  o.maxTotalWaitMinutes = validNumber(o.maxTotalWaitMinutes, 0.1, DEFAULT_OVERLOAD.maxTotalWaitMinutes);
  o.eventMaxAgeSeconds = validNumber(o.eventMaxAgeSeconds, 1, DEFAULT_OVERLOAD.eventMaxAgeSeconds);

  if (typeof o.retryMessage !== 'string' || !o.retryMessage) {
    o.retryMessage = DEFAULT_OVERLOAD.retryMessage;
  }
  o.relaunchOnExit = typeof o.relaunchOnExit === 'boolean' ? o.relaunchOnExit : DEFAULT_OVERLOAD.relaunchOnExit;
  if (typeof o.relaunchCommand !== 'string' || !o.relaunchCommand) {
    o.relaunchCommand = DEFAULT_OVERLOAD.relaunchCommand;
  }
  return o;
}

// Keep only non-empty strings that actually compile, so a typo'd user pattern can't crash
// the monitor tick. Shared by every pattern-carrying block.
function validPatterns(raw, defaults) {
  const pats = Array.isArray(raw)
    ? raw.filter(p => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  return pats.length > 0 ? pats : [...defaults];
}

// Safeguard and streamInterrupted are the same SHAPE of block — a bounded, seconds-scale
// retry family (patterns + cap + delay + message) — so one validator serves both. Overload
// keeps its own: it carries a backoff schedule and relaunch knobs this shape has no room for.
function validateBoundedRetry(raw, defaults) {
  const b = { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
  b.enabled = typeof b.enabled === 'boolean' ? b.enabled : defaults.enabled;
  b.patterns = validPatterns(b.patterns, defaults.patterns);
  b.maxRetries = validNumber(b.maxRetries, 1, defaults.maxRetries);
  b.retryDelaySeconds = validNumber(b.retryDelaySeconds, 1, defaults.retryDelaySeconds);
  if (typeof b.retryMessage !== 'string' || !b.retryMessage) {
    b.retryMessage = defaults.retryMessage;
  }
  return b;
}

// The wrap-up nudge has no patterns (the render is fixed and shape-anchored) and no delay
// (it fires at the idle prompt), so the bounded-retry validator above does not fit.
function validateNudge(raw, defaults) {
  const b = { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
  b.enabled = typeof b.enabled === 'boolean' ? b.enabled : defaults.enabled;
  b.maxRetries = validNumber(b.maxRetries, 1, defaults.maxRetries);
  if (typeof b.retryMessage !== 'string' || !b.retryMessage) b.retryMessage = defaults.retryMessage;
  return b;
}

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function validateCompact(raw) {
  const d = DEFAULT_COMPACT;
  const b = { ...d, ...(raw && typeof raw === 'object' ? raw : {}) };
  b.enabled = typeof b.enabled === 'boolean' ? b.enabled : d.enabled;
  b.trigger = ['request', 'policy', 'both'].includes(b.trigger) ? b.trigger : d.trigger;
  b.window = b.window && typeof b.window === 'object' && CLOCK.test(b.window.start) && CLOCK.test(b.window.end)
    ? { start: b.window.start, end: b.window.end } : null;
  b.awayMinutes = typeof b.awayMinutes === 'number' && b.awayMinutes >= 0 ? b.awayMinutes : null;
  b.minContextPercent = clamp(validNumber(b.minContextPercent, 0, d.minContextPercent), 0, 100);
  const st = { ...d.settle, ...(b.settle && typeof b.settle === 'object' ? b.settle : {}) };
  b.settle = {
    mode: ['before-expiry', 'fixed'].includes(st.mode) ? st.mode : d.settle.mode,
    marginSeconds: validNumber(st.marginSeconds, 0, d.settle.marginSeconds),
    minutes: validNumber(st.minutes, 0, d.settle.minutes),
  };
  b.focus = typeof b.focus === 'string' ? b.focus : d.focus;
  b.matchLastMessage = typeof b.matchLastMessage === 'boolean' ? b.matchLastMessage : d.matchLastMessage;
  b.confirmMinutes = validNumber(b.confirmMinutes, 1, d.confirmMinutes);
  b.minIntervalMinutes = validNumber(b.minIntervalMinutes, 0, d.minIntervalMinutes);
  return b;
}

function validateNative(raw) {
  const b = { ...DEFAULT_NATIVE, ...(raw && typeof raw === 'object' ? raw : {}) };
  b.usageLimit = ['defer', 'ignore'].includes(b.usageLimit) ? b.usageLimit : DEFAULT_NATIVE.usageLimit;
  b.graceSeconds = validNumber(b.graceSeconds, 0, DEFAULT_NATIVE.graceSeconds);
  return b;
}

function validateNetworkCheck(raw) {
  const d = DEFAULT_NETWORK_CHECK;
  const b = { ...d, ...(raw && typeof raw === 'object' ? raw : {}) };
  b.enabled = typeof b.enabled === 'boolean' ? b.enabled : d.enabled;
  b.host = typeof b.host === 'string' && b.host ? b.host : d.host;
  b.port = Number.isInteger(b.port) && b.port > 0 && b.port < 65536 ? b.port : d.port;
  b.maxWaitMinutes = validNumber(b.maxWaitMinutes, 0, d.maxWaitMinutes);
  return b;
}

function validate(cfg) {
  cfg.maxRetries = validNumber(cfg.maxRetries, 1, DEFAULT_CONFIG.maxRetries);
  cfg.pollIntervalSeconds = validNumber(cfg.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds);
  cfg.marginSeconds = validNumber(cfg.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds);
  cfg.fallbackWaitHours = validNumber(cfg.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours);
  if (typeof cfg.retryMessage !== 'string' || !cfg.retryMessage) {
    cfg.retryMessage = DEFAULT_CONFIG.retryMessage;
  }
  if (!Array.isArray(cfg.customPatterns)) {
    cfg.customPatterns = DEFAULT_CONFIG.customPatterns;
  } else {
    cfg.customPatterns = cfg.customPatterns.filter(p => {
      if (typeof p !== 'string') return false;
      try { new RegExp(p); return true; } catch { return false; }
    });
  }
  if (cfg.foregroundCommands !== undefined) {
    if (!Array.isArray(cfg.foregroundCommands) || cfg.foregroundCommands.length === 0) {
      delete cfg.foregroundCommands;
    }
  }
  cfg.overload = validateOverload(cfg.overload);
  cfg.safeguard = validateBoundedRetry(cfg.safeguard, DEFAULT_SAFEGUARD);
  cfg.streamInterrupted = validateBoundedRetry(cfg.streamInterrupted, DEFAULT_STREAM_INTERRUPTED);
  cfg.nearLimitWrapUp = validateNudge(cfg.nearLimitWrapUp, DEFAULT_NEAR_LIMIT_WRAP_UP);
  cfg.compact = validateCompact(cfg.compact);
  cfg.native = validateNative(cfg.native);
  cfg.networkCheck = validateNetworkCheck(cfg.networkCheck);
  return cfg;
}

async function readJsonObject(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// One level deeper than a spread, so a user file that sets only `overload.enabled` keeps
// the rest of an `overload` block from a system file.
function layer(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? { ...b, ...v }
      : v;
  }
  return out;
}

// With no arguments: the user config over the system ones (XDG_CONFIG_DIRS, first entry
// wins). An explicit path reads only that file unless system paths are passed too, so
// tests don't pick up whatever is installed in /etc/xdg.
export async function loadConfig(path, systemPaths) {
  if (path === undefined) {
    path = PATHS.config;
    if (systemPaths === undefined) systemPaths = PATHS.systemConfigs;
  }
  let merged = {};
  for (const p of [...(systemPaths || [])].reverse()) {
    const obj = await readJsonObject(p);
    if (obj) merged = layer(merged, obj);
  }
  const user = await readJsonObject(path);
  if (user) merged = layer(merged, user);
  if (Object.keys(merged).length === 0) return { ...DEFAULT_CONFIG };
  try {
    return validate({ ...DEFAULT_CONFIG, ...merged });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
