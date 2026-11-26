/// <reference lib="webworker" />
/**
 * STEP analysis worker: OCCT (WebAssembly) tessellation runs off the main thread, so a large
 * CAD file never freezes the UI. The worker receives bytes and returns the analysis; it has
 * no access to the project, the network or the file system.
 */
import { analyseGeometry, type OcctKernel } from '@forge/interop';
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

let kernel: Promise<OcctKernel> | null = null;
self.onmessage = async (e: MessageEvent<{ id: number; name: string; bytes: Uint8Array }>) => {
  const { id, name, bytes } = e.data;
  try {
    kernel ??= occtimportjs({ locateFile: () => wasmUrl });
    const t0 = performance.now();
    const analysis = analyseGeometry({ name, bytes }, 'step', await kernel);
    (self as unknown as Worker).postMessage({ id, analysis, ms: performance.now() - t0 });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
