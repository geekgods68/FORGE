import { request, type IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { DEFAULT_SCENARIO, syntheticStream, TelemetryPipeline } from '@forge/digital-twin';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedDevice, configureDevice, createBridge } from '../../tools/serial-bridge/lib.mjs';

/**
 * The local serial bridge, with an in-memory stream standing in for the USB device (the
 * real device path is exercised only with hardware; see docs/guides/CONNECT_ARDUINO.md).
 */
const ORIGIN = 'http://127.0.0.1:4173';
let bridges: ReturnType<typeof createBridge>[] = [];
afterEach(async () => {
  for (const b of bridges) await b.close();
  bridges = [];
});

async function start(devices: PassThrough[]) {
  let k = 0;
  const b = createBridge({
    open: () => devices[Math.min(k++, devices.length - 1)]!,
    origins: [ORIGIN],
    token: 'a'.repeat(32),
    reconnectMs: 20,
  });
  bridges.push(b);
  const addr = (await b.listen(0)) as { port: number; address: string };
  return { b, port: addr.port, address: addr.address };
}
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    r.on('error', reject);
    r.end();
  });
}
function subscribe(port: number) {
  const events: { event: string; data: string }[] = [];
  let res: IncomingMessage | null = null;
  const ready = new Promise<void>((resolve) => {
    const r = request(
      { host: '127.0.0.1', port, path: `/telemetry?token=${'a'.repeat(32)}`, headers: { Origin: ORIGIN } },
      (x) => {
        res = x;
        let buf = '';
        x.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /event: (.*)/.exec(block)?.[1] ?? 'message';
            const data = /data: (.*)/.exec(block)?.[1] ?? '';
            events.push({ event: ev, data });
          }
        });
        resolve();
      },
    );
    r.end();
  });
  return { events, ready, close: () => res?.destroy() };
}
const until = async (f: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('serial bridge (read-only, loopback-only)', () => {
  it('binds 127.0.0.1 and refuses missing tokens, other methods and foreign origins', async () => {
    const { port, address } = await start([new PassThrough()]);
    expect(address).toBe('127.0.0.1');
    expect((await get(port, '/status')).status).toBe(401);
    expect((await get(port, `/status?token=${'b'.repeat(32)}`)).status).toBe(401);
    expect((await get(port, `/telemetry?token=${'a'.repeat(32)}`, {}, 'POST')).status).toBe(405);
    expect(
      (await get(port, `/status?token=${'a'.repeat(32)}`, { Origin: 'http://evil.example' })).status,
    ).toBe(403);
    const ok = await get(port, `/status?token=${'a'.repeat(32)}`, { Origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ connected: true, lines: 0 });
  });

  it('forwards protocol lines (only printable, ≤ 120 chars) and FORGE decodes them', async () => {
    const dev = new PassThrough();
    const { port, b } = await start([dev]);
    const sub = subscribe(port);
    await sub.ready;
    const s = syntheticStream({ ...DEFAULT_SCENARIO, durationS: 1 });
    dev.write(s.lines.map((l) => l.line).join('\r\n') + '\r\n');
    dev.write(`${'x'.repeat(200)}\n`);
    dev.write(Buffer.from([0x40, 0x01, 0xff, 0x0a]));
    await until(() => sub.events.filter((e) => e.event === 'line').length === s.lines.length);
    expect(b.status.dropped).toBe(2);
    const p = new TelemetryPipeline(0);
    p.setTransport(true, 0);
    sub.events.filter((e) => e.event === 'line').forEach((e, i) => p.ingestLine(e.data, i * 50));
    p.flush(Infinity);
    expect(p.stats.invalid).toEqual({});
    expect(p.series.get('d')!.t).toHaveLength(20);
    sub.close();
  });

  it('reports a device disconnect and reconnects', async () => {
    const d1 = new PassThrough();
    const d2 = new PassThrough();
    const { port, b } = await start([d1, d2]);
    const sub = subscribe(port);
    await sub.ready;
    d1.destroy(new Error('USB unplugged'));
    await until(() => b.status.reconnects === 1 && b.status.connected);
    const states = sub.events.filter((e) => e.event === 'state').map((e) => JSON.parse(e.data).connected);
    expect(states).toContain(false);
    expect(states.at(-1)).toBe(true);
    expect(b.status.lastError).toBe('USB unplugged');
    sub.close();
  });

  it('accepts only USB-serial device paths and never runs a command for anything else', async () => {
    expect(allowedDevice('/dev/cu.usbmodem1101', 'darwin')).toBe(true);
    expect(allowedDevice('/dev/cu.wchusbserial1420', 'darwin')).toBe(true);
    expect(allowedDevice('/dev/ttyACM0', 'linux')).toBe(true);
    expect(allowedDevice('COM3', 'win32')).toBe(true);
    for (const bad of [
      '/etc/passwd',
      '/dev/disk0',
      '/dev/cu.usbmodem1101; rm -rf /',
      '../../dev/ttyACM0',
      'COM3 & calc',
      '\\\\.\\PhysicalDrive0',
    ])
      for (const pf of ['darwin', 'linux', 'win32']) expect(allowedDevice(bad, pf)).toBe(false);
    await expect(configureDevice('/etc/passwd', 115200, 'darwin')).rejects.toThrow(/Refusing/);
    await expect(configureDevice('/dev/cu.usbmodem1', 1, 'darwin')).rejects.toThrow(/baud/);
  });
});
