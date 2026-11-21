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

## Earlier baselines (unchanged)

The Phase 2 maintenance numbers still stand: 5,000-object select 91 ms, edit 47 ms, import 264 ms, heap 68 MB. The vertical-slice numbers are in [PHASE_2_SLICE_REPORT.md](PHASE_2_SLICE_REPORT.md).

## Limits

- **Render timing:** measured as frame cadence and commit timing, not GPU time.
- **Swap:** heavy swapping on this 8 GB machine adds variance, especially to cold loads.
- **Headless runs:** headless numbers use software WebGL. Real-GPU numbers come from one scripted run, not repeated trials.
