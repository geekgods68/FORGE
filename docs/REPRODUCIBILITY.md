# Reproducibility (Phase 7)

## What each run record holds

- Experiment id and **revision**; condition id, label and variable values; replicate index.
- Immutable run configuration: applied parameter values (target, value, unit), runtime values, seed, duration, sampling, model kind — hashed as `configHash` (SHA-256 of canonical JSON).
- Model fingerprint (SHA-256 of the model-relevant project content) and software versions (`forge-research 1`, physics/electronics engine versions, Rapier version, RNG id `mulberry32 v1`).
- State history with timestamps; simulated time, steps, wall time; warnings and errors.
- Outcomes with value, unit, status, sample counts, missing and interpolated counts, method and warnings.
- Raw data reference: store key + SHA-256 of the data.
- `integrityHash` over all of the above. `verifyIntegrity` recomputes it; the UI shows "integrity verified" or "INTEGRITY CHECK FAILED".

## Seeds

`deriveSeed(base, ...labels)` takes the first 31 bits of SHA-256 of `base|label|…` — stable across platforms and independent between streams. Each run's seed derives from the design's base seed and its condition/replicate (paired designs omit the condition so conditions share seeds per replicate). The seed is written into the co-simulation settings of the run's project copy, so sensor noise and other stochastic devices are reproducible. Sampling designs (random, LHS, Monte Carlo) draw from `mulberry32` seeded the same way.

## Determinism

- Same build, same environment, same configuration and seed: the run is deterministic (verified in tests by re-running and comparing outcomes and data hashes; `replayConsistency` reports spread among records sharing a `configHash`).
- Duplicate detection: a planned run whose `configHash` matches a completed record is **reused**, not re-simulated, after its raw data hash is verified.
- Bitwise identity across browsers, CPUs, operating systems or engine versions is **not** claimed.

## Failure, cancel and recovery

Cancellation stops between simulation chunks; the partial run becomes CANCELLED with no outcomes. A failed run keeps its error. Retrying creates a new record (`retryOf`). Relaunching a campaign reuses completed runs and simulates only the missing ones. A raw-data blob that is missing or whose hash does not match is reported as such; summary outcomes remain available, the trace is not shown, and the report is marked **Incomplete**.

## Export

`forge-research-export` v1 bundles the experiment, its run records, calibration/validation/dataset records and (optionally) raw data encoded as base64 Float64 arrays. Import re-validates schemas, recomputes integrity hashes and data hashes, and reports problems instead of silently accepting altered data.
