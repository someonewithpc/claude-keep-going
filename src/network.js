// Is the API reachable? A TCP connect to the API host, or to the HTTPS proxy when one is
// configured (a direct connect would fail behind a proxy that works fine).

import { connect } from 'node:net';

export function connectTarget({ host, port }, env = process.env) {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (proxy) {
    try {
      const u = new URL(proxy);
      return { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
    } catch { /* unparseable: fall through to a direct connect */ }
  }
  return { host, port };
}

export function canConnect({ host, port }, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
