# FORGE telemetry protocol v1

Line-based ASCII for the Arduino UNO (no `String`, integer formatting only). Implementation: `packages/digital-twin/src/protocol.ts`; reference firmware: `hardware/arduino/forge_telemetry/forge_telemetry.ino`.

```
@<T>,<field>,…*<CC>\n          CC = XOR of the bytes between '@' and '*', two upper-case hex digits
@H,1,<device-id>,<firmware>,<version>             hello (protocol version 1)
@C,<ch>,<m|c|e>,<unit>,<label>                    channel: measured / commanded / estimated
@D,<seq>,<ms>,<ch>=<value>[,<ch>=<value>…]        data; an empty value is MISSING
@S,<seq>,<ms>,<code>[,<detail>]                   status / heartbeat
@E,<seq>,<ms>,<code>[,<detail>]                   device error (e.g. no-echo)
```

- Lines ≤ 120 bytes, printable ASCII; `\r\n` accepted. Channel ids `[a-z][a-z0-9_]{0,15}`.
- `seq` 0…65535 (+1 per D/S/E message, wraps); `ms` = device `millis()` (wraps at 2³²).
- Hello and channel declarations are repeated every 5 s so a host that connects late learns them.
- **Host-bound only**: there is no command message. FORGE cannot instruct a device through this protocol.
- A commanded value (e.g. a servo angle written by the firmware) is declared `c` and is never displayed as a measured physical state.

Reference firmware (20 Hz): `@H,1,VEYRIS-ARM-01,forge-ultrasonic-servo,1.0.0`, `@C,d,m,mm,HC-SR04 distance`, `@C,a,c,deg,servo command`, `@D,<seq>,<ms>,d=<mm>,a=<deg>` (d empty and `@E,…,no-echo` when there is no echo), `@S,…,ok,overruns=<n>` every 5 s. It compiles in FORGE's UNO subset and runs unchanged on FORGE's virtual UNO (tested against the simulated arm) and, intended, on a real UNO (not tested on hardware in Phase 8).
