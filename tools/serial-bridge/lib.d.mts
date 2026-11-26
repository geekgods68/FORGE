import type { Server } from 'node:http';
import type { Readable } from 'node:stream';
export declare const MAX_LINE: number;
export declare const DEFAULT_PORT: number;
export declare const DEFAULT_ORIGINS: string[];
export declare function allowedDevice(path: string, platform?: string): boolean;
export declare function listDevices(platform?: string): string[];
export declare function configureDevice(path: string, baud: number, platform?: string): Promise<void>;
export declare function openDevice(path: string, platform?: string): Readable;
export interface BridgeStatus {
  connected: boolean;
  lines: number;
  dropped: number;
  reconnects: number;
  lastError: string | null;
  startedAt: string;
}
export declare function createBridge(o: {
  open: () => Readable;
  configure?: () => Promise<void>;
  origins?: string[];
  token?: string;
  reconnectMs?: number;
  log?: (m: string) => void;
}): {
  token: string;
  status: BridgeStatus;
  server: Server;
  listen(port?: number): Promise<unknown>;
  close(): Promise<void>;
};
