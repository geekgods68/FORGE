#!/usr/bin/env node
// FORGE serial bridge — command line. See docs/guides/CONNECT_ARDUINO.md.
//
//   node tools/serial-bridge/bridge.mjs --list
//   node tools/serial-bridge/bridge.mjs --device /dev/cu.usbmodem1101 [--baud 115200] [--port 8765]
//   node tools/serial-bridge/bridge.mjs --device COM3                  (Windows)
//
// Read-only: forwards telemetry lines from one USB-serial device to FORGE on 127.0.0.1.
import {
  allowedDevice,
  configureDevice,
  createBridge,
  DEFAULT_ORIGINS,
  DEFAULT_PORT,
  listDevices,
  openDevice,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
if (args.includes('--help') || !args.length) {
  console.log(
    'Usage: bridge.mjs --list | --device <path|COMn> [--baud 115200] [--port 8765] [--origin http://127.0.0.1:5173]',
  );
  process.exit(0);
}
if (args.includes('--list')) {
  const d = listDevices();
  console.log(
    d.length
      ? d.join('\n')
      : process.platform === 'win32'
        ? 'On Windows, name the port (e.g. --device COM3; see Device Manager → Ports).'
        : 'No USB-serial devices found.',
  );
  process.exit(0);
}
const device = opt('device');
const baud = Number(opt('baud', '115200'));
const port = Number(opt('port', String(DEFAULT_PORT)));
const origins = opt('origin') ? [opt('origin')] : DEFAULT_ORIGINS;
if (!allowedDevice(device)) {
  console.error(`Refusing "${device}": not a USB-serial device path for ${process.platform}.`);
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Invalid --port.');
  process.exit(2);
}
const bridge = createBridge({
  open: () => openDevice(device),
  configure: () => configureDevice(device, baud),
  origins,
  log: (m) => console.log(m),
});
await bridge.listen(port);
console.log(`FORGE serial bridge (read-only) for ${device} at ${baud} baud`);
console.log(`Listening on http://127.0.0.1:${port}  (origins: ${origins.join(', ')})`);
console.log(`Token (paste into FORGE → Digital twin → Bridge): ${bridge.token}`);
const stop = async () => {
  await bridge.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
