# Simulation telemetry (Phase 5)

`TelemetryRecorder` (`packages/physics/src/telemetry.ts`) records each run at a fixed **simulated-time** rate (default 60 Hz, at most once per fixed step).

## Bounded storage

All samples live in one preallocated `Float64Array` ring buffer of `maxSamples` (default 6,000 = 100 s at 60 Hz) × (channels + 1). When full, the **oldest** samples are overwritten and counted (`dropped`), so memory never grows with run length. The arm's 86 channels use 4.1 MB. Events are a separate list capped at 2,000 (oldest dropped, counted). Reset reuses the buffer (200 run/reset cycles: no JS heap or ArrayBuffer growth; PERFORMANCE_BASELINE.md).

## Channels

Every channel declares a unit and what it is: **measured** (from the simulated bodies), **commanded** (targets, setpoint, raw command), **applied** (effort after saturation, saturation flag) or **configured** (payload mass).

| Group                          | Channels                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------- |
| each joint                     | position (rad/m), velocity, constraint drift (m)                                |
| each actuated joint            | target, setpoint, commanded effort, applied effort (N·m/N), saturated (0/1)     |
| each moving body (≤ 32 bodies) | position (m), orientation quaternion, linear (m/s) and angular (rad/s) velocity |
| each payload                   | mass (kg)                                                                       |
| world                          | active contact pairs                                                            |

Body channels are omitted for scenes with more than 32 moving bodies (bounded channel count). Events record contacts overloads, effort saturation, limits, rating checks, angular-speed warnings, solver-convergence warnings, external loads, payload changes, emergency stops and faults, each with its simulated time.

## Export (separate artifacts, never in the project file)

- **CSV** (`<run>.telemetry.csv`): `#` header lines with run id, time, engine/version, solver settings, project id/revision, status and dropped count; then `t [s]` and one column per channel labelled `label [unit] (kind)`.
- **JSON** (`<run>.telemetry.json`, `format: 'forge-telemetry', version: 1`): `meta` (run id, created, engine + version, solver settings, gravity, project id/name/revision, simulation name, sample rate, assumptions with statuses, overall status `approximate`), channel list, time vector, values per channel, events, dropped counts.

## Desktop

Simulation panel → Telemetry: choose a channel (angles shown in degrees), a canvas time-series plot (no charting dependency), CSV and JSON download. Pausing freezes the plot for inspection. Fuller experiment management (comparisons, provenance store) is Phase 7.
