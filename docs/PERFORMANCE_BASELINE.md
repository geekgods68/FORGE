# Performance baseline (Phase 2, facility revision 2)

**Environment:** MacBook Air M3 with 8 GB unified memory. Swap use was high during the measurements (about 5 GB used).

**Two kinds of numbers:**

- **Real GPU:** a scripted run in headed system Chrome, at a 1400 × 860 viewport.
- **Software WebGL:** the headless Playwright suite. These numbers come from the tests' own `[bench]` output.

Every value below is a measurement unless it's labelled **estimate**.

## Zone transitions

Transition time runs from the navigation request until the required zones are mounted and a frame is rendered with them.

| Measure                                    | Real GPU (headed Chrome)                                | Software WebGL (CI-style)                        |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------ |
| Warm transitions (template already loaded) | n = 76: median **9.5 ms**, p90 13.3 ms, max **18.4 ms** | n = 36: median 13.7 ms, p90 14.2 ms, max 15.8 ms |
| Cold: first facility entry (Lab 20)        | 68 ms                                                   | —                                                |
| Cold: first lab-room template              | 29 ms                                                   | —                                                |
| Cold: first environment template           | 25 ms                                                   | —                                                |
| Target                                     | < 300 ms for lightweight zones: **met**                 | **met**                                          |

Cold timings include fetching the template chunk from the local preview server. In the earlier sample run the first facility entry, which includes the first shader compilation, measured 586 ms under heavy swapping. Treat cold first-entry times as variable on this machine.

## Draw calls and geometry (real GPU, steady state, all 39 zones visited)

Each loaded set is the active zone plus its corridor.

| Zone kind                       | Draw calls per frame (whole frame, all passes)   |
| ------------------------------- | ------------------------------------------------ |
| Laboratories 1–19, 21, 22       | 31–35                                            |
| Lab 20 (with 9 workspace items) | 76 (each equipment item is still drawn per part) |
| Environments                    | 29–33                                            |
| Corridors / concourse           | 12–20                                            |
| Max triangles in any frame      | 10,960                                           |

Architecture and furnishings are instanced per (shape, material), so a room costs about 15–20 draws whatever the part count. Signs cost one draw each.

## Memory

| Measure                                                                | Result                                                                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS heap, project view → after 2 full cycles of all 39 zones (real GPU) | 7.0 MB → 14.1 MB (**+7.1 MB**). Target < 150 MB additional: **met**                                                                                                   |
| JS heap across 84 further room transitions (software GL test)          | 14.2 MB → 15.0 MB (+0.8 MB). The test fails if growth exceeds 10 MB                                                                                                   |
| GPU resources after 84 transitions back to Lab 20                      | Identical to baseline: geometry and material cache counts and refs, sign-texture count and refs, `renderer.info.memory` = {geometries 20, textures 10} (browser test) |
| **Estimated** facility GPU memory                                      | **22.5–29.0 MB** per loaded set (real GPU run), including about 21 MB of default framebuffer. Target ≤ 200 MB: **met (estimate)**                                     |

How the GPU estimate is computed: the bytes of every unique vertex and index buffer reachable from the scene, plus instance buffers, plus sign textures (RGBA8 with mips), plus the framebuffer (colour + depth, ×4 if MSAA). It excludes shader programs and driver overhead, so it isn't a driver measurement.

## Interaction

| Measure                                                                            | Result (real GPU)                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Selecting equipment in the layout layer (click → selection set and frame rendered) | 12–31 ms over 5 samples, including Playwright IPC         |
| Idle rendering                                                                     | Demand mode: no frames while idle (existing browser test) |

## Bundles (production build)

| Chunk                                                                    | Size (gzip)      | Loaded when                 |
| ------------------------------------------------------------------------ | ---------------- | --------------------------- |
| Main app                                                                 | 400 kB (121 kB)  | Start                       |
| `ZoneViews` (templates, 44 fixture recipes, signage)                     | 18.9 kB (6.7 kB) | First zone enters           |
| `LabRoom`, `Corridor`, `CorridorE`, `EnvironmentRoom`, `CentralWorkshop` | 0.3–0.5 kB each  | First zone of that template |

## Polish pass (ceilings, connector stubs, walking)

These are real-GPU measurements from a headed Chrome run.

- **Overview draw calls:** labs unchanged, because hidden ceilings aren't drawn. Corridors went from 12–20 to 14–28 (vestibule stubs).
- **Warm transitions:** median 7.9 ms, max 18.0 ms (n = 76).
- **Walking:** about 60 fps, 28–38 draws per frame, estimated 26–29 MB GPU.
- **After walking stops:** 0 idle frames.
- **JS heap:** 7.4 → 15.3 MB after visiting every zone twice.

## Earlier baselines (unchanged)

The Phase 2 maintenance numbers still stand: 5,000-object select 91 ms, edit 47 ms, import 264 ms, heap 68 MB. The vertical-slice numbers are in [PHASE_2_SLICE_REPORT.md](PHASE_2_SLICE_REPORT.md).

## Limits

- **Render timing:** measured as frame cadence and commit timing, not GPU time.
- **Swap:** heavy swapping on this 8 GB machine adds variance, especially to cold loads.
- **Headless runs:** headless numbers use software WebGL. Real-GPU numbers come from one scripted run, not repeated trials.

## Phase 4: instanced components and mechanical benchmarks

`tests/end-to-end/performance.spec.ts` writes `test-results/phase4-benchmarks.json`. Conditions: **headless Chromium, software WebGL**, MacBook Air M3 8 GB. Timings are indicative only; draw-call and instance counts are deterministic. Each scene uses 4 component configurations (hex nut, machine screw, ball bearing, SG90 servo), inserted as reusable-assembly batches of ≤ 1,000.

| Scene                       | Instanced nodes | Batches | Draw calls (frame) | Triangles | Insert (per batch) | Undo last insert |
| --------------------------- | --------------- | ------- | ------------------ | --------- | ------------------ | ---------------- |
| 100 components              | 100             | 4       | 43                 | 55,334    | 435 ms             | 45 ms            |
| 1,000 components            | 1,000           | 4       | 43                 | 551,234   | 705 ms             | 38 ms            |
| 5,000 components            | 5,000           | 4       | 43                 | 2,755,234 | 637–1,487 ms (×5)  | 630 ms           |
| Robotic arm (29 components) | —               | —       | 80                 | 7,698     | —                  | —                |
| Mixed: arm + 1,000          | 1,010           | 6       | 82                 | 558,698   | 268 ms             | —                |

- Draw calls stay **constant** in the component count. The 43 is the fixed overhead of the grid, axes, gizmo helper and lights, plus one call per batch appearance. Without instancing, each instance costs one call per appearance; that figure is derived, not measured here.
- Robotic arm: `assembly.joint.setPosition` round trip through the UI is ≈ 42–53 ms (251 ms on the first, cold call). An interference check on the arm takes 64 ms. In the mixed scene, an elbow move takes ≈ 183 ms.
- Not measured in Phase 4: frame time on a real GPU (measured in Phase 4.1, below), and VR.

## Phase 4.1: real-GPU benchmarks, facility instancing, GPU-memory estimate

### Method

- The same `performance.spec.ts` scenes, run twice on the MacBook Air M3 (8 GB):
  - **software WebGL:** the default headless Chromium (renderer reported: SwiftShader);
  - **real GPU:** `FORGE_BENCH_GPU=1` → Chromium's new headless mode with ANGLE/Metal (renderer reported: `ANGLE (Apple, ANGLE Metal Renderer: Apple M3)`). The renderer string actually used is stored with every result.
- **Render cost** = the debug hook `benchRender(30)`: renders the current view 30 times, then reads back one pixel, which cannot complete before the GPU has finished every queued draw; mean ms per frame (includes that one synchronisation). A first version used `gl.finish()`, which does not block in Chromium and gave impossible software figures (< 1 ms for 2.75 M triangles); it was replaced before any number was recorded.
- One scripted run per mode (not repeated trials). Results: `docs/archive/phase41-benchmarks-gpu.json` and `docs/archive/phase41-benchmarks-software.json`.

### Results

| Scene               | Draw calls | Triangles | Render, real GPU | Render, software | Insert per batch, GPU / software    | Undo last insert, GPU / software |
| ------------------- | ---------- | --------- | ---------------- | ---------------- | ----------------------------------- | -------------------------------- |
| 100 components      | 43         | 55,334    | 1.04 ms/frame    | 20.6 ms/frame    | 89 / 468 ms                         | 33 / 55 ms                       |
| 1,000 components    | 43         | 551,234   | 2.07 ms/frame    | 139 ms/frame     | 129 / 726 ms                        | 44 / 29 ms                       |
| 5,000 components    | 43         | 2,755,234 | 5.61 ms/frame    | 677 ms/frame     | 115–158 / 662–1,474 ms (×5 batches) | 81 / 671 ms                      |
| Robotic arm         | 80         | 7,698     | 0.77 ms/frame    | 8.80 ms/frame    | joint move 37–69 / 50–196 ms        | —                                |
| Mixed (arm + 1,000) | 82         | 558,698   | 2.33 ms/frame    | 141 ms/frame     | 93 / 410 ms; elbow move 53 / 191 ms | —                                |

- On the real GPU, 5,000 instanced components cost ≈ 5.6 ms of GPU-complete render time per frame (≈ 180 frames/s of headroom); software WebGL is two orders of magnitude slower, which is why Phase 4's software insert timings were dominated by the first frame.
- Insert/undo latencies on the GPU run are command + first-frame round trips through the UI (as in Phase 4).
- **Not measured:** interactive frame pacing with a visible window and compositor, sustained thermal behaviour, VR.

### Facility-view instancing

Phase 4 drew repeated components instanced in the project view only. Phase 4.1 renders the project through one `ProjectContent` component in **both** views (in the facility it sits inside the bench mount frame, as a sibling of the project root, so instance matrices stay in the project frame). Browser-tested: the arm on bench C in Lab 20 draws its 4 screws + 4 nuts in 2 batches, and selecting a nut takes it out of its batch. Clicks on instances are ignored in layout mode and while walking, like individually drawn bodies. The facility zone-resource tests (resources return to baseline) still pass.

### GPU-memory debug readout (corrected)

`__forge.gpuEstimate()` is now `rendering/gpuEstimate.ts`, unit-tested, and always labelled `kind: 'estimate'`; it is never shown in the UI. The Phase 4 report's claim that it ignored instance buffers was **not reproducible** (8 instanced fasteners → 512 B, exactly 8 × 64 B; browser-tested), but the readout had real inaccuracies, now fixed:

- vertex/index data counted **once per underlying buffer** (interleaved attributes and shared buffers were counted once per attribute);
- instance colours and morph targets included;
- every distinct material texture counted (RGBA8, ×4/3 with mipmaps), not only signs.

It remains an estimate (no driver measurement exists in WebGL): no shader programs, driver padding, compressed formats or render targets.

## Phase 5: physics simulation

Machine: MacBook Air M3, 8 GB, macOS 26 (Darwin 25.5). Rapier 0.19.2, fixed step 1/120 s × 4 sub-steps × 8 iterations. Single short runs (the disk was below the 8 GB threshold for long benchmark suites, see PHASE_5_REPORT.md). Raw data: `docs/archive/phase5-physics-benchmarks.json`, `phase5-browser-benchmarks-software.json`, `phase5-browser-benchmarks-gpu.json`.

### Physics step (Node.js, no rendering; `FORGE_BENCH=1 pnpm vitest run packages/physics/src/__tests__/benchmark.test.ts`)

50 mm boxes falling in layers onto the work surface and settling (contact-heavy), 240 fixed steps:

| Scene                                      | Step mean | p95     | max                 | Real-time factor @120 Hz | Contact pairs |
| ------------------------------------------ | --------- | ------- | ------------------- | ------------------------ | ------------- |
| 10 boxes                                   | 0.15 ms   | 0.19 ms | 4.4 ms (first step) | 56×                      | 10            |
| 100 boxes                                  | 0.79 ms   | 0.98 ms | 1.5 ms              | 10.6×                    | 100           |
| 500 boxes                                  | 3.79 ms   | 4.05 ms | 4.8 ms              | 2.2×                     | 900           |
| 1,000 boxes                                | 9.0 ms    | 13.4 ms | 15.1 ms             | 0.92×                    | 4,781         |
| Robotic arm (13 bodies, 4 actuated joints) | 0.15 ms   | 0.19 ms | 1.4 ms              | ≈ 54×                    | —             |

Collision processing dominates the large cases (step time tracks contact pairs). Model build (bridge + world): 3–27 ms.

### Memory and telemetry

- Telemetry is a preallocated ring buffer: the arm's 86 channels × 6,000 samples = 4.1 MB; scenes with more than 32 moving bodies record only joint/world channels (94 KiB).
- **200 run → pause → reset cycles** (arm, forced GC): JS heap +0.3 MB, ArrayBuffers +0 MB — no leak. Process RSS +21 MB. WASM linear memory is never returned to the OS, so RSS reflects Rapier's high-water mark; only the start and end of the 200 cycles were measured, so whether RSS plateaus was not established. (Before reusing the telemetry buffer on reset, 50 cycles without forced GC showed +20 MB of ArrayBuffers awaiting collection.)

### In the browser (`tests/end-to-end/physics-performance.spec.ts`, 3 s of real time each)

| Scene       | Renderer              | Frame interval median / p95 | Simulated / real time  | Physics step mean | Long tasks | JS heap |
| ----------- | --------------------- | --------------------------- | ---------------------- | ----------------- | ---------- | ------- |
| 100 boxes   | software WebGL        | 16.7 / 16.7 ms              | 3.06 s / 3 s           | 0.78 ms           | 0          | 31.6 MB |
| 1,000 boxes | software WebGL        | 33.4 / 50 ms                | 1.55 s / 3 s (lagging) | 7.8 ms            | 0          | 54.2 MB |
| Robotic arm | software WebGL        | 16.7 / 16.7 ms              | 3.04 s / 3 s           | 0.19 ms           | 0          | 42.6 MB |
| 100 boxes   | GPU (ANGLE Metal, M3) | 16.7 / 16.7 ms              | 3.04 s / 3 s           | 1.07 ms           | 0          | —       |
| 1,000 boxes | GPU (ANGLE Metal, M3) | 16.7 / 33.3 ms              | 2.23 s / 3 s (lagging) | 9.4 ms            | 0          | —       |
| Robotic arm | GPU (ANGLE Metal, M3) | 16.7 / 16.7 ms              | 3.04 s / 3 s           | 0.25 ms           | 0          | —       |

**Main-thread responsiveness:** the first 1,000-box run froze the page (frames grew to 250 ms because each frame ran up to 16 catch-up steps of ~10 ms). The display loop now also has a **12 ms physics budget per frame** (at least one step): the simulation runs slower than real time (reported as lag) and the UI stays interactive with no long tasks. Results are unaffected (every step is the same fixed step). Physics runs on the main thread; a worker is a possible later optimisation.

## Phase 6: electronics and co-simulation

Single short runs on Apple M3, 8 GB (darwin 25.5.0); Node benchmark `FORGE_BENCH=1` (`packages/electronics/src/__tests__/benchmark.test.ts`, record `docs/archive/phase6-electronics-benchmarks.json`) and browser benchmark `tests/end-to-end/electronics-performance.spec.ts` (headless Chromium, **software** WebGL; record `docs/archive/phase6-browser-benchmarks-software.json`). Indicative, not guarantees.

### Circuit solver

| Passive components (resistor mesh, every 4th a capacitor) | Nets | Build (netlist + elements) | DC solve (median) |
| --------------------------------------------------------: | ---: | -------------------------: | ----------------: |
|                                                        10 |    9 |                   10.52 ms |          0.053 ms |
|                                                       100 |   62 |                    1.69 ms |           0.62 ms |
|                                                       500 |  276 |                    5.96 ms |         12.298 ms |
|                                                      1000 |  529 |                    8.48 ms |             20 ms |

| Transient (1,000 steps of 1 µs, linear: LU reused) | Wall time |     Throughput |
| -------------------------------------------------: | --------: | -------------: |
|                                     100 components |   19.6 ms | 51,146 steps/s |
|                                    1000 components |  327.7 ms |  3,051 steps/s |

Nonlinear DC: 50 LED + resistor branches solve in 0.65 ms (2 Newton iterations from the previous solution).

The 10-component build time includes JIT warm-up of the first call. The 1,000-component DC solve (20 ms) is dominated by the Markowitz pivot search, which scans all active columns per pivot (O(n·nnz)); a column-count priority queue would reduce it if larger circuits become common.

### Digital events

A 1 MHz clock through a 200-gate chain for 2 ms of simulated time: 804,399 events in 440.1 ms → **1,827,743 events/s**. The transition log is a fixed 1.05 MB ring buffer.

### Co-simulation (Node, 5 simulated seconds)

| Configuration              | Wall time | Real-time factor | Physics steps | Wall per physics step | Physics share | Events | Analog solves | Firmware ops | Telemetry buffers |
| -------------------------- | --------: | ---------------: | ------------: | --------------------: | ------------: | -----: | ------------: | -----------: | ----------------: |
| Arduino–HC-SR04–servo demo |     81 ms |              62× |           600 |              0.134 ms |          56 % |  1,987 |             1 |        6,088 |            1.9 MB |
| Four-joint arm control     |    141 ms |            35.5× |           600 |              0.235 ms |          72 % |  3,055 |             1 |        5,975 |            3.1 MB |

Both configurations have only digital signal nets, so the analog network is solved once (power rails); a circuit with mixed nets re-solves at each driver change.

### Browser (Simulation mode, 3 s real time, software WebGL)

| Configuration              | Simulated / real | Frame interval median / p95 | Long tasks (longest) | JS heap (growth) | Co-simulation per frame       |
| -------------------------- | ---------------: | --------------------------: | -------------------: | ---------------: | ----------------------------- |
| Arduino–HC-SR04–servo demo |    3.044 s / 3 s |              16.7 / 16.8 ms |           1 (160 ms) |     28 MB (0 MB) | last advance 0.3 ms (max 7.5) |
| Four-joint arm control     |    3.061 s / 3 s |              16.7 / 16.8 ms |            1 (58 ms) |   37.8 MB (0 MB) | last advance 0.4 ms (max 7.7) |

The single long task per run occurs when the run starts (building the circuit, compiling firmware, first frames); steady-state frames stay at the 60 Hz display interval and the simulation keeps real time.

### Memory and resource cleanup

60 build → 0.5 s run → dispose cycles of the demo (forced GC): heap 38.8 → 39.2 → 39.5 → 40.2 MB at 0/10/30/60 cycles; ArrayBuffers 1.1 → 3.9 → 3.9 → 3.9 MB (one step to the WebAssembly high-water mark, then flat — no leak).

Telemetry buffers are fixed-capacity: a 120 s blink run used 1.24 MB at the start and 1.24 MB at the end (12,000 samples kept, 2,401 oldest dropped). Nothing is written to disk unless the user exports.

## Phase 7: research campaigns

Single short runs on Apple M3, 8 GB (darwin 25.5.0, Node v24.2.0, GC exposed); Node benchmark `FORGE_BENCH=1` (`packages/research/src/__tests__/benchmark.test.ts`, record `docs/archive/phase7-research-benchmarks.json`) and browser benchmark `tests/end-to-end/research-performance.spec.ts` (headless Chromium, **software** WebGL; record `docs/archive/phase7-browser-benchmarks.json`). Indicative, not guarantees. Campaigns run sequentially (one concurrent run).

### Campaign throughput and overheads (Node, in-memory run-data store)

| Campaign                                                       | Runs | Wall time | Runs/s | Simulation share | Scheduling overhead / run | Raw data (encoded) | Research document | Analysis | Integrity check (all runs) | Resume (all reused) |
| -------------------------------------------------------------- | ---: | --------: | -----: | ---------------: | ------------------------: | -----------------: | ----------------: | -------: | -------------------------: | ------------------: |
| RC transient, random R (10,000 steps of 2 µs, 20 kHz sampling) |   10 |    115 ms |   86.9 |             89 % |                   1.31 ms |              87 kB |             33 kB |   0.8 ms |                     1.0 ms |              4.5 ms |
| same                                                           |   50 |    451 ms |  110.8 |             94 % |                   0.59 ms |             434 kB |            156 kB |   0.3 ms |                     5.2 ms |             17.7 ms |
| same                                                           |  100 |    876 ms |  114.2 |             94 % |                   0.52 ms |             869 kB |            310 kB |   0.4 ms |                    10.3 ms |             33.8 ms |
| RC 2-variable grid 5 × 5 (100 kHz sampling, 60 ms)             |   25 |    695 ms |   36.0 |             97 % |                   0.74 ms |             3.2 MB |             79 kB |   0.2 ms |                     2.7 ms |              8.9 ms |
| Ultrasonic controllers, paired seeds (co-sim, 4 s)             |   10 |    887 ms |   11.3 |             98 % |                   2.02 ms |             141 kB |             51 kB |   3.6 ms |                     2.0 ms |             14.6 ms |
| Ultrasonic sensor-noise study, replicated (co-sim, 4 s)        |    9 |    779 ms |   11.6 |             98 % |                   2.16 ms |             127 kB |             46 kB |   3.3 ms |                     1.8 ms |             14.2 ms |
| Arm payload study (physics, 2 s, 120 Hz)                       |    9 |    607 ms |   14.8 |             97 % |                   2.38 ms |             235 kB |             48 kB |   0.2 ms |                     1.4 ms |             22.8 ms |
| Arm payload study, 64 signals recorded (protocol maximum)      |    9 |  2,350 ms |    3.8 |             99 % |                   2.34 ms |             3.7 MB |             67 kB |   0.4 ms |                     2.3 ms |             21.8 ms |

- **Planning overhead:** plan generation took 0.1–0.6 ms for every campaign (budget checks happen before enumeration).
- **Scaling:** 10 → 100 runs is linear (≈ 8.7 ms per RC run); per-run scheduling overhead (configuration hashing, parameter application on a project copy, outcome computation, record hashing) is 0.5–2.4 ms, 1–11 % of wall time.
- **Telemetry cost:** recording 64 signals instead of the measured few multiplies wall time by ≈ 3.9 and raw data by ≈ 16 (resampling and hashing dominate). Physics telemetry is recorded once per physics step, so a higher requested rate cannot add physics samples (a 1 kHz request on the 120 Hz arm stored the same bytes as 120 Hz).
- **Memory:** JS heap change across each campaign (forced GC before and after) was between −3.4 and +3.5 MB, i.e. no growth attributable to campaigns at these sizes. Raw data lives in the run-data store, not in the research document.
- **Recovery:** relaunching a finished campaign reuses every run after re-verifying its configuration and data hashes: 4.5–34 ms for 10–100 runs, with no re-simulation.

### Browser (Research mode, headless Chromium, software WebGL)

| Campaign                     | Runs | Wall time | Frame interval median / p95 / max | Long tasks | JS heap (growth) | IndexedDB growth (estimate) |
| ---------------------------- | ---: | --------: | --------------------------------: | ---------: | ---------------: | --------------------------: |
| Arm payload template (A)     |    9 |    646 ms |             16.7 / 33.3 / 33.4 ms |          0 |   33.5 MB (0 MB) |                       72 kB |
| RC sweep template (D, 3 × 3) |    9 |    304 ms |             16.7 / 16.8 / 16.8 ms |          0 |   33.5 MB (0 MB) |                      772 kB |

The scheduler yields between runs and between simulation chunks: no long task (> 50 ms) occurred and the worst frame interval was 33 ms (one skipped frame). `performance.memory` is coarse-grained in Chromium and `navigator.storage.estimate()` is approximate, so heap and storage figures are indicative only. Campaigns this short do not establish behaviour for multi-hour campaigns; budgets (200 runs, 64 MB raw data by default) bound what a single campaign can do.

### Not measured

Concurrent runs (not supported in Phase 7: one run at a time), Web Worker execution (runs share the main thread, yielding), and campaigns approaching the 64 MB raw-data budget in the browser.
