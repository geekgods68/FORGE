# Digital twins (Phase 8)

Package: `@forge/digital-twin` (pure, deterministic; the host clock is passed in). Desktop: Digital twin work mode (`apps/desktop/src/features/twin/`). Bridge: `tools/serial-bridge/`.

## Data separation

| Data                  | Where                                             | Notes                                                                                                                                                       |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engineering model     | project document                                  | never written by the twin; the virtual pose is shown through the viewport **preview** (an engine dry run), so telemetry never enters the undo history       |
| Twin configuration    | twin document `<ns>:twin:<projectId>` (schema v1) | device identity, channel → component mappings, units, calibration, sensor frames, assumptions, uncertainties, evidence ids; validated, versioned (revision) |
| Transient telemetry   | pipeline memory                                   | bounded ring buffers per channel (100 000 samples)                                                                                                          |
| Recorded observations | IndexedDB (`<ns>-twin-recordings`)                | raw lines + host offsets + transport transitions + SHA-256; exportable to Phase 7 datasets                                                                  |

## Designations (evidence-based, `designate()`)

| Level                 | Requires                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| virtual-model         | a FORGE engineering model                                                                            |
| simulated-system      | a simulation or circuit setup                                                                        |
| telemetry-connected   | mapped channels and a **non-synthetic** recording                                                    |
| synchronised          | that recording with p95 latency ≤ 50 ms and ≤ 1 % missing messages                                   |
| calibrated            | a Phase 7 calibration against a physical twin dataset                                                |
| empirically-validated | a validation record "agrees" on an **independent** (not used for calibration), non-synthetic dataset |

Synthetic data never raises the level. As delivered (no physical recording), the VEYRIS twin is at most **simulated-system**.

## Operating modes

- **Simulation** — the virtual system alone (Simulation/Research modes run it).
- **Observation** — a device feeds the pipeline. **Read-only**: no adapter can write, the protocol has no command message, the bridge has no write endpoint.
- **Replay** — a recording is replayed deterministically (bit-identical series, statistics and diagnostics; tamper and relabel detection by hash).
- **Comparison** — observed vs simulated on one timeline: the co-simulation of the project is interpolated at the OBSERVED times; missing observations are excluded and counted; MAE, RMSE, max, bias, residual series and the best timeline lag (reported, not applied).

## Telemetry pipeline

Sequence numbers (16-bit, unwrapped) and device time (32-bit `millis`, unwrapped); duplicates dropped; out-of-order messages held for 100 ms and released in order (later ones flagged _late_); gaps counted as missing messages; empty values are missing samples (never zero, never simulated values); device restarts start a new epoch. Clock fit: the least-delayed message per 50 ms device-time bucket over 30 s; drift = least-squares slope through those minima; offset = lower envelope; latency mean/p95 above it. Sample times use the DEVICE clock mapped to the host timeline (no transport jitter). Link state: _waiting_, _live_, _delayed_ (p95 > 250 ms), _stale_ (no message for the twin's stale time, default 500 ms), _disconnected_, _replay_. Interpolation is explicit (hold or linear) with a maximum gap; gaps beyond it stay missing.

State kinds are carried from the device declaration: **measured**, **commanded**, **estimated**; simulated values come only from FORGE's simulators. The VEYRIS wrist servo has no position sensor: its angle is **commanded** and labelled so everywhere.

## Transports

| Transport                            | Where it works                                                                                                                 | Notes                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Serial                           | Chromium desktop browsers (Chrome, Edge) on localhost/HTTPS                                                                    | the browser's port chooser is the authorisation; only `port.readable` is used                                                                 |
| Local bridge (`tools/serial-bridge`) | any browser that can reach 127.0.0.1 (Safari, Firefox, Chrome) on the computer with the Arduino; Windows and macOS (and Linux) | Node ≥ 22, no dependencies; one named USB-serial device, read-only; SSE on 127.0.0.1 with a per-run token and origin allowlist; GET only      |
| Synthetic                            | everywhere                                                                                                                     | deterministic, seeded, labelled SYNTHETIC; faults: drops, duplicates, reordering, corruption, no-echo, disconnects, stalls, drift, wrong unit |
| Replay                               | everywhere                                                                                                                     | from IndexedDB                                                                                                                                |

**Meta Quest 2**: its browser has no Web Serial and cannot reach another computer's 127.0.0.1; FORGE binds only to loopback (project rule). Live telemetry on the Quest therefore needs a future, permissioned LAN relay (not part of Phase 8). There is no WebXR mode in FORGE yet (MASTER_SPEC lists VR as future).

## Safety

Physical actuation is **not implemented** (`ACTUATION_POLICY`; `requestActuation()` always refuses). Loading a project, simulating, replaying or running experiments cannot move hardware: no code path writes to a device. A software refusal is not a safety system: physical rigs need a hardware emergency stop and independent protection.

## Verification

Tests cover normal connection, disconnection/reconnection, invalid and corrupted messages, missing samples, duplicates, out-of-order packets, stale telemetry, 100 ppm clock drift (±30 ppm), sensor noise, wrong unit and wrong component mappings, replay identity, simulation-vs-observation comparison (lag recovered to 0.02 s), actuation boundaries, and the reference firmware running on FORGE's virtual UNO against the simulated arm (distance within 1.5 mm of the sensor model; commanded angle within 2° of the decoded servo target). These verify SOFTWARE behaviour; none establishes empirical accuracy. **No physical hardware was connected during Phase 8.**
