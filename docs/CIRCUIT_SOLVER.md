# Circuit solver (Phase 6)

`@forge/electronics/src/analog` — modified nodal analysis (MNA) with a sparse LU, Newton–Raphson for nonlinear devices and companion-model transient integration. Validation: ELECTRICAL_VALIDATION.md.

## Formulation

Unknowns: the voltage of every net with a DC path to the reference (ground = 0 V), one branch current per voltage-defining element (voltage source, VCVS, inductor) and one internal node per diode with series resistance. KCL rows sum the currents **leaving** each node. Branch unknowns are the current entering terminal a (a→b through the element); reported element currents use the same a→b convention (a source delivering power therefore reports a negative current).

| Element               | Stamp                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| R                     | conductance 1/R                                                                                    |
| V (series R ≥ 0)      | branch row `v_a − v_b − R_s·i = E(t)`                                                              |
| I                     | current E(t) out of `pos` into the circuit                                                         |
| C (transient)         | trapezoidal `G = 2C/h`, `I_eq = G·v_n + i_n`; backward Euler `G = C/h`, `I_eq = G·v_n`. Open in DC |
| L                     | branch row; DC `v = 0`; TR `v − (2L/h)·i = −(2L/h)·i_n − v_n`; BE `v − (L/h)·i = −(L/h)·i_n`       |
| VCVS / VCCS           | `v_out = A·v_ctl` (branch row) / `i = g_m·v_ctl` from out+ to out− through the source              |
| Switch / limit switch | closed: R_on; open: absent                                                                         |
| Potentiometer         | two resistors `R·p`, `R·(1−p)`; each end clamped to 0.01 % of the track                            |
| Diode / LED           | Shockley `I = Is(e^{v/nV_T} − 1)` + gmin, optional series R, linearised per iteration              |
| NPN                   | Ebers–Moll transport model (Is, βF, βR), full 3×3 Jacobian                                         |
| N-MOSFET              | Shichman–Hodges level 1 (V_th, K, λ), source/drain swap for symmetric operation                    |

V_T at the SPICE nominal 27 °C = 25.865 mV. The `gmin` setting (default 1e-12 S) is added in parallel with every junction — **not** from every node to ground, so a floating node is never given a fabricated 0 V.

## Linear algebra

`analog/sparse.ts`: right-looking Gaussian elimination on row maps with **Markowitz** pivot selection (minimum `(r−1)(c−1)` fill) under **threshold partial pivoting** (`|pivot| ≥ 0.1 · max|column|`) — required because voltage-source rows have zero diagonals. Factors (elimination operations + U rows) are stored, so a linear circuit at a fixed step is factored once and re-solved per step (transient throughput in PERFORMANCE_BASELINE.md). A pivot below `1e-14 · max|A|` is reported as singular, naming the undetermined net voltage or branch current.

## Before factorisation: topology checks

1. **Reference**: no reference net → `missing-reference`.
2. **DC connectivity** (union–find over conducting elements; capacitors conduct only in transient): nets without a path to the reference are excluded and reported as _undefined_ (`null` voltage). A current source or VCCS output into an isolated net → `current-source-no-path`. A gate/control terminal on an isolated net while the device is otherwise in the circuit → `floating-control`.
3. **Ideal voltage loops** (sources with zero series R, VCVS outputs, inductors in DC): a loop → `voltage-source-loop` naming its members; both terminals on one net → `shorted-source`.

## DC operating point

Newton–Raphson from zero (or the previous solution) with SPICE `pnjlim` junction-voltage limiting; convergence when every unknown changes by less than `relTol·|x| + absTol` (V for nodes, A for branches). Linear circuits take one solve. On non-convergence: **source stepping** (sources ramped 10 % → 100 %), reported as a warning; if that fails, `non-convergence` with the nonlinear devices named. Initial conditions for transients: capacitors with an IC are replaced by ideal sources and inductors with an IC by current sources for the t = 0 solve.

## Transient

- Fixed step `h`, shortened to land exactly on every source breakpoint (step edges, pulse corners, PWL points, sine delay).
- A step that ends on a breakpoint evaluates sources at their **left limit**; the next step starts with **backward Euler** (also the first step after t = 0), then trapezoidal — the standard way to avoid trapezoidal ringing after discontinuities. Method selectable (trapezoidal default, or backward Euler throughout).
- Newton failure at a step → the step is halved up to 10 times, then `step-failure` with the time and cause.
- **Stiffness heuristic**: if `h` exceeds the smallest estimated RC or L/R time constant (from the conductance diagonal), a warning says that dynamic is under-resolved.
- Output decimated to at most `maxPoints` (default 20,000), reported.

Accuracy (measured, ELECTRICAL_VALIDATION.md): RC max error 0.25 mV at h = τ/100 with error ratio 3.97 when halving h (second order); RLC max error 0.12 mV at 400 steps per period; switched RC 0.25 mV through ideal discontinuities.

## What the solver does not do

No adaptive local-truncation-error step control, no AC/small-signal or noise analysis, no temperature dependence (fixed 27 °C), no junction capacitance, breakdown, high-injection or other second-order semiconductor effects, no transmission lines, no magnetic coupling, no electro-thermal coupling. Semiconductor models use generic parameters and are **approximate** at best; they are not device-accurate.

## Failures never fabricate values

Every failure path returns `{ ok: false, diagnostics }` with a code, a message, and the elements and nets involved; the UI shows the diagnostics instead of a table of numbers.
