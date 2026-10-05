// Pane-keyed markers written by Claude Code hooks and read by the monitor.
//
// StopFailure markers (events.js) only say "the turn died on an API error". These cover
// the rest of a turn's life, so the monitor can know what the session is doing without
// scraping the screen:
//
//   stop      Stop: the turn ended. Carries how many background agents are still in flight
//             (background_tasks, minus long-lived monitors and shells) and how many session crons will wake the session later
//             (session_crons), plus the tail of the last assistant message.
//   prompt    UserPromptSubmit: a turn started (typed by a person or sent by us).
//   notify    Notification: permission prompts, idle prompts, quota auto-resume events.
//   compact   PostCompact: a compaction finished.
//   model     PostModelSwitch: the model changed.
//   request   Written by `claude-keep-going request ...`, not a hook.
//
// One file per pane and kind, overwritten each time; the latest event is all the monitor
// needs. Same directory and socket-prefixed keying as StopFailure markers.
//
// The field names come from the hook schemas in the Claude Code 2.1.287 binary. Payloads
// captured from live sessions belong in test/fixtures/hooks/ and should be checked
// against this file.

import { writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, ensurePrivateDir } from './paths.js';
import { sanitizeKey, socketIdFromEnv } from './pane-key.js';

export const MARKER_KINDS = ['stop', 'prompt', 'notify', 'compact', 'model', 'request'];

// Hook event name -> marker kind.
export const HOOK_EVENTS = {
  Stop: 'stop',
  UserPromptSubmit: 'prompt',
  Notification: 'notify',
  PostCompact: 'compact',
  PostModelSwitch: 'model',
};

const LAST_MESSAGE_CHARS = 2000;

// Sessions started by our launcher carry CLAUDE_KEEP_GOING_PANE. A claude that reconcile
// adopted later doesn't, but it still runs inside the pane, so $TMUX_PANE names it.
export function paneKeyFromEnv(env = process.env) {
  return env.CLAUDE_KEEP_GOING_PANE || env.TMUX_PANE || null;
}

function fileFor(kind, paneKey, dir, env) {
  return join(dir, `${sanitizeKey(socketIdFromEnv(env))}_${sanitizeKey(paneKey)}.${kind}.json`);
}

function count(v) {
  return Array.isArray(v) ? v.length : 0;
}

// Monitors and shells (a dev server, an artifact watch) stay running for the whole session
// and finish without a Stop, so counting them would keep a session unsettled forever.
const LONG_LIVED_TASKS = new Set(['monitor', 'shell']);

function pendingWork(tasks) {
  return Array.isArray(tasks) ? tasks.filter((t) => !LONG_LIVED_TASKS.has(t?.type)).length : 0;
}

// The marker body for one hook payload: only what the monitor reads, so a large
// payload doesn't get copied around every turn.
export function markerFromHook(kind, payload = {}, now = Date.now()) {
  const base = { ts: now, session_id: payload.session_id ?? null };
  switch (kind) {
    case 'stop': {
      const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
      return {
        ...base,
        background: pendingWork(payload.background_tasks),
        crons: count(payload.session_crons),
        // Absent on older Claude Code builds. null means "unknown", not "none".
        hasBackgroundInfo: Array.isArray(payload.background_tasks),
        last: last.slice(-LAST_MESSAGE_CHARS),
        transcript_path: payload.transcript_path ?? null,
      };
    }
    case 'prompt':
      // source: user | sdk | system | loop_wakeup | schedule_wakeup | poll_event. Text we
      // type with send-keys arrives as "user"; the prompt head tells it apart.
      return {
        ...base,
        source: payload.source ?? null,
        head: typeof payload.prompt === 'string' ? payload.prompt.slice(0, 200) : null,
      };
    case 'notify':
      return { ...base, type: payload.notification_type ?? null, message: payload.message ?? null };
    case 'compact':
      return { ...base, trigger: payload.trigger ?? null };
    case 'model':
      return {
        ...base,
        from: payload.from_model ?? null,
        to: payload.to_model ?? null,
        requested: payload.requested_model ?? null,
        source: payload.source ?? null,
      };
    default:
      return base;
  }
}

export async function writeMarker(kind, paneKey, body, dir = PATHS.events, env = process.env) {
  if (!paneKey) return null;
  ensurePrivateDir(dir);
  const file = fileFor(kind, paneKey, dir, env);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(body));
  await rename(tmp, file);
  return file;
}

// null when absent, unparseable, or older than maxAgeMs (when given).
export async function readMarker(kind, paneKey, { maxAgeMs, dir = PATHS.events, env = process.env } = {}) {
  if (!paneKey) return null;
  try {
    const m = JSON.parse(await readFile(fileFor(kind, paneKey, dir, env), 'utf-8'));
    if (typeof m.ts !== 'number') return null;
    if (maxAgeMs !== undefined && Date.now() - m.ts > maxAgeMs) return null;
    return m;
  } catch {
    return null;
  }
}

export async function clearMarker(kind, paneKey, dir = PATHS.events, env = process.env) {
  if (!paneKey) return;
  try { await unlink(fileFor(kind, paneKey, dir, env)); } catch { /* already gone */ }
}

// What the session is doing, from its latest stop and prompt markers:
//   'busy'     a turn started after the last one ended
//   'idle'     the last turn ended and nothing started since
//   'unknown'  no markers (hooks not installed, or a session from before they were)
export function turnState({ stop, prompt } = {}) {
  if (!stop && !prompt) return 'unknown';
  if (!stop) return 'busy';
  if (!prompt) return 'idle';
  return prompt.ts > stop.ts ? 'busy' : 'idle';
}

// Idle and nothing will wake the session on its own: no background agents or tasks
// still running, no scheduled wakeups. False when the Stop payload had no such fields.
export function isSettled(stopMarker) {
  return !!stopMarker && stopMarker.hasBackgroundInfo === true
    && stopMarker.background === 0 && stopMarker.crons === 0;
}
