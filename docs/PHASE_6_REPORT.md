# Phase 6 report: electronics, circuit simulation and embedded systems

**Status: COMPLETE against the 20 acceptance criteria (§26), with the partial items and limitations listed in §18.** Implemented on `phase-6/electronics-embedded`; not merged into `main`, not pushed. Phase 7 not started.

## 0. Initialisation

- Phase 5 was verified (clean tree at `67604b0`, all checks green, 56/56 browser tests) and was a clean fast-forward of `main`; `main` was fast-forwarded to `67604b0` (no history rewritten) and `phase-6/electronics-embedded` created from it. No remote exists; nothing was pushed.
- Libraries: no AVR emulator or toolchain is installed and none was downloaded (offline install, low disk) — hence a Level 2 runtime (§5). One new workspace package (`@forge/electronics`); `pnpm install --offline` only linked it. No new third-party dependency.
- Resources: 8 GB RAM with heavy swap use (≈ 5 of 6 GB); free disk 11 GiB at the start, **9.8 GiB at the end** (above the 8 GB minimum, below the 15 GB target). Only short benchmark runs were made.

## 1. Electrical architecture

Engineering data — the `electrical` definition on the root node (project schema **v6**; v1–v5 migrate unchanged) — is changed only by 16 undoable, batchable `electrical.*` commands that validate the whole circuit. Runtime state (signal levels, firmware state, device state) lives in `@forge/electronics` and is never persisted; telemetry exports are separate. Catalogue pin metadata extends the Phase 3 library (21 families; cited limits with sources; unknowns stay `null`). Details: ELECTRICAL_ARCHITECTURE.md.

## 2. Circuit topology

Parts (25 device models), explicit wires with schematic routes, net labels (named signals), junctions, ground symbols, device-internal terminals, hierarchical groups and buses (data model and commands). Nets come **only** from explicit relations — moving a symbol or component never connects anything (tested). Design-rule checks: 20 rule codes (structural and solved), unknown ratings reported as unknown, with a standing “not a safety certification” disclaimer. Schematic (pan/zoom/fit, drag, rotate, wire tool, bends, delete, net highlighting, labels) and 3D (pin markers by role, wires following simulated poses, wiring by clicking 3D pins) edit the same definition. Bundle import/export (validated, size-limited) and a labelled SPICE-style export.

## 3. Analog solver

Sparse MNA (Markowitz + threshold pivoting, reusable LU); DC with Newton–Raphson, SPICE junction limiting and source stepping; transient (trapezoidal / backward Euler, breakpoint-aligned steps with left-limit evaluation and a BE step after discontinuities, step halving, stiffness warning). Elements: R, V (with series R; DC/step/pulse/sine/PWL), I, C, L, VCVS, VCCS, switch, Shockley diode/LED, Ebers–Moll NPN, square-law NMOS, potentiometer. Failures (no reference, source loops, shorted sources, current sources without a DC path, floating gates/controls, singular matrices, non-convergence, step failure) return diagnostics and **no values**. CIRCUIT_SOLVER.md.

## 4. Digital simulation

Discrete-event scheduler on integer-nanosecond simulation time with deterministic ordering; 0/1/Z/X logic; contention → X + event; floating inputs read Z. Gates (inertial delay), D flip-flop, counter, clock/PWM. The signal network resolves digital nets by driver strength and mixed nets through the MNA solver; every reader applies its own thresholds (ATmega328P cited; module TTL thresholds assumed). ADC, PWM and driver boundaries documented. DIGITAL_SIMULATION.md.

## 5. Microcontroller support level

**Level 2 — API-compatible simulated runtime** for the **Arduino UNO R3**. User sketches run against a modelled Arduino API; the ATmega328P is not emulated; timing uses an operation-cost model (250 ns per interpreted node + approximate call costs). **Level 3 (firmware emulation) is not supported**; `.hex`/`.elf` files cannot be loaded; Arduino firmware compatibility is not claimed. ESP32, Pico and STM32 are not implemented (the runtime is separated so another board is a new host).

## 6. Firmware language/runtime

The documented **FORGE Arduino subset** (EMBEDDED_RUNTIME.md): AVR-sized C types and conversions, functions, arrays, control flow, `Servo.h`; GPIO, `analogRead`/`analogWrite`, `delay`/`millis`/`micros`, `pulseIn`, interrupts on D2/D3, Serial (baud timing, 64-byte buffers), Servo library behaviour, math helpers. Compile checks with line/column, a 2 KB SRAM estimate, runtime errors with lines (e.g. out-of-bounds access). Editor with highlighting, Check, Save (revision + 1), templates, firmware assignment and a pin map from the wiring; serial monitor in Simulation mode. Sandboxed: closed builtin table, no `eval`, size/depth/time limits.

## 7. Sensor models

HC-SR04 (ray cone on the simulated geometry, speed of sound vs temperature, cited range/angle, trigger/echo protocol, no-echo pulse, seeded noise), joint-linked potentiometer, limit switch and quadrature encoder, ambient-only temperature sensor (illustrative). IMU, camera, LiDAR and force sensors are not implemented. SENSOR_MODELS.md.

## 8. Actuator integration

Servo model: pulse decoding (Servo-library mapping assumed, cited SG90 deadband), valid-range and supply checks, then a Phase 5 `MotorCommand` (`source: 'electronics'`). The Phase 5 actuator's speed limit, PID and effort saturation produce the motion — the signal cannot bypass them (measured: peak speed never exceeds the limit). Servo current, back-EMF, losses and heating are not modelled; DC motors, steppers and drivers have no models yet.

## 9. Arduino–HC-SR04–servo demonstration

Sample “Arduino ultrasonic servo gauge”: UNO, HC-SR04 on a stand, SG90 driving a pointer link on a revolute joint, a movable obstacle, wiring with labelled nets, and the editable `Ultrasonic servo gauge` sketch. In Simulation mode the full loop runs on one clock: geometry → echo → `pulseIn` → firmware mapping → Servo pulses → joint target → physics. Measured (headless, real Rapier): firmware distance within **0.02 cm** of the value expected from the ray geometry; joint within **1.5°** of the decoded target after settling; moving the obstacle 12 cm changes distance, angle and pose accordingly; editing the mapping in the firmware reverses the response; runs are deterministic. Browser: all 15 steps of §15 (open, inspect circuit/wiring/code, start, move the target, observe distance, signals, controller output and servo motion, pause, inspect telemetry, modify the logic, run again, save and reopen).

## 10. Four-joint robotic-arm electronic control

Sample “Robotic arm with electronics”: the Phase 4 assembly and Phase 5 dynamics unchanged; UNO on USB power; MG996R ×3 and SG90 servos on a **separate 6 V battery domain** with a **shared ground**; servo signals on D3/D5/D6/D9; plate HC-SR04 feedback. Firmware: a pose sequence, serial joint commands (`S 60` …) and a range-sensor hold. Tests: all four joints follow firmware poses through the physics model (shoulder within 2.5°); with the shared ground removed the rule check flags it, the servos never accept a pulse, go limp and the arm sags under gravity. The supply is reported as not electrically validated (ideal source, unknown servo currents).

## 11. Electrical instruments

Simulation mode: voltmeter (any net), ammeter (latest mixed-signal solve), oscilloscope (recorded voltage steps, window, rising-edge trigger on channel 1, pause, CSV), logic analyser (lanes, timestamps, pulse width/period/duty, CSV), telemetry plots; Electronics mode: DC voltmeter/ammeter tables, transient plots/CSV, no-firmware logic analyser. Bounded buffers; no smoothing.

## 12. Numerical validation

**24 of 24 reference cases pass** (ELECTRICAL_VALIDATION.md; record `docs/archive/phase6-validation.json`): resistive DC and controlled sources (≤ 1e-9 V), large networks (R-2R ladder exact; KCL residual 5e-17 A on 1,740 resistors), RC charge/discharge (0.25 mV max error; measured τ within 4e-5; second-order convergence ratio 3.97), RL (5 µA), underdamped RLC (0.12 mV; peak time and overshoot within 0.2 %), switched RC (0.25 mV), diode vs Lambert W (9e-14 relative), NMOS (exact), NPN (2e-10), failure diagnostics (5 cases), truth tables, propagation and inertial filtering (exact ns), counter/toggle flip-flop, PWM duty (≤ 5e-8), contention/floating, A↔D thresholds, known I/O program, timer resolution and UART timing, HC-SR04 echo widths (exact for the model) and range limits, noise statistics, servo PWM mapping (exact), servo → physics within actuator limits over repeated cycles.

## 13. Co-simulation accuracy and limitations

One integer-ns clock; events before a physics boundary → step → events at the boundary; deterministic. Sensor geometry ≤ one physics step (8.3 ms) old; motor commands apply from the next step; pulse/echo timing exact to 1 ns (`pulseIn` integer µs); joint-linked sensors sampled per step; mixed-signal nets quasi-static (no capacitor/inductor dynamics in co-simulation); firmware timing approximate. ELECTROMECHANICAL_COSIMULATION.md.

## 14. Tests

Final run on `phase-6/electronics-embedded` (exit codes as reported by the commands):

| Command                                    | Result                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline` | 0                                                                                                                                                                                                                         |
| `pnpm lint`                                | 0                                                                                                                                                                                                                         |
| `pnpm typecheck`                           | 0                                                                                                                                                                                                                         |
| `pnpm format:check`                        | 0                                                                                                                                                                                                                         |
| `pnpm test`                                | 0 — **364 passed**, 4 skipped (opt-in benchmark and record writers of Phases 5 and 6), 42 files (Phase 5: 300)                                                                                                            |
| `pnpm build`                               | 0                                                                                                                                                                                                                         |
| `pnpm test:e2e`                            | First run: exit 1 — 63 passed, 1 failed (`assemblies.spec.ts:61`, Phase 4: 30 s timeout waiting for the app to load while swap was at 5.1/6 GB; the file passes 3/3 in isolation). **Rerun: 0 — 64 passed** (Phase 5: 56) |

New tests: core electrical commands (6), netlist/ERC/pins/interchange (10), analog validation and sparse LU (14), digital (8), firmware language and UNO runtime (13), co-simulation with real Rapier incl. arm cases (6), embedded/sensor/actuator validation (6), physics `castRay`/`setBodyTranslation` (1); browser: circuit construction in schematic and 3D, analysis, logic simulation, the acceptance workflow A (steps 1–12 from scratch in the Electronics & PCB lab), B (steps 12–22 on the demo with physics), the arm control path, and two performance runs. Updated: current-schema-version assertions (5 → 6) in 9 test files. Bugs found by tests and fixed: breakpoint evaluation in transients (charging started one step early), Servo-method arity, conditional string arguments in `Serial.print`, a stale runtime panel after pausing, a static floating-input finding on the UNO's RESET pin, and CAD delete/duplicate shortcuts that still worked outside CAD mode.

## 15. Performance (PERFORMANCE_BASELINE.md)

DC solve: 0.05 ms (10 components), 0.62 ms (100), 12 ms (500), 20 ms (1,000). Transient: 51,000 steps/s (100 components), 3,050 steps/s (1,000). Digital: 1.8 M events/s. Co-simulation (Node, 5 s): demo 62× real time (0.13 ms per physics step), arm 36× (0.24 ms). Browser (software WebGL, 3 s): both configurations keep real time (3.04 s / 3.06 s simulated), 16.7 ms median frame interval, one start-up long task, co-simulation ≈ 0.3–0.4 ms per frame, no heap growth during the run. Memory: 60 build/run/dispose cycles — ArrayBuffers flat after the WebAssembly high-water mark, heap +1.4 MB. Telemetry buffers fixed (1.2 MB for a 120 s run; oldest samples dropped).

## 16. Free disk space

9.8 GiB free at the end (11 GiB at the start). Below the 15 GB target; no downloads or large artefacts were created (records in `docs/archive` are small JSON files).

## 17. Git

Branch `phase-6/electronics-embedded` (from `main` = `67604b0`). Commits: `2d4271d` Milestone A, `6f1aac5` Milestone B, `fbfb6d4` type fix, `cc449dd` Milestone C, `b276ec4` Milestones D–E (committed together because the serial monitor and runtime panel are shared), `94c24cc` Milestone F, and the final Milestone G commit (`feat(forge): implement phase 6 electronics and embedded simulation`). Not merged, not pushed.

## 18. Known limitations and partial items

- **Level 3 emulation** not available (no emulator/toolchain offline); Arduino firmware compatibility is not claimed. Only the UNO is modelled.
- **Co-simulation analog is quasi-static**; capacitor/inductor dynamics only in Electronics-mode transient analysis.
- **Hierarchical groups and buses: PARTIAL** — in the data model and commands (and the arm sample), no dedicated UI.
- **Incremental netlist rebuilding**: not implemented; the netlist is recompiled (memoised per definition; 8 ms build at 1,000 components).
- Schematic routing is manual (bends); there is no auto-router; 3D wires are drawn as arcs and routed only in the schematic.
- Semiconductor, LED and servo parameters are generic; supply current, voltage drop, battery capacity, motor current, back-EMF and heating are not modelled; the temperature sensor is illustrative.
- HC-SR04 acoustics (surface angle, material, multipath) not modelled; the no-echo pulse width is unverified.
- No IMU, camera, LiDAR or force sensors; no DC motor, stepper or driver models; no SPI/I²C.
- `Serial.parseInt` is non-blocking; `random()` is not avr-libc's sequence; interrupt latency not modelled; LOW-level interrupts unsupported.
- Direct joint targets set in the physics panel are overridden by servo pulses at the next pulse when a servo is linked to that joint.
- No SPICE/KiCad import; SPICE-style export unverified; no PCB outputs.
- Browser acceptance steps 12–22 run on the saved sample (the mechanical pointer assembly is built by commands, as Phase 4 already tests assembly construction); steps 1–12 are performed from scratch in the UI.
- Storage below the 15 GB target; benchmarks are single short runs; one browser test timed out under memory pressure in the first full run.

## 19. Readiness for Phase 7

Ready as a foundation for experimentation: every electrical export carries a run id, circuit hash, firmware revisions and hashes, solver settings, seeds and assumptions on a timeline shared with physics telemetry; runs are deterministic and resettable; sample projects exist for repeatable experiments. Not started: experiment definitions, campaigns, comparisons and provenance across runs (Phase 7).
