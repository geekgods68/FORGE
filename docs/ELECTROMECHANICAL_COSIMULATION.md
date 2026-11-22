# Electromechanical co-simulation (Phase 6)

`CoSimulation` (`@forge/electronics/src/cosim/coordinator.ts`) runs circuits, digital logic, firmware, sensors and the Phase 5 physics session on **one clock**.

## Clock and ordering

- Time is integer nanoseconds. Physics step k ends at `round(k · h · 1e9)` ns (h = the physics timestep, 1/120 s by default, with its sub-steps) — computed from k, so the two clocks never drift apart.
- Advancing to `t_end`: run every event **strictly before** the next physics boundary → take one physics step → set the clock to the boundary → let joint-linked sensors sample the new state → record telemetry → events **at** the boundary run in the next interval. Repeat.
- Digital events and firmware run at their exact times between physics steps; mixed-signal nets are re-solved (quasi-static DC) at each event that changes them.
- Real time decides only how far to advance per display frame (`realDt × speed`, capped at 0.25 s), within a 12 ms wall-clock budget per frame; when the budget is exceeded the simulation runs slower than real time (counted as lagged frames) rather than freezing the UI. Results do not depend on frame timing (a determinism test compares two runs sample by sample).

## Data flow (the required loop)

```
physics world ──ray cast──▶ HC-SR04 model ──ECHO edges──▶ signal network ──threshold──▶ UNO input
     ▲                                                                                    │
     │                                                                              firmware (pulseIn,
Phase 5 actuator ◀──MotorCommand── servo model ◀──pulse edges── signal network ◀── Servo library frames)
 (speed/effort-limited, physics decides motion)
```

Every arrow is a declared engineering connection: the HC-SR04 is wired to UNO pins in the circuit, the servo's signal pin is wired to a UNO pin, the servo part is linked to a mate id, the sensor part to a placed component. There are no hidden callbacks: remove a wire and the loop breaks exactly where the wire was (tested with the shared ground).

## Accuracy implications

| Coupling               | Error bound / behaviour                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| Sensor geometry age    | ≤ h (8.3 ms): a target moving at v is seen up to v·h late                                                  |
| Motor command → motion | Zero-order hold: a command at time t takes effect at the next physics step (≤ h later)                     |
| Pulse / echo timing    | Exact event times (1 ns resolution); `pulseIn` reports integer µs                                          |
| Joint-linked sensors   | Sampled per physics step; encoder edges spread evenly within a step                                        |
| Analog on mixed nets   | Quasi-static: no capacitor/inductor dynamics in co-simulation (use transient analysis in Electronics mode) |
| Firmware timing        | Approximate (operation cost model, EMBEDDED_RUNTIME.md)                                                    |

## Desktop integration

Simulation mode owns the run. When the project has a circuit, the electronics controller (`features/electronics/cosim.ts`) registers with the Phase 5 simulation controller and **takes the physics steps itself**; Start/Pause/Step/Reset/speed apply to physics and electronics together. Without a physics setup the electronics panel has its own Start/Pause/Reset. Leaving Simulation mode, resetting, or a structural change rebuilds the run from t = 0. Runtime inputs — serial text, moving a fixed test target (`setBodyTranslation`), turning a manual potentiometer, pressing a switch — are never persisted and never enter the undo history.

Runtime panel: board state and errors with line numbers; serial monitor; device status (e.g. “23.4 cm → 1364 µs echo”, “1486 µs → 76.0°”); experiment inputs; instruments — oscilloscope (net voltages as recorded steps, window, trigger on a rising edge of channel 1, pause, CSV), logic analyser (lanes, timestamps, pulse width/period/duty, CSV), voltmeter and ammeter (latest mixed-signal solve), telemetry plots and CSV/JSON export; event log; cost statistics.

## Telemetry and reproducibility

`CosimRecorder`: fixed-capacity ring buffers sampled on the co-simulation clock at `recording.sampleRateHz` (default 120 Hz, 12,000 samples). Channels per device (e.g. `US1.geometric` true geometry, `US1.reported` encoded distance, `US1.echo`, `SV1.pulse`, `SV1.target`, `SV1.q` measured joint angle from physics, `SV1.supply`) and each UNO's 5 V rail. Exports (CSV, JSON) carry: run id, start time, co-simulation version, physics engine and step, project and revision, circuit name and hash, firmware names/revisions/hashes, all solver settings, assumptions, plus (JSON) serial output, per-net transitions and events. Physics telemetry continues to be recorded by the physics session on the same timeline. Campaign management (comparisons, provenance across runs) is Phase 7.
