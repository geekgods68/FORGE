# Embedded runtime (Phase 6)

## Support level: **Level 2 — API-compatible simulated runtime**

| Level | Meaning                                                          | FORGE Phase 6      |
| ----- | ---------------------------------------------------------------- | ------------------ |
| 1     | Behavioural device model reproducing specific behaviours         | Sensors, servo     |
| 2     | User code runs against a modelled embedded API; CPU not emulated | **Arduino UNO R3** |
| 3     | Real compiled firmware runs on a processor/peripheral emulator   | **Not supported**  |

Why not Level 3: no AVR emulator (e.g. avr8js) or AVR toolchain (avr-gcc) is installed, and none could be downloaded under this phase's constraints (offline install, low disk). Without a compiler, real Arduino C++ cannot become firmware, so loading `.hex`/`.elf` files is not offered. **FORGE does not claim Arduino firmware compatibility:** sketches that stay inside the subset below behave like their Arduino counterparts at the level of the modelled API; timing is approximate and nothing is cycle-accurate.

Board: **Arduino UNO R3** only. ESP32, Raspberry Pi Pico and STM32 are not implemented; the runtime is separated (`Interpreter` + host `UnoRuntime` with its builtin tables) so another board means a new host with its own pin map, thresholds and peripherals.

## Language: the FORGE Arduino subset

Accepted:

- `#include <Arduino.h>` and `#include <Servo.h>` (any other library is an error); object-like `#define NAME value`.
- Types with **AVR sizes**: `bool/boolean`, `char` (8-bit signed), `byte/uint8_t`, `int/short/int16_t` (16-bit), `unsigned int/word/uint16_t/size_t`, `long/int32_t` (32-bit), `unsigned long/uint32_t`, `float` and `double` (both IEEE single precision); `const`, `volatile`, `static` (including static locals).
- Global and local variables, one-dimensional arrays (≤ 4,096 elements, brace initialisers, `int a[] = {…}`), `Servo` objects and arrays of them (global).
- Functions with typed parameters (arrays by reference), recursion (depth ≤ 64), prototypes.
- `if/else`, `while`, `do…while`, `for`, `switch/case/default`, `break`, `continue`, `return`; all C operators except the comma operator; casts `(int)x` and `int(x)`; character and string literals; `F("…")`.
- C semantics: integer promotion and usual arithmetic conversions on AVR sizes, wrapping on overflow (`int x = 40000;` → −25536), truncating integer division and `%`, float32 rounding, octal/hex/binary literals with `U`/`L` suffixes.

Not supported (compile error with line and column): other libraries (Wire, SPI, …), `String`, classes/structs/enums/typedef/templates/namespaces, pointers and references, multi-dimensional arrays, function-like macros, `#if`, `goto`, `long long`, `tone`, `bitSet/bitClear/bitWrite` (they modify their argument), `Serial.parseFloat`, `String`-returning APIs.

Static checks before running: undeclared names, unknown functions, argument counts, assignments to `const`, `break`/`continue` placement, required `void setup()`/`void loop()`, and a **global SRAM estimate** (error above the UNO's 2,048 bytes, warning above 75 %).

Runtime errors stop the board and show the line: out-of-bounds array access (which on a real UNO silently corrupts memory), integer division by zero, `map()` with equal input bounds, delay inside an interrupt handler, runaway recursion.

## Modelled UNO API

| API                                                                                           | Model                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinMode`, `digitalWrite`, `digitalRead`                                                      | Through the signal network; outputs at the solved 5 V rail behind 25 Ω; ATmega thresholds; `digitalWrite(HIGH)` on an input enables the pull-up; reading `Z`/`X` returns LOW **and logs a warning** (undefined on hardware)                                                                                                   |
| `analogRead`                                                                                  | A0–A5 (or 0–5, 14–19); 10-bit, AVCC reference; ≈ 100 µs per call (Arduino reference); floating → 0 with a warning                                                                                                                                                                                                             |
| `analogWrite`                                                                                 | ≈ 490 Hz on D3/D9/D10/D11, ≈ 980 Hz on D5/D6; 0 and 255 are constant levels; non-PWM pins: < 128 LOW else HIGH; no effect on D9/D10 while a Servo is attached (Timer1)                                                                                                                                                        |
| `delay`, `delayMicroseconds`, `millis`, `micros`                                              | Simulation time; `millis` 1 ms resolution; `micros` 4 µs resolution (16 MHz UNO); 32-bit wrap                                                                                                                                                                                                                                 |
| `pulseIn(pin, level[, timeout µs])`                                                           | Waits for any current pulse to end, then measures the next pulse from **exact edge timestamps**; whole call bounded by the timeout (default 1 s); returns 0 on timeout                                                                                                                                                        |
| `attachInterrupt` / `detachInterrupt`, `noInterrupts` / `interrupts`, `digitalPinToInterrupt` | INT0 = D2, INT1 = D3; RISING/FALLING/CHANGE (LOW-level not supported); handlers run at the edge time between main-program steps; disabled interrupts are queued                                                                                                                                                               |
| `Serial.begin/print/println/write/available/read/peek/parseInt/flush/end`                     | 10 bits per byte at the baud rate; 64-byte TX buffer (print blocks when full); output timestamped at transmission completion; 64-byte RX buffer fed by the serial monitor byte by byte; `parseInt` parses only bytes already received (Arduino waits up to 1 s); float printing with 2 decimals by default, `nan`/`inf`/`ovf` |
| `Servo.attach/detach/write/writeMicroseconds/read/readMicroseconds/attached`                  | Library defaults 544–2400 µs, 1500 µs initial; `write(v)` with v < 544 is an angle (mapped as the library does); 20 ms frames with pulses issued one after another                                                                                                                                                            |
| Math and bits                                                                                 | `map` (long, integer), `constrain`, `min`, `max`, `abs`, `sq`, `sqrt`, `pow`, `sin`, `cos`, `tan`, `atan`, `atan2`, `exp`, `log`, `fabs`, `floor`, `ceil`, `round`, `fmod`, `bitRead`, `bit`, `lowByte`, `highByte`; `random`/`randomSeed` use a seeded LCG (reproducible, **not** avr-libc's sequence)                       |

Constants: `HIGH`, `LOW`, `INPUT`, `OUTPUT`, `INPUT_PULLUP`, `LED_BUILTIN`, `A0…A5`, `RISING/FALLING/CHANGE`, `PI`, `HALF_PI`, `TWO_PI`, `DEG_TO_RAD`, `RAD_TO_DEG`, `DEC/HEX/BIN/OCT`.

Power: the board runs only while its 5 V rail is ≥ 4.5 V (ATmega328P speed grade for 16 MHz); USB power is modelled as an ideal 5 V source; external power through VIN needs ≥ 7 V (cited recommended input). If the rail drops while running, the firmware halts (brown-out).

## Execution model and timing

- A generator-based tree-walking interpreter: blocking calls (`delay`, `pulseIn`, a full UART buffer) yield to the runtime, which resumes the program when the simulated condition is met.
- Every evaluated node costs **250 ns** of simulated time (setting `opCostNs`; roughly four AVR instructions — an assumption, not a measurement). Built-in calls add approximate costs (`digitalWrite`/`digitalRead`/`pinMode` 4 µs, `analogRead` 100 µs). The accumulated cost is paid to the scheduler before any I/O and at least every 32 operations, so I/O happens at a consistent simulated time.
- Consequences: loop timing is approximate (the validation case shows a 500 ms blink period off by 12 µs from the call costs); interrupt latency is not modelled (handlers run at the edge time); there is no instruction-level timing, no Timer registers, no watchdog, EEPROM, sleep modes or bootloader.

## Editor

Electronics mode → Code: syntax highlighting, line numbers, Tab indent, Check (same front end as the runtime), Save (undoable, revision + 1; Ctrl/Cmd+S), templates (Blink, Ultrasonic servo gauge, Serial commands, Four-joint arm control), firmware assignment per board, and a pin map derived from the **wiring** (which net and device each UNO pin reaches). Simulation mode shows board state, compile/runtime errors with line numbers, and the serial monitor (with optional timestamps and an input line).

## Security

The interpreter can reach only its builtin tables; there is no `eval`, `Function`, DOM, network, storage or filesystem access. Sources are size-limited (64 KB) and the parser bounds tokens, nodes and nesting. Execution is bounded per event and per frame. It runs on the main thread inside this restricted interpreter; moving it to a Worker is a possible later hardening step.
