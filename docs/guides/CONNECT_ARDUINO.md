# Connecting the Arduino UNO (observation only)

**Hardware**: HC-SR04 TRIG → D7, ECHO → D8, VCC → 5V, GND → GND; servo signal → D9, servo power from a separate 5–6 V supply with a common ground. Keep the arm clear of people: FORGE does not move it, but the firmware does (its own gauge logic).

1. Flash `hardware/arduino/forge_telemetry/forge_telemetry.ino` with the Arduino IDE (115200 baud). Optionally change `VEYRIS-ARM-01` in `announce()`.
2. Check the Serial Monitor shows lines of the form `@D,<seq>,<ms>,d=<mm>,a=<deg>*<checksum>`, then **close the Serial Monitor** (only one program can open the port).

**Chrome or Edge (macOS, Windows)**: Digital twin → adapter **USB serial (Web Serial)** → **Connect (observe)** → pick the board in the browser's chooser.

**Safari, Firefox, or any setup without Web Serial** — local bridge (Node ≥ 22):

- macOS: `node tools/serial-bridge/bridge.mjs --list`, then `node tools/serial-bridge/bridge.mjs --device /dev/cu.usbmodemXXXX`
- Windows (PowerShell, e.g. on the Acer Nitro 5): find the port in Device Manager → Ports (COM & LPT), then `node tools\serial-bridge\bridge.mjs --device COM3`
- Copy the printed token into FORGE → adapter **Local serial bridge** → token → **Connect**. The bridge listens on 127.0.0.1:8765 only, accepts GET only and cannot write to the board.

The link badge shows live / delayed / stale / disconnected; the wrist is shown at the **commanded** angle. Physical connectivity was **not tested** during Phase 8 development (no hardware was attached); please report what you observe.
