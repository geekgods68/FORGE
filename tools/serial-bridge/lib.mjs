// FORGE serial bridge — library (Node >= 22, no dependencies).
//
// Reads ONE serial device that the user names explicitly and forwards its text lines to a
// FORGE page as Server-Sent Events on 127.0.0.1. It is READ-ONLY by construction:
//   - the device is opened for reading only (no write stream is ever created);
//   - the HTTP server has no endpoint that accepts data (only GET /status, GET /telemetry);
//   - it binds to 127.0.0.1 only, requires a per-run random token, and only answers the
//     FORGE origins it was started for;
//   - device paths must match a USB-serial pattern (no arbitrary files);
//   - it runs no commands except fixed `stty` / `mode` invocations to set the baud rate.
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, readdirSync } from 'node:fs';
import { createServer } from 'node:http';

export const MAX_LINE = 120;
export const DEFAULT_PORT = 8765;
export const DEFAULT_ORIGINS = ['http://127.0.0.1:5173', 'http://127.0.0.1:4173'];

const DEVICE_PATTERNS = {
  darwin: /^\/dev\/cu\.(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)[\w.-]*$/,
  linux: /^\/dev\/tty(ACM|USB)\d{1,3}$/,
  win32: /^COM\d{1,3}$/i,
};

/** Is this an allowed USB-serial device path on this platform? */
export function allowedDevice(path, platform = process.platform) {
  const re = DEVICE_PATTERNS[platform];
  return !!re && typeof path === 'string' && re.test(path);
}

/** Candidate devices (macOS/Linux: /dev listing; Windows: the user names COMx). */
export function listDevices(platform = process.platform) {
  if (platform === 'win32') return [];
  try {
    return readdirSync('/dev')
      .map((n) => `/dev/${n}`)
      .filter((p) => allowedDevice(p, platform));
  } catch {
    return [];
  }
}

/** Set the line speed with a FIXED command (no shell, validated arguments). */
export function configureDevice(path, baud, platform = process.platform) {
  if (!allowedDevice(path, platform)) return Promise.reject(new Error(`Refusing device "${path}".`));
  if (!Number.isInteger(baud) || baud < 300 || baud > 2_000_000)
    return Promise.reject(new Error('Invalid baud rate.'));
  const [cmd, args] =
    platform === 'win32'
      ? ['mode', [`${path.toUpperCase()}:`, `BAUD=${baud}`, 'PARITY=n', 'DATA=8', 'STOP=1']]
      : [
          'stty',
          [
            platform === 'darwin' ? '-f' : '-F',
            path,
            String(baud),
            'raw',
            '-echo',
            'cs8',
            '-cstopb',
            '-parenb',
          ],
        ];
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 5000, shell: false }, (e) =>
      e ? reject(new Error(`${cmd} failed: ${e.message}`)) : resolve(),
    ),
  );
}

/** Open the device for READING ONLY. */
export function openDevice(path, platform = process.platform) {
  if (!allowedDevice(path, platform)) throw new Error(`Refusing device "${path}".`);
  return createReadStream(platform === 'win32' ? `\\\\.\\${path.toUpperCase()}` : path, {
    flags: 'r',
    highWaterMark: 1024,
  });
}

/**
 * The bridge: device stream(s) → line splitting → SSE clients.
 * `open()` returns a readable stream; it is re-opened after errors (reconnect).
 */
export function createBridge({
  open,
  configure = async () => {},
  origins = DEFAULT_ORIGINS,
  token = randomBytes(16).toString('hex'),
  reconnectMs = 2000,
  log = () => {},
}) {
  const clients = new Set();
  const status = {
    connected: false,
    lines: 0,
    dropped: 0,
    reconnects: 0,
    lastError: null,
    startedAt: new Date().toISOString(),
  };
  let stream = null;
  let buf = '';
  let stopped = false;
  let timer = null;
  const send = (event, data) => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${data}\n\n`);
  };
  const state = (connected, detail = '') => {
    status.connected = connected;
    send('state', JSON.stringify({ connected, detail, at: Date.now() }));
  };
  const onData = (chunk) => {
    buf += chunk.toString('latin1');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      // Only printable ASCII lines within the protocol limit are forwarded.
      if (line.length <= MAX_LINE && /^[\x20-\x7e]*$/.test(line)) {
        status.lines++;
        send('line', line);
      } else status.dropped++;
    }
    if (buf.length > 4 * MAX_LINE) {
      buf = '';
      status.dropped++;
    }
  };
  const connect = async () => {
    if (stopped) return;
    try {
      await configure();
      stream = open();
      stream.on('data', onData);
      stream.on('error', (e) => retry(e.message));
      stream.on('end', () => retry('device closed'));
      stream.on('open', () => state(true, 'device open'));
      if (!('pending' in stream) || stream.pending === false) state(true, 'device open');
    } catch (e) {
      retry(e instanceof Error ? e.message : String(e));
    }
  };
  const retry = (why) => {
    status.lastError = why;
    if (stream) stream.destroy();
    stream = null;
    state(false, why);
    if (stopped) return;
    status.reconnects++;
    log(`device: ${why}; retrying in ${reconnectMs} ms`);
    timer = setTimeout(connect, reconnectMs);
  };
  const tokenOk = (t) => {
    if (typeof t !== 'string' || t.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(t), Buffer.from(token));
  };
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') return void res.writeHead(403).end();
    if (origin && !origins.includes(origin)) return void res.writeHead(403).end('origin not allowed');
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method !== 'GET')
      return void res.writeHead(405, { Allow: 'GET', ...cors }).end('read-only bridge');
    if (!tokenOk(url.searchParams.get('token'))) return void res.writeHead(401, cors).end('token required');
    if (url.pathname === '/status')
      return void res
        .writeHead(200, { 'Content-Type': 'application/json', ...cors })
        .end(JSON.stringify(status));
    if (url.pathname === '/telemetry') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...cors,
      });
      res.write(
        `event: state\ndata: ${JSON.stringify({ connected: status.connected, detail: 'subscribed', at: Date.now() })}\n\n`,
      );
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, cors).end();
  });
  return {
    token,
    status,
    server,
    /** Listen on 127.0.0.1 ONLY. */
    listen(port = DEFAULT_PORT) {
      return new Promise((resolve) =>
        server.listen(port, '127.0.0.1', () => (connect(), resolve(server.address()))),
      );
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.destroy();
      for (const c of clients) c.end();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
