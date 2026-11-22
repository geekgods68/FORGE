# Scientific measurements (Phase 7)

## Signals

The signal catalogue is derived from the model (`signalCatalog`):

- **physics**: the Phase 5 session telemetry channels — per joint `<mate>.q`, `.qd`, `.drift`, and for actuated joints `.target`, `.setpoint`, `.cmd`, `.effort` (N·m or N) and `.sat` (0/1 at the effort limit); per tracked body kinematic channels; per payload `<id>.mass`.
- **cosim**: the physics signals plus device signals (e.g. `US1.reported` and `US1.geometric` distance in m, `SV1.target` and `SV1.angle`) and `logic:<net>` digital levels.
- **circuit**: node voltages `V(<net>)` (V) and branch currents `I(<part>)` (A).

Recorded signals are resampled onto the protocol's sampling grid. Continuous signals are linearly interpolated **between recorded samples**; the count of interpolated values is kept with every outcome. Hold signals (logic levels, servo targets, firmware outputs) use zero-order hold. Samples are never fabricated beyond the recorded span.

## Reductions

max, min, mean (time-weighted), rms, std, final, initial, range, peak-abs, settling-time (band fraction or absolute band), overshoot, iae (∫|x| dt), time-above, count-above, crossings, change-count, frequency (from rising edges), duty-cycle, pulse-width, first-crossing (linear interpolation of the crossing time).

Every reduction applies to the analysis window `[fromS, toS]` (warm-up excluded).

## Derived measurements

`expression` over aliases bound to signals, e.g. `abs(q - target)` with `q = j-shoulder.q`, `target = j-shoulder.target`. The parser checks dimensions: adding or comparing quantities with different units is rejected before the run; the result unit is computed (radians are tracked as a dimension, so effort × angular velocity is N·m·rad/s, not silently W).

## Missing data

Missing or non-finite samples are **excluded, never treated as zero**, and counted. An outcome whose window has no valid samples is `missing` with a reason; a **required** measurement that is unavailable makes the run FAILED ("Required measurement unavailable: …"), so a run with a silently empty result is never counted as completed. Undefined quantities (no step for settling time, no crossing for first-crossing, fewer than two edges for frequency) return no value with a warning rather than a misleading number.
