declare module 'occt-import-js' {
  import type { OcctKernel } from '@forge/interop';
  const factory: (opts?: { locateFile?: (path: string) => string }) => Promise<OcctKernel>;
  export default factory;
}
