import { LineSplitter, type AdapterHandlers, type TelemetryAdapter } from '@forge/digital-twin';

/**
 * Real telemetry transports for the browser. Both are RECEIVE-ONLY: the Web Serial adapter
 * never touches `port.writable`, and the bridge adapter uses EventSource (HTTP GET).
 *
 * Web Serial exists in Chromium-based desktop browsers (Chrome, Edge, Opera) over HTTPS or
 * localhost. It is NOT available in Safari, Firefox or the Meta Quest browser — there, use
 * the local bridge (tools/serial-bridge) on the computer the Arduino is plugged into.
 */
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike {
  requestPort(o: { filters: { usbVendorId: number }[] }): Promise<SerialPortLike>;
}
const serialApi = (): SerialLike | null =>
  typeof navigator !== 'undefined' && 'serial' in navigator
    ? (navigator as unknown as { serial: SerialLike }).serial
    : null;

/** USB vendor ids offered in the port chooser: Arduino (2), WCH CH340, FTDI, Silicon Labs. */
export const USB_FILTERS = [0x2341, 0x2a03, 0x1a86, 0x0403, 0x10c4].map((usbVendorId) => ({ usbVendorId }));

export class WebSerialAdapter implements TelemetryAdapter {
  readonly kind = 'web-serial' as const;
  readonly synthetic = false;
  readonly canActuate = false as const;
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;
  constructor(
    private readonly baud: number,
    private readonly now: () => number = () => performance.now(),
  ) {}
  static supported() {
    return serialApi() !== null;
  }
  /** Must be called from a user gesture: the browser shows its own port chooser. */
  async open(h: AdapterHandlers) {
    const api = serialApi();
    if (!api)
      throw new Error(
        'Web Serial is not available in this browser (use Chrome or Edge on the desktop, or the local bridge).',
      );
    this.port = await api.requestPort({ filters: USB_FILTERS });
    await this.port.open({ baudRate: this.baud });
    h.state(true, this.now(), 'serial port open');
    void this.pump(h);
  }
  private async pump(h: AdapterHandlers) {
    const split = new LineSplitter();
    const dec = new TextDecoder('latin1');
    try {
      // One reader for the life of the connection: a finished stream (done) means the
      // device went away or the port was closed — the pump ends, it never re-polls.
      const readable = this.port?.readable;
      if (readable) {
        this.reader = readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done || this.closing) break;
            const t = this.now();
            split.push(dec.decode(value, { stream: true }), (l) => h.line(l, t));
          }
        } finally {
          this.reader.releaseLock();
        }
      }
    } catch (e) {
      h.state(false, this.now(), e instanceof Error ? e.message : String(e));
      return;
    }
    h.state(false, this.now(), this.closing ? 'closed' : 'device disconnected');
  }
  async close() {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already released */
    }
    try {
      await this.port?.close();
    } catch {
      /* already closed */
    }
  }
}

export class BridgeAdapter implements TelemetryAdapter {
  readonly kind = 'bridge' as const;
  readonly synthetic = false;
  readonly canActuate = false as const;
  private es: EventSource | null = null;
  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly now: () => number = () => performance.now(),
  ) {}
  async open(h: AdapterHandlers) {
    if (!/^[0-9a-f]{32}$/.test(this.token))
      throw new Error('The bridge token is the 32-character hex string the bridge printed.');
    if (!Number.isInteger(this.port) || this.port < 1024 || this.port > 65535)
      throw new Error('Invalid bridge port.');
    const es = new EventSource(`http://127.0.0.1:${this.port}/telemetry?token=${this.token}`);
    this.es = es;
    es.addEventListener('line', (e) => h.line((e as MessageEvent<string>).data, this.now()));
    es.addEventListener('state', (e) => {
      const s = JSON.parse((e as MessageEvent<string>).data) as { connected: boolean; detail: string };
      h.state(s.connected, this.now(), `bridge: ${s.detail}`);
    });
    es.onerror = () => h.state(false, this.now(), 'bridge unreachable (is tools/serial-bridge running?)');
  }
  async close() {
    this.es?.close();
    this.es = null;
  }
}
