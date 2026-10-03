#!/usr/bin/env node

import { readFile, writeFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeStopFailureEvent, isRetryableError, isUsageLimitError } from '../src/events.js';
import { sweepStaleStatus, readStatus, formatBadge } from '../src/status-file.js';
import { PATHS } from '../src/paths.js';
import { HOOK_EVENTS, paneKeyFromEnv, markerFromHook, writeMarker } from '../src/markers.js';
import { writeStatuslineSnapshot } from '../src/statusline.js';
import { planMigration, applyMigration, describeStep, sweepLegacyDir, olderMonitorPids } from '../src/migrate.js';
import { reconcile, excludeSelf, parseRunningMonitors, PGREP_LIST_FLAG } from '../src/reconcile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = join(__dirname, '..', 'src');
const LAUNCHER_PATH = join(SRC_DIR, 'launcher.js');
const WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.sh');

export const MARKER_START = '# >>> claude-keep-going >>>';
export const MARKER_END = '# <<< claude-keep-going <<<';
// Written by claude-auto-retry, the package this one was renamed from.
export const LEGACY_MARKER_START = '# >>> claude-auto-retry >>>';
export const LEGACY_MARKER_END = '# <<< claude-auto-retry <<<';

// --- Wrapper injection ---

export async function injectWrapper(rcFile, launcherPath) {
  let content = '';
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    // File doesn't exist, create it
  }

  const template = await readFile(WRAPPER_TEMPLATE, 'utf-8');
  const wrapper = template.replace(/__LAUNCHER_PATH__/g, launcherPath);

  content = stripBlock(content, MARKER_START, MARKER_END).content;
  // A block left by the package this one was renamed from defines a second claude()
  // that would shadow or wrap ours, so it goes too.
  const legacy = stripBlock(content, LEGACY_MARKER_START, LEGACY_MARKER_END);
  content = legacy.content;

  content = content.trimEnd() + '\n\n' + wrapper + '\n';
  await writeFile(rcFile, content);
  return { replacedLegacy: legacy.found };
}

function stripBlock(content, start, end) {
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1) return { content, found: false };
  const afterMarker = endIdx + end.length;
  // Skip the newline after the end marker if present, but don't blindly +1
  const skipTo = content[afterMarker] === '\n' ? afterMarker + 1
               : content.slice(afterMarker, afterMarker + 2) === '\r\n' ? afterMarker + 2
               : afterMarker;
  return { content: content.slice(0, startIdx) + content.slice(skipTo), found: true };
}

export async function removeWrapper(rcFile) {
  let content;
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    return;
  }

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + MARKER_END.length).trimStart();
  content = before + (after ? '\n' + after : '\n');
  await writeFile(rcFile, content);
}

// --- tmux install ---

function detectOS() {
  if (process.platform === 'darwin') return 'macos';
  try {
    const release = execFileSync('cat', ['/etc/os-release'], { encoding: 'utf-8' });
    if (release.includes('ID=ubuntu') || release.includes('ID=debian') || release.includes('ID_LIKE=debian')) return 'debian';
    if (release.includes('ID=fedora') || release.includes('ID=rhel') || release.includes('ID=centos')
        || release.includes('ID=rocky') || release.includes('ID="amzn"')
        || release.includes('ID_LIKE="rhel') || release.includes('ID_LIKE=rhel')) return 'rhel';
    if (release.includes('ID=arch') || release.includes('ID_LIKE=arch')) return 'arch';
    if (release.includes('ID=alpine')) return 'alpine';
  } catch {}
  return 'unknown';
}

function installTmux() {
  const os = detectOS();
  const cmds = {
    debian: ['sudo', ['apt-get', 'install', '-y', 'tmux']],
    rhel: ['sudo', ['dnf', 'install', '-y', 'tmux']],
    arch: ['sudo', ['pacman', '-S', '--noconfirm', 'tmux']],
    alpine: ['sudo', ['apk', 'add', 'tmux']],
    macos: ['brew', ['install', 'tmux']],
  };

  const entry = cmds[os];
  if (!entry) {
    console.error('Could not detect OS. Please install tmux manually.');
    process.exit(1);
  }

  console.log(`Installing tmux...`);
  try {
    execFileSync(entry[0], entry[1], { stdio: 'inherit' });
  } catch {
    console.error('Failed to install tmux. Please install it manually.');
    process.exit(1);
  }
}

function checkTmux() {
  try {
    const version = execFileSync('tmux', ['-V'], { encoding: 'utf-8' }).trim();
    const match = version.match(/tmux\s+(\d+\.\d+)/);
    if (match && parseFloat(match[1]) >= 2.1) return true;
    console.error(`tmux version ${match?.[1] || 'unknown'} is too old. Requires >= 2.1.`);
    return false;
  } catch {
    return false;
  }
}

// --- CLI commands ---

async function cmdInstall() {
  console.log('claude-keep-going: installing...\n');

  if (!checkTmux()) {
    console.log('tmux not found or too old. Attempting install...');
    installTmux();
    if (!checkTmux()) { console.error('tmux install failed.'); process.exit(1); }
  }
  console.log('tmux OK');

  const shell = process.env.SHELL || '/bin/bash';
  if (shell.includes('fish')) {
    console.error('\nFish shell detected. Automatic install not supported.');
    console.error(`Add manually to ~/.config/fish/config.fish:`);
    console.error(`  function claude; set -x CLAUDE_KEEP_GOING_ACTIVE 1; node "${LAUNCHER_PATH}" $argv; set -e CLAUDE_KEEP_GOING_ACTIVE; end`);
    process.exit(1);
  }

  const rcFiles = [];
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');

  if (existsSync(bashrc) || shell.includes('bash')) rcFiles.push(bashrc);
  if (existsSync(zshrc) || shell.includes('zsh')) rcFiles.push(zshrc);
  if (rcFiles.length === 0) rcFiles.push(bashrc);

  for (const rc of rcFiles) {
    const { replacedLegacy } = await injectWrapper(rc, LAUNCHER_PATH);
    console.log(`Shell function added to ${rc}`);
    if (replacedLegacy) console.log(`  Removed the old claude-auto-retry block from ${rc}`);
  }

  if (!process.argv.includes('--no-migrate')) {
    console.log('');
    await runMigration({ yes: process.argv.includes('--yes') });
  }

  console.log(`\nInstalled! Launcher path: ${LAUNCHER_PATH}`);
  console.log('\nRestart your shell or run:');
  for (const rc of rcFiles) { console.log(`  source ${rc}`); }
  console.log('\nNote: If you switch Node versions (nvm), re-run: claude-keep-going install');
}

async function cmdUninstall() {
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');
  for (const rc of [bashrc, zshrc]) { await removeWrapper(rc); }
  // Best-effort GC of tmux-status snapshot files left behind by monitors that died
  // without cleaning up (SIGKILL, host sleep/crash) — see src/status-file.js. Failure
  // here must never block the uninstall itself.
  await sweepStaleStatus().catch(() => {});
  console.log('Shell function removed. Restart your shell to complete.');
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function cmdStatus() {
  const pane = argValue('--pane');
  if (pane !== undefined) {
    // Badge for one pane, for a statusline. Prints nothing when the pane has no live
    // monitor. --socket defaults to the tmux server in $TMUX.
    process.stdout.write(formatBadge(await readStatus(pane, undefined, argValue('--socket'))));
    return;
  }
  const logDir = PATHS.logs;
  const today = new Date().toISOString().split('T')[0];
  const logFile = join(logDir, `${today}.log`);
  try {
    const content = await readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    console.log(`Log file: ${logFile}\n`);
    console.log('Last 10 entries:');
    console.log(lines.slice(-10).join('\n'));
  } catch {
    console.log('No activity today. Log directory:', logDir);
  }
}

async function cmdLogs() {
  const logDir = PATHS.logs;
  const today = new Date().toISOString().split('T')[0];
  const logFile = join(logDir, `${today}.log`);
  if (!existsSync(logFile)) {
    console.log(`No log file for today: ${logFile}`);
    return;
  }
  const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
  tail.on('error', (err) => {
    console.error(`Failed to tail log: ${err.message}`);
  });
  await new Promise((resolve) => {
    tail.on('exit', resolve);
    tail.on('error', resolve);
  });
}

// --- StopFailure hook (event-driven overload trigger) ---

const HOOK_MARKER = '_stopfailure-hook';

export function stopFailureHookEntry(prefix = hookCommandPrefix()) {
  // Matcher filters on the StopFailure error type: the transient-overload classes plus
  // rate_limit (the session/usage limit — routed by the monitor to the hours-scale
  // usage-wait, never the overload backoff; see src/events.js and src/monitor.js).
  return {
    matcher: 'overloaded|server_error|rate_limit',
    hooks: [{ type: 'command', command: `${prefix} ${HOOK_MARKER}`, timeout: 5 }],
  };
}

// Claude Code runs the hook through a shell with its own PATH, which may not have `node`
// on it. A packaged install (the Nix wrapper) sets CLAUDE_KEEP_GOING_BIN to its own
// entry point; otherwise pin the node binary running this install.
export function hookCommandPrefix(env = process.env, execPath = process.execPath, cliPath = __filename) {
  if (env.CLAUDE_KEEP_GOING_BIN) return `"${env.CLAUDE_KEEP_GOING_BIN}"`;
  return `"${execPath}" "${cliPath}"`;
}

// Idempotent: drop any prior entry pointing at our handler, then add the current one.
// The marker is the subcommand name, which claude-auto-retry used too, so its entry is
// replaced rather than left running next to ours.
export function mergeStopFailureHook(existing, entry) {
  const kept = (Array.isArray(existing) ? existing : []).filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));
  kept.push(entry);
  return kept;
}

function resolveConfigDir(arg) {
  return arg || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Error classes this version ever writes a marker for — overload (seconds-scale) and
// usage-limit (hours-scale). Everything else (auth/billing/invalid/etc.) is never written.
export function shouldWriteEvent(errorType) {
  return isRetryableError(errorType) || isUsageLimitError(errorType);
}

// Invoked BY Claude Code on a turn-ending API error. Reads the hook JSON on stdin and,
// for an error class we act on, writes a pane-keyed marker the monitor consumes. Must
// never disrupt the session: StopFailure output/exit is ignored, and we swallow all errors.
async function cmdStopFailureHook() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const pane = process.env.CLAUDE_KEEP_GOING_PANE;
    if (pane && shouldWriteEvent(payload.error)) {
      await writeStopFailureEvent(pane, payload);
    }
  } catch { /* swallow — never break the host session */ }
  process.exit(0);
}

// Event hooks feed src/markers.js. Async, so they never hold up a turn, and silent: a
// UserPromptSubmit hook's stdout would be added to the conversation.
const EVENT_HOOK_MARKER = '_ckg-hook';
// Temporary payload capture for building test fixtures (install-hook --dump).
const DUMP_HOOK_MARKER = '_hook-dump';
const DUMP_EVENTS = ['Stop', 'StopFailure', 'UserPromptSubmit', 'Notification', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'PreModelSwitch', 'PostModelSwitch', 'SessionStart'];
const OUR_MARKERS = [HOOK_MARKER, EVENT_HOOK_MARKER, DUMP_HOOK_MARKER];

function mergeHook(existing, entry, marker) {
  const kept = (Array.isArray(existing) ? existing : []).filter((e) => !JSON.stringify(e).includes(marker));
  kept.push(entry);
  return kept;
}

function asyncHookEntry(command) {
  return { hooks: [{ type: 'command', command, timeout: 5, async: true }] };
}

// Returns settings with our hooks in place. Entries from other tools are kept, ours
// replaced, so running it again (or after an upgrade moves the binary) is safe.
export function applyHooks(settings, { prefix = hookCommandPrefix(), dump = false } = {}) {
  const out = { ...settings, hooks: { ...(settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) } };
  out.hooks.StopFailure = mergeStopFailureHook(out.hooks.StopFailure, stopFailureHookEntry(prefix));
  for (const event of Object.keys(HOOK_EVENTS)) {
    out.hooks[event] = mergeHook(out.hooks[event], asyncHookEntry(`${prefix} ${EVENT_HOOK_MARKER} ${event}`), EVENT_HOOK_MARKER);
  }
  if (dump) {
    for (const event of DUMP_EVENTS) {
      out.hooks[event] = mergeHook(out.hooks[event], asyncHookEntry(`${prefix} ${DUMP_HOOK_MARKER}`), DUMP_HOOK_MARKER);
    }
  }
  return out;
}

// Removes every hook entry this tool wrote, or only the dump entries.
export function removeHooks(settings, { onlyDump = false } = {}) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  const markers = onlyDump ? [DUMP_HOOK_MARKER] : OUR_MARKERS;
  const hooks = {};
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const kept = Array.isArray(entries)
      ? entries.filter((e) => !markers.some((m) => JSON.stringify(e).includes(m)))
      : entries;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  const out = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

function positionalArg(index) {
  return process.argv.slice(3).filter((a) => !a.startsWith('--'))[index];
}

async function cmdInstallHook() {
  const settingsPath = join(resolveConfigDir(positionalArg(0)), 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsPath, 'utf-8')); } catch { /* new file */ }
  const dump = process.argv.includes('--dump');
  settings = applyHooks(settings, { dump });
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Hooks installed in ${settingsPath} (StopFailure, ${Object.keys(HOOK_EVENTS).join(', ')})`);
  if (dump) console.log(`Also recording raw hook payloads to ${HOOK_DUMP_FILE}. Remove with: claude-keep-going uninstall-hook --dump`);
  console.log('New Claude sessions pick them up; running ones may need a restart.');
}

async function cmdUninstallHook() {
  const settingsPath = join(resolveConfigDir(positionalArg(0)), 'settings.json');
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    const onlyDump = process.argv.includes('--dump');
    await writeFile(settingsPath, JSON.stringify(removeHooks(settings, { onlyDump }), null, 2) + '\n');
    console.log(onlyDump ? `Payload recording removed from ${settingsPath}` : `Hooks removed from ${settingsPath}`);
  } catch { console.log('No settings file to modify.'); }
}

// Invoked BY Claude Code for the events in HOOK_EVENTS. Writes a pane-keyed marker and
// nothing else: no output, exit 0 whatever happens.
async function cmdEventHook() {
  try {
    const kind = HOOK_EVENTS[process.argv[3]];
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const pane = paneKeyFromEnv();
    if (kind && pane) await writeMarker(kind, pane, markerFromHook(kind, payload));
  } catch { /* never break the host session */ }
  process.exit(0);
}

const HOOK_DUMP_FILE = join(dirname(PATHS.logs), 'hook-dump.jsonl');

async function cmdHookDump() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const record = {
      ...payload,
      _ts: Date.now(),
      _tmux_pane: process.env.TMUX_PANE ?? null,
      _kg_pane: process.env.CLAUDE_KEEP_GOING_PANE ?? null,
    };
    await mkdir(dirname(HOOK_DUMP_FILE), { recursive: true });
    await appendFile(HOOK_DUMP_FILE, JSON.stringify(record) + '\n');
  } catch { /* never break the host session */ }
  process.exit(0);
}

// Run by the model (through its Bash tool) to ask for something it can't do itself.
// Inherits the pane from the claude it runs under.
async function cmdRequest() {
  const action = process.argv[3];
  if (action !== 'compact') {
    console.error('Usage: claude-keep-going request compact [focus text]');
    process.exit(2);
  }
  const pane = paneKeyFromEnv();
  if (!pane) {
    console.error('Not running inside a tmux pane, so no monitor can act on this request.');
    process.exit(1);
  }
  const focus = process.argv.slice(4).join(' ').trim();
  await writeMarker('request', pane, { ts: Date.now(), action: 'compact', focus });
  console.log('Compaction queued. It runs after this turn ends and background work has finished,');
  console.log('if idle compaction is enabled in the claude-keep-going config.');
}

// statusLine wrapper: save the fields the monitor uses, then run the real statusline
// command (everything after --) with the same input and pass its output through.
async function cmdStatuslineTap() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks);
  try {
    const pane = paneKeyFromEnv();
    if (pane) await writeStatuslineSnapshot(pane, JSON.parse(raw.toString() || '{}'));
  } catch { /* the statusline must still render */ }
  const sep = process.argv.indexOf('--');
  const cmd = sep === -1 ? [] : process.argv.slice(sep + 1);
  if (cmd.length === 0) return;
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(raw);
  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(127));
  });
  process.exitCode = code;
}

// --- reconcile timer (self-healing monitor coverage) ---
// Linux: systemd --user service+timer. macOS: a launchd LaunchAgent. Same cadence
// (run shortly after login, then every 5 min), same reconcile entry point.

const SYSTEMD_DIR = join(SRC_DIR, '..', 'systemd');
const UNIT_SERVICE = 'claude-keep-going-reconcile.service';
const UNIT_TIMER = 'claude-keep-going-reconcile.timer';

const LAUNCHD_DIR = join(SRC_DIR, '..', 'launchd');
const LAUNCHD_LABEL = 'com.claude-keep-going.reconcile';
const LAUNCHD_PLIST = `${LAUNCHD_LABEL}.plist`;

// Units installed by claude-auto-retry, the package this one was renamed from. Left in
// place they would run a second reconcile against the old package's monitors.
const LEGACY_UNIT_SERVICE = 'claude-auto-retry-reconcile.service';
const LEGACY_UNIT_TIMER = 'claude-auto-retry-reconcile.timer';
const LEGACY_LAUNCHD_LABEL = 'com.claude-auto-retry.reconcile';

function userUnitDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
}

function launchAgentsDir() {
  return join(homedir(), 'Library', 'LaunchAgents');
}

// Substitute the node/CLI paths into a unit template. The template quotes the placeholders
// (see the .service), so a path with spaces produces a valid quoted ExecStart.
export function renderReconcileUnit(template, nodePath, cliPath) {
  return template.replace(/__NODE_PATH__/g, nodePath).replace(/__CLI_PATH__/g, cliPath);
}

// launchd variant: the placeholders sit inside <string> elements, so the substituted
// paths must be XML-escaped (an '&' in an nvm dir name would otherwise corrupt the
// plist; spaces need no quoting — each ProgramArguments <string> is one argv entry).
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderReconcilePlist(template, nodePath, cliPath) {
  return template
    .replace(/__NODE_PATH__/g, xmlEscape(nodePath))
    .replace(/__CLI_PATH__/g, xmlEscape(cliPath));
}

// macOS: install the reconcile LaunchAgent into ~/Library/LaunchAgents and load it via
// launchctl bootstrap into the user's gui domain. RunAtLoad + StartInterval=300 mirror
// the systemd timer's OnStartupSec/OnUnitActiveSec cadence.
async function installTimerLaunchd() {
  const dest = launchAgentsDir();
  await mkdir(dest, { recursive: true });
  const nodePath = process.execPath;
  const cliPath = __filename;

  let template;
  try {
    template = await readFile(join(LAUNCHD_DIR, LAUNCHD_PLIST), 'utf-8');
  } catch (err) {
    console.error(`Could not read the launchd plist template from ${LAUNCHD_DIR} (${err.code || err.message}).`);
    console.error('If you installed from npm, upgrade to a version that ships the launchd/ directory,');
    console.error('or run install-timer from a git checkout of the repo.');
    process.exit(1);
  }
  const plistPath = join(dest, LAUNCHD_PLIST);
  await writeFile(plistPath, renderReconcilePlist(template, nodePath, cliPath));

  const domain = `gui/${process.getuid()}`;
  const legacyPlist = join(dest, `${LEGACY_LAUNCHD_LABEL}.plist`);
  if (existsSync(legacyPlist)) {
    try { execFileSync('launchctl', ['bootout', `${domain}/${LEGACY_LAUNCHD_LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    try { await unlink(legacyPlist); console.log(`Removed the old claude-auto-retry LaunchAgent (${legacyPlist})`); } catch { /* absent */ }
  }
  // Reload cleanly if a previous version is already bootstrapped (bootstrap fails on
  // an already-loaded label; bootout of an absent label fails — both safe to ignore).
  try { execFileSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  try {
    execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
  } catch {
    console.error(`\nAgent written to ${plistPath} but loading failed. Load manually:`);
    console.error(`  launchctl bootstrap ${domain} ${plistPath}`);
    process.exit(1);
  }
  console.log(`\nLaunchAgent installed and loaded. Monitor coverage now self-heals every 5 min.`);
  console.log(`  status:  launchctl print ${domain}/${LAUNCHD_LABEL}`);
  console.log(`  note: LaunchAgents run only while you are logged in (fine for tmux —`);
  console.log(`        the tmux server lives in your login session too).`);
  console.log(`\nNote: the agent pins this Node path (${nodePath}). If you switch Node`);
  console.log(`versions (nvm), re-run: claude-keep-going install-timer`);
}

async function uninstallTimerLaunchd() {
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded — fine */ }
  try { await (await import('node:fs/promises')).unlink(join(launchAgentsDir(), LAUNCHD_PLIST)); } catch { /* absent */ }
  console.log('LaunchAgent removed. (Already-running monitors are unaffected.)');
}

// Install the reconcile service+timer into the systemd --user unit dir, substituting the
// node and CLI paths, then enable+start the timer. Makes monitor coverage self-healing:
// every 5 min a missing monitor is re-armed. systemd --user on Linux; launchd on macOS.
async function cmdInstallTimer() {
  if (process.platform === 'darwin') return installTimerLaunchd();
  const dest = userUnitDir();
  await mkdir(dest, { recursive: true });
  const nodePath = process.execPath;
  const cliPath = __filename;

  let svcTemplate, timerTemplate;
  try {
    svcTemplate = await readFile(join(SYSTEMD_DIR, UNIT_SERVICE), 'utf-8');
    timerTemplate = await readFile(join(SYSTEMD_DIR, UNIT_TIMER), 'utf-8');
  } catch (err) {
    console.error(`Could not read the systemd unit templates from ${SYSTEMD_DIR} (${err.code || err.message}).`);
    console.error('If you installed from npm, upgrade to a version that ships the systemd/ directory,');
    console.error('or run install-timer from a git checkout of the repo.');
    process.exit(1);
  }
  await writeFile(join(dest, UNIT_SERVICE), renderReconcileUnit(svcTemplate, nodePath, cliPath));
  await writeFile(join(dest, UNIT_TIMER), timerTemplate);

  if (existsSync(join(dest, LEGACY_UNIT_TIMER))) {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', LEGACY_UNIT_TIMER], { stdio: 'ignore' }); } catch { /* not enabled */ }
    for (const u of [LEGACY_UNIT_TIMER, LEGACY_UNIT_SERVICE]) {
      try { await unlink(join(dest, u)); } catch { /* absent */ }
    }
    console.log(`Removed the old claude-auto-retry timer from ${dest}`);
  }

  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', UNIT_TIMER], { stdio: 'inherit' });
  } catch {
    console.error(`\nUnits written to ${dest} but enabling failed. Enable manually:`);
    console.error(`  systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_TIMER}`);
    process.exit(1);
  }
  console.log(`\nTimer installed and started. Monitor coverage now self-heals every 5 min.`);
  console.log(`  status:  systemctl --user status ${UNIT_TIMER}`);
  console.log(`  next run: systemctl --user list-timers ${UNIT_TIMER}`);
  console.log(`  tip: for the timer to run while logged out, enable lingering once:`);
  console.log(`       loginctl enable-linger $USER`);
  console.log(`\nNote: the unit pins this Node path (${nodePath}). If you switch Node`);
  console.log(`versions (nvm), re-run: claude-keep-going install-timer`);
}

async function cmdUninstallTimer() {
  if (process.platform === 'darwin') return uninstallTimerLaunchd();
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', UNIT_TIMER], { stdio: 'inherit' });
  } catch { /* not enabled — fine */ }
  const dest = userUnitDir();
  for (const u of [UNIT_TIMER, UNIT_SERVICE]) {
    try { await (await import('node:fs/promises')).unlink(join(dest, u)); } catch { /* absent */ }
  }
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' }); } catch { /* ignore */ }
  console.log('Timer removed. (Already-running monitors are unaffected.)');
}

// Durably exclude the current session from auto-monitoring (by its claude PID, which
// is self-expiring and immune to tmux pane-id reuse). Run from inside the session.
async function cmdExcludeSelf() {
  const r = await excludeSelf();
  if (!r.ok) { console.error(`exclude-self: ${r.reason}`); process.exit(1); }
  console.log(r.already
    ? `Already excluded (claude PID ${r.pid}, pane ${r.pane}).`
    : `Excluded this session: claude PID ${r.pid} (pane ${r.pane}). reconcile/timer will skip it.`);
  console.log('The entry self-expires when this claude exits (no cleanup needed).');
  // Kill any monitor already covering this pane so exclusion takes effect immediately.
  // Reuse parseRunningMonitors (same parser reconcile uses) instead of a bespoke one.
  try {
    const out = execFileSync('pgrep', [PGREP_LIST_FLAG, 'node .*src/monitor\\.js'], { encoding: 'utf-8' });
    const mpid = parseRunningMonitors(out).get(`${r.pane} ${r.pid}`);
    if (mpid) { try { process.kill(mpid); console.log(`Stopped existing monitor ${mpid}.`); } catch {} }
  } catch { /* no monitor running for this pane — nothing to stop */ }
}

// --- Migration from ~/.claude-auto-retry* ---

function monitorProcessList() {
  try {
    return execFileSync('pgrep', [PGREP_LIST_FLAG, 'node .*src/monitor\\.js'], { encoding: 'utf-8' });
  } catch { return ''; }   // pgrep exits 1 when nothing matches
}

function olderMonitorsRunning() {
  return olderMonitorPids(monitorProcessList(), SRC_DIR).length > 0;
}

async function confirm(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally { rl.close(); }
}

async function runMigration({ yes = false, quiet = false } = {}) {
  const plan = await planMigration();
  // Only the old directory left, and older monitors still using it: nothing would
  // change, and the reconcile timer runs this every few minutes.
  const onlyDirKept = plan.steps.length === 1 && plan.steps[0].kind === 'remove-dir' && olderMonitorsRunning();
  if (plan.steps.length === 0 || (quiet && onlyDirKept)) {
    if (!quiet) console.log('Nothing to migrate.');
    return;
  }
  console.log('Found files from claude-auto-retry (or claude-keep-going before 0.9):');
  for (const step of plan.steps) console.log(`  ${describeStep(step)}`);
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log('Not running in a terminal, so nothing was moved. Run `claude-keep-going migrate --yes` to move them.');
      return;
    }
    if (!(await confirm('Move them now? [Y/n] '))) {
      console.log('Left them in place. Run `claude-keep-going migrate` later.');
      return;
    }
  }
  try {
    for (const line of await applyMigration(plan, { olderMonitorsRunning: olderMonitorsRunning() })) {
      console.log(`  ${line}`);
    }
  } catch (err) {
    console.error(`migrate: ${err.message}`);
    process.exitCode = 1;
  }
}

async function cmdMigrate() {
  await runMigration({ yes: process.argv.includes('--yes'), quiet: process.argv.includes('--quiet') });
}

// Re-arm a monitor for every live tmux pane running claude that isn't already covered.
// Restores coverage after a crash/kill or for sessions started outside the wrapper.
async function cmdReconcile() {
  const dryRun = process.argv.includes('--dry-run');
  let result;
  try {
    result = await reconcile({ dryRun });
  } catch (err) {
    console.error(`reconcile failed: ${err.message}`);
    console.error('(needs a running tmux server; run from a machine with your claude sessions)');
    process.exit(1);
  }
  if (result.locked) {
    console.log('Another reconcile is already running (lock held). Nothing to do.');
    return;
  }
  if (!dryRun) {
    try {
      if (await sweepLegacyDir({ olderMonitorsRunning: olderMonitorsRunning() })) {
        console.log('Deleted the leftover ~/.claude-auto-retry directory.');
      }
    } catch { /* best effort */ }
  }
  const { armed, skipped } = result;
  if (armed.length === 0 && skipped.length === 0) {
    console.log('No tmux panes running claude found. Nothing to reconcile.');
    return;
  }
  if (armed.length) {
    console.log(dryRun ? `Would arm ${armed.length} monitor(s):` : `Armed ${armed.length} monitor(s):`);
    for (const a of armed) console.log(`  ${a.pane} → claude ${a.pid}${a.monitorPid ? ` (monitor ${a.monitorPid})` : ''}`);
  }
  for (const s of skipped) console.log(`  ${s.pane} → claude ${s.pid}: skipped (${s.reason})`);
  if (armed.length === 0) console.log('All live claude sessions already monitored.');
}

async function cmdVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
    console.log(pkg.version);
  } catch {
    console.log('unknown');
  }
}

// --- Main ---
// Only dispatch when run as the CLI. Tests import this file for its helpers, and without
// the guard every import printed the usage text. argv[1] can be an npm bin symlink.
const isMain = (() => {
  try { return realpathSync(process.argv[1] || '') === realpathSync(__filename); } catch { return false; }
})();
const command = isMain ? process.argv[2] : null;

if (isMain) switch (command) {
  case 'install': await cmdInstall(); break;
  case 'uninstall': await cmdUninstall(); break;
  case 'install-hook': await cmdInstallHook(); break;
  case 'uninstall-hook': await cmdUninstallHook(); break;
  case HOOK_MARKER: await cmdStopFailureHook(); break;
  case 'reconcile': await cmdReconcile(); break;
  case 'migrate': await cmdMigrate(); break;
  case EVENT_HOOK_MARKER: await cmdEventHook(); break;
  case DUMP_HOOK_MARKER: await cmdHookDump(); break;
  case 'statusline-tap': await cmdStatuslineTap(); break;
  case 'request': await cmdRequest(); break;
  case 'exclude-self': await cmdExcludeSelf(); break;
  case 'install-timer': await cmdInstallTimer(); break;
  case 'uninstall-timer': await cmdUninstallTimer(); break;
  case 'status': await cmdStatus(); break;
  case 'logs': await cmdLogs(); break;
  case 'version': case '--version': case '-v': await cmdVersion(); break;
  default:
    console.log('claude-keep-going - Auto-retry Claude Code on subscription rate limits\n');
    console.log('Usage:');
    console.log('  claude-keep-going install            Install shell wrapper + tmux, and offer to');
    console.log('                                       move files from ~/.claude-auto-retry*');
    console.log('                                       (--yes to move without asking, --no-migrate');
    console.log('                                       to skip)');
    console.log('  claude-keep-going uninstall          Remove shell wrapper');
    console.log('  claude-keep-going install-hook [dir] Install the hooks (StopFailure, Stop,');
    console.log('                                       UserPromptSubmit, Notification, PostCompact,');
    console.log('                                       PostModelSwitch) into <dir>/settings.json');
    console.log('                                       (default: $CLAUDE_CONFIG_DIR or ~/.claude).');
    console.log('                                       --dump also records raw payloads');
    console.log('  claude-keep-going uninstall-hook [dir]  Remove them (--dump: only the recording)');
    console.log('  claude-keep-going request compact [focus]');
    console.log('                                       Ask the monitor to run /compact once this');
    console.log('                                       session is idle (for the model to run)');
    console.log('  claude-keep-going statusline-tap -- <cmd...>');
    console.log('                                       statusLine wrapper: saves cache, usage and');
    console.log('                                       context numbers for the monitor, then runs');
    console.log('                                       <cmd> with the same input');
    console.log('  claude-keep-going reconcile          Re-arm a monitor for every live tmux');
    console.log('                                       claude session not already covered');
    console.log('                                       (--dry-run to preview). Run after a crash.');
    console.log('  claude-keep-going migrate            Move config and logs from ~/.claude-auto-retry*');
    console.log('                                       to the XDG directories (--yes: no prompt)');
    console.log('  claude-keep-going exclude-self       Keep THIS session unmonitored (durable,');
    console.log('                                       by claude PID; self-expires on exit)');
    console.log('  claude-keep-going install-timer      Install a timer that runs reconcile every');
    console.log('                                       5 min (self-healing coverage; systemd --user');
    console.log('                                       on Linux, launchd LaunchAgent on macOS)');
    console.log('  claude-keep-going uninstall-timer    Remove the reconcile timer');
    console.log('  claude-keep-going status             Show monitor status');
    console.log('  claude-keep-going status --pane <id> [--socket <path>]');
    console.log('                                       Print the status badge for one pane');
    console.log('  claude-keep-going logs               Tail today\'s log');
    console.log('  claude-keep-going version            Print version');
    break;
}
