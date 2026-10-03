// Where claude-keep-going keeps its files, following the XDG base directory spec.
//
//   config   $XDG_CONFIG_HOME/claude-keep-going/config.json, layered over
//            <each $XDG_CONFIG_DIRS entry>/claude-keep-going/config.json
//   logs     $XDG_STATE_HOME/claude-keep-going/logs
//   runtime  $XDG_RUNTIME_DIR/claude-keep-going: status files, StopFailure markers, the
//            reconcile lock and exclude list, env snapshots. All of it is per-boot (pane
//            ids and pids don't survive a reboot), and the env snapshots can hold tokens,
//            so a private tmpfs is the right home.
//
// macOS has no XDG_RUNTIME_DIR, and some Linux sessions (cron, su) don't either; there
// the runtime dir falls back to $TMPDIR/claude-keep-going-<uid>. That path is guessable,
// so ensurePrivateDir refuses to use it unless we own it.
//
// Every process involved must resolve the same paths: the shell wrapper, the detached
// monitor, the hook (a child of claude), the reconcile timer and bin/tmux-status.sh. A
// custom XDG_* value set only in a shell rc file is invisible to the systemd user
// manager, so it has to be exported there too (environment.d).

import { mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const APP = 'claude-keep-going';

// The spec says relative values are invalid and must be ignored.
function xdgDir(value) {
  return value && isAbsolute(value) ? value : null;
}

export function resolvePaths(env = process.env, {
  home = homedir(),
  tmp = tmpdir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : 0,
} = {}) {
  const configHome = xdgDir(env.XDG_CONFIG_HOME) || join(home, '.config');
  const stateHome = xdgDir(env.XDG_STATE_HOME) || join(home, '.local', 'state');
  const runtimeDir = xdgDir(env.XDG_RUNTIME_DIR);
  const runtime = runtimeDir ? join(runtimeDir, APP) : join(tmp, `${APP}-${uid}`);
  const configDirs = (env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter((d) => xdgDir(d));
  return {
    config: join(configHome, APP, 'config.json'),
    // Highest priority first, as XDG_CONFIG_DIRS lists them.
    systemConfigs: configDirs.map((d) => join(d, APP, 'config.json')),
    logs: join(stateHome, APP, 'logs'),
    runtime,
    status: join(runtime, 'status'),
    events: join(runtime, 'events'),
    tmp: join(runtime, 'tmp'),
    lock: join(runtime, 'reconcile.lock'),
    exclude: join(runtime, 'reconcile-exclude'),
  };
}

export const PATHS = resolvePaths();

// mkdir -p with mode 0700, then make sure the runtime root is a real directory we own.
// Without the check, another user could create /tmp/claude-keep-going-<uid> first (or a
// symlink there) and read our env snapshots or plant markers.
export function ensurePrivateDir(dir, root = PATHS.runtime, uid = typeof process.getuid === 'function' ? process.getuid() : null) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!(dir === root || dir.startsWith(root + '/'))) return;
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${root} is not a directory`);
  if (uid !== null && st.uid !== uid) throw new Error(`${root} is owned by uid ${st.uid}, not ${uid}`);
  if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700);
}
