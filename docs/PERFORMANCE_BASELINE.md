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
