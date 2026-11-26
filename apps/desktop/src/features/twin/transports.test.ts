import { describe, expect, it, vi } from 'vitest';
import { WebSerialAdapter } from './transports';

/** Web Serial adapter with a fake port: lines are decoded; the writable side is never touched. */
describe('WebSerialAdapter', () => {
  it('reads lines from the port and never accesses port.writable', async () => {
    const chunks = ['@H,1,X,fw,1*', '00\n@D,0,0,d=1*00\n'].map((s) => new TextEncoder().encode(s));
    let i = 0;
    const readable = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < chunks.length) c.enqueue(chunks[i++]!);
        else c.close();
      },
    });
    const writableGetter = vi.fn();
    const port = {
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readable,
      get writable() {
        writableGetter();
        return null;
      },
    };
    const requestPort = vi.fn(async (_o: { filters: unknown[] }) => port);
    Object.defineProperty(navigator, 'serial', { value: { requestPort }, configurable: true });
    expect(WebSerialAdapter.supported()).toBe(true);
    const lines: string[] = [];
    const states: boolean[] = [];
    const a = new WebSerialAdapter(115200, () => 0);
    await a.open({ line: (l) => lines.push(l), state: (o) => states.push(o) });
    await vi.waitFor(() => expect(states.at(-1)).toBe(false));
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200 });
    expect(requestPort.mock.calls[0]![0]!.filters.length).toBeGreaterThan(0);
    expect(lines).toEqual(['@H,1,X,fw,1*00', '@D,0,0,d=1*00']);
    expect(writableGetter).not.toHaveBeenCalled();
    expect(a.canActuate).toBe(false);
    Reflect.deleteProperty(navigator, 'serial');
    expect(WebSerialAdapter.supported()).toBe(false);
  });
});
