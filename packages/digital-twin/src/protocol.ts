/**
 * FORGE Telemetry Protocol, version 1 ("FTP/1") — line-based ASCII designed for the
 * Arduino UNO (2 KB SRAM, no String class needed, integer formatting only).
 *
 *   @<T>,<field>,<field>…*<CC>\n
 *
 * CC = two upper-case hex digits: XOR of every byte strictly between '@' and '*'.
 * Lines are at most MAX_LINE bytes; '\r' before '\n' is tolerated.
 *
 *   @H,1,<device-id>,<firmware>,<firmware-version>      hello (protocol version 1)
 *   @C,<ch>,<m|c|e>,<unit>,<label>                      channel declaration
 *                                                         m = measured, c = commanded, e = estimated
 *   @D,<seq>,<ms>,<ch>=<value>[,<ch>=<value>…]          data (value empty = missing)
 *   @S,<seq>,<ms>,<code>[,<detail>]                     status / heartbeat (e.g. ok, overrun)
 *   @E,<seq>,<ms>,<code>[,<detail>]                     device-side error (e.g. no-echo)
 *
 * seq: 0…65535, +1 per D/S/E message, wraps; ms: device millis() (wraps at 2³²).
 * Hello and channel declarations are repeated periodically so a late host learns them.
 * The protocol is HOST-BOUND ONLY: there is no command message (FORGE never actuates
 * hardware in Phase 8).
 */
export const PROTOCOL_VERSION = 1;
export const MAX_LINE = 120;
const ID = /^[a-z][a-z0-9_]{0,15}$/;
const TEXT = /^[\x20-\x7e]*$/;

export type ChannelKind = 'measured' | 'commanded' | 'estimated';
const KINDS: Record<string, ChannelKind> = { m: 'measured', c: 'commanded', e: 'estimated' };

export type Message =
  | { type: 'hello'; version: number; deviceId: string; firmware: string; firmwareVersion: string }
  | { type: 'channel'; id: string; kind: ChannelKind; unit: string; label: string }
  | { type: 'data'; seq: number; ms: number; values: Record<string, number | null> }
  | { type: 'status'; seq: number; ms: number; code: string; detail: string }
  | { type: 'error'; seq: number; ms: number; code: string; detail: string };

export type ParseResult = { ok: true; message: Message } | { ok: false; reason: string };

export function checksum(body: string): number {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i) & 0xff;
  return c;
}
export function encode(m: Message): string {
  let body: string;
  switch (m.type) {
    case 'hello':
      body = `H,${m.version},${m.deviceId},${m.firmware},${m.firmwareVersion}`;
      break;
    case 'channel':
      body = `C,${m.id},${m.kind[0]},${m.unit},${m.label}`;
      break;
    case 'data':
      body = `D,${m.seq},${m.ms},${Object.entries(m.values)
        .map(([k, v]) => `${k}=${v === null ? '' : v}`)
        .join(',')}`;
      break;
    case 'status':
    case 'error':
      body = `${m.type === 'status' ? 'S' : 'E'},${m.seq},${m.ms},${m.code}${m.detail ? `,${m.detail}` : ''}`;
      break;
  }
  return `@${body}*${checksum(body).toString(16).toUpperCase().padStart(2, '0')}`;
}

const uint = (s: string | undefined, max: number) => {
  if (!s || !/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
};

/** Parse one line (without its newline). Never throws. */
export function parseLine(raw: string): ParseResult {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line.length > MAX_LINE) return { ok: false, reason: 'line too long' };
  if (!TEXT.test(line)) return { ok: false, reason: 'non-ASCII or control characters' };
  const m = /^@([^*]*)\*([0-9A-Fa-f]{2})$/.exec(line);
  if (!m) return { ok: false, reason: 'not a FORGE telemetry line' };
  const body = m[1]!;
  if (checksum(body) !== parseInt(m[2]!, 16)) return { ok: false, reason: 'checksum mismatch' };
  const f = body.split(',');
  switch (f[0]) {
    case 'H': {
      const version = uint(f[1], 255);
      if (version === null || f.length !== 5) return { ok: false, reason: 'malformed hello' };
      if (version !== PROTOCOL_VERSION)
        return { ok: false, reason: `unsupported protocol version ${version}` };
      if (!f[2] || !f[3]) return { ok: false, reason: 'hello without device or firmware' };
      return {
        ok: true,
        message: { type: 'hello', version, deviceId: f[2]!, firmware: f[3]!, firmwareVersion: f[4] ?? '' },
      };
    }
    case 'C': {
      if (f.length !== 5 || !ID.test(f[1]!) || !KINDS[f[2]!] || !f[3])
        return { ok: false, reason: 'malformed channel declaration' };
      return {
        ok: true,
        message: { type: 'channel', id: f[1]!, kind: KINDS[f[2]!]!, unit: f[3]!, label: f[4]! },
      };
    }
    case 'D': {
      const seq = uint(f[1], 65535);
      const ms = uint(f[2], 0xffffffff);
      if (seq === null || ms === null || f.length < 4) return { ok: false, reason: 'malformed data header' };
      const values: Record<string, number | null> = {};
      for (const kv of f.slice(3)) {
        const e = kv.indexOf('=');
        const id = e > 0 ? kv.slice(0, e) : '';
        if (!ID.test(id)) return { ok: false, reason: `bad channel id "${id}"` };
        if (id in values) return { ok: false, reason: `duplicate channel ${id}` };
        const v = kv.slice(e + 1);
        if (v === '' || /^nan$/i.test(v)) values[id] = null;
        else if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) values[id] = Number(v);
        else return { ok: false, reason: `bad value for ${id}` };
      }
      return { ok: true, message: { type: 'data', seq, ms, values } };
    }
    case 'S':
    case 'E': {
      const seq = uint(f[1], 65535);
      const ms = uint(f[2], 0xffffffff);
      if (seq === null || ms === null || !f[3]) return { ok: false, reason: 'malformed status' };
      return {
        ok: true,
        message: {
          type: f[0] === 'S' ? 'status' : 'error',
          seq,
          ms,
          code: f[3]!,
          detail: f.slice(4).join(','),
        },
      };
    }
    default:
      return { ok: false, reason: `unknown message type "${f[0]}"` };
  }
}

/** Incremental byte/char stream → lines (bounded: over-long lines are dropped and counted). */
export class LineSplitter {
  private buf = '';
  overlong = 0;
  push(chunk: string, onLine: (line: string) => void) {
    for (const ch of chunk) {
      if (ch === '\n') {
        if (this.buf.length <= MAX_LINE + 1) onLine(this.buf);
        else this.overlong++;
        this.buf = '';
      } else if (this.buf.length <= MAX_LINE + 1) this.buf += ch;
      else if (this.buf.length === MAX_LINE + 2) this.buf += ch; // keep marking as overlong
    }
  }
}
