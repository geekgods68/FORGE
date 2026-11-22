# Electrical validation (Phase 6)

Numerical reference cases for the circuit solver, digital engine, embedded runtime, sensor and actuator models. Each case states its conditions, solver configuration, the analytical or independently established reference, tolerances fixed **before** comparison, and the measured error. All cases run in every `pnpm test`; `FORGE_VALIDATION_OUT=1` rewrites the full record, `docs/archive/phase6-validation.json`.

Record: forge-cosim 1; rapier3d-compat 0.19.2, generated 2026-11-22T08:53:47.233Z. **24 of 24 cases pass.**

Passing a case validates that case only. It does not make a model “verified” for other circuits, devices or conditions (SIMULATION_VALIDITY.md).

## Summary

| Case                                                                                               | Category    | Result |
| -------------------------------------------------------------------------------------------------- | ----------- | ------ |
| Series/parallel resistors and a voltage divider (DC) (`dc-resistive`)                              | resistive   | pass   |
| Current source and controlled sources (DC) (`dc-sources`)                                          | resistive   | pass   |
| RC charging (time constant) (`rc-charging`)                                                        | capacitive  | pass   |
| RC discharging (time-constant measurement) (`rc-discharging`)                                      | capacitive  | pass   |
| RL step response (`rl-step`)                                                                       | inductive   | pass   |
| Series RLC step response (underdamped) (`rlc-underdamped`)                                         | rlc         | pass   |
| Switched RC (pulse source with breakpoints) (`switched-rc`)                                        | capacitive  | pass   |
| Diode–resistor operating point (nonlinear DC) (`diode-resistor`)                                   | nonlinear   | pass   |
| NMOS square-law operating points (saturation and triode) (`nmos-switch`)                           | nonlinear   | pass   |
| NPN forward-active operating point (Ebers–Moll) (`npn-active`)                                     | nonlinear   | pass   |
| Numerical failures are reported, not fabricated (`solver-diagnostics`)                             | diagnostics | pass   |
| Large networks: R-2R ladder (closed form) and a 1,740-resistor mesh (KCL) (`large-networks`)       | resistive   | pass   |
| Gate truth tables and unknown-value propagation (`truth-tables`)                                   | digital     | pass   |
| Propagation delay and inertial filtering (`propagation`)                                           | digital     | pass   |
| Counter and D flip-flop (toggle) on a 1 MHz clock (`sequential`)                                   | digital     | pass   |
| PWM duty cycle (`pwm-duty`)                                                                        | digital     | pass   |
| Output contention and floating inputs are explicit (`contention`)                                  | digital     | pass   |
| Digital output → analog divider → digital input thresholds (`ad-boundary`)                         | digital     | pass   |
| Known input/output program: arithmetic, pin mapping, delays (`embedded-io`)                        | embedded    | pass   |
| Timer resolution and UART timing (`embedded-timing`)                                               | embedded    | pass   |
| HC-SR04: known distance → echo duration; range limits; no-echo timeout (`sensor-echo`)             | sensor      | pass   |
| HC-SR04 noise model: unbiased, configured σ, reproducible (`sensor-noise`)                         | sensor      | pass   |
| PWM command → servo target (Servo library mapping, pulse decoding) (`servo-pwm`)                   | actuator    | pass   |
| Servo command → Phase 5 joint motion within the actuator limits; repeated cycles (`servo-physics`) | actuator    | pass   |

## Resistive circuits

### Series/parallel resistors and a voltage divider (DC)

- **Conditions:** 10 V ideal source; R1 = 1 kΩ in series with R2 = 2 kΩ ∥ R3 = 6 kΩ; divider R4 = 3 kΩ / R5 = 7 kΩ.
- **Solver:** MNA, sparse LU (Markowitz + threshold pivoting); linear: one factorisation
- **Reference:** Ohm’s law: R2∥R3 = 1.5 kΩ, V(MID) = 10·1.5/2.5 = 6 V, V(DIV) = 10·7/10 = 7 V; Kirchhoff’s current and voltage laws.

| Quantity                | Reference | Measured | Error      | Tolerance | Pass |
| ----------------------- | --------- | -------- | ---------- | --------- | ---- |
| V(MID)                  | 6 V       | 6 V      | 0 V        | 1e-09 V   | yes  |
| V(DIV)                  | 7 V       | 7 V      | 8.88e-16 V | 1e-09 V   | yes  |
| source current          | 0.005 A   | 0.005 A  | 8.67e-19 A | 1e-12 A   | yes  |
| KCL residual at MID     | 0 A       | 0 A      | 0 A        | 1e-12 A   | yes  |
| KVL residual (V1–R1–R2) | 0 V       | 0 V      | 0 V        | 1e-09 V   | yes  |

### Current source and controlled sources (DC)

- **Conditions:** I = 2 mA into 1 kΩ; VCVS gain 3 into 10 kΩ; VCCS 1 mS (out+ → out−) into 2 kΩ.
- **Solver:** MNA, sparse LU (Markowitz + threshold pivoting); linear: one factorisation
- **Reference:** V(IN) = 2 mA·1 kΩ = 2 V; V(OUT) = 3·2 V = 6 V; VCCS current 1 mS·2 V = 2 mA flows GND→GOUT through the source, so V(GOUT) = 2 mA·2 kΩ = 4 V.

| Quantity | Reference | Measured | Error | Tolerance | Pass |
| -------- | --------- | -------- | ----- | --------- | ---- |
| V(IN)    | 2 V       | 2 V      | 0 V   | 1e-09 V   | yes  |
| V(OUT)   | 6 V       | 6 V      | 0 V   | 1e-09 V   | yes  |
| V(GOUT)  | 4 V       | 4 V      | 0 V   | 1e-09 V   | yes  |

### Large networks: R-2R ladder (closed form) and a 1,740-resistor mesh (KCL)

- **Conditions:** 200-stage R-2R ladder (R = 1 kΩ) from 1 V; 30 × 30 mesh of 100–400 Ω resistors from 5 V (solve 106.9 ms).
- **Solver:** MNA, sparse LU (Markowitz + threshold pivoting); linear: one factorisation
- **Reference:** Ladder: V(T_k) = V(T_1)·2^−(k−1), V(T_1) = R/(R + 1 µΩ) (every tap looks into R to ground). Mesh: Kirchhoff’s current law at every internal node, computed independently from the solved voltages.

| Quantity                                | Reference | Measured   | Error      | Tolerance | Pass |
| --------------------------------------- | --------- | ---------- | ---------- | --------- | ---- |
| ladder worst relative error (taps 2…40) | 0         | 0          | 0          | 1e-09     | yes  |
| mesh worst KCL residual                 | 0 A       | 4.52e-17 A | 4.52e-17 A | 1e-12 A   | yes  |

## Capacitive circuits

### RC charging (time constant)

- **Conditions:** 5 V step into R = 1 kΩ, C = 1 µF (τ = 1 ms), v_C(0) = 0; 0 … 5τ.
- **Solver:** Trapezoidal, fixed step h = 10 µs (and 5 µs), first step backward Euler; BE comparison at 10 µs.
- **Reference:** v_C(t) = 5·(1 − e^(−t/τ)); v_C(τ) = 5·(1 − 1/e) = 3.1606 V.

| Quantity                                                  | Reference | Measured    | Error      | Tolerance  | Pass       |
| --------------------------------------------------------- | --------- | ----------- | ---------- | ---------- | ---------- |
| v_C(τ)                                                    | 3.161 V   | 3.161 V     | 7.62e-05 V | 0.001 V    | yes        |
| max                                                       | error     | , h = 10 µs | 0 V        | 0.000246 V | 0.000246 V | 0.002 V | yes |
| max                                                       | error     | , h = 5 µs  | 0 V        | 6.2e-05 V  | 6.2e-05 V  | 0.001 V | yes |
| error ratio (second-order ⇒ ≈ 4; first BE step limits it) | 4         | 3.967       | 0.03304    | 2.5        | yes        |
| backward Euler max                                        | error     | , h = 10 µs | 0 V        | 0.009159 V | 0.009159 V | 0.02 V  | yes |

### RC discharging (time-constant measurement)

- **Conditions:** C = 1 µF charged to 5 V (initial condition), discharging through R = 1 kΩ to a 0 V source; 0 … 5τ.
- **Solver:** Trapezoidal, h = 10 µs, first step backward Euler.
- **Reference:** v_C(t) = 5·e^(−t/τ), τ = RC = 1 ms.

| Quantity   | Reference | Measured | Error           | Tolerance    | Pass       |
| ---------- | --------- | -------- | --------------- | ------------ | ---------- |
| max        | error     |          | 0 V             | 0.000246 V   | 0.000246 V | 0.002 V | yes |
| measured τ | 0.001     | 0.001    | 4.16e-05 (rel.) | 0.002 (rel.) | yes        |

### Switched RC (pulse source with breakpoints)

- **Conditions:** Ideal pulse 0 → 5 V at 1 ms, back to 0 V at 3 ms (zero rise/fall), R = 1 kΩ, C = 1 µF.
- **Solver:** Trapezoidal, h = 10 µs; steps land exactly on the source breakpoints, backward Euler right after each.
- **Reference:** Piecewise exponentials with τ = 1 ms; v_C(3 ms) = 5(1 − e^(−2)).

| Quantity | Reference | Measured | Error | Tolerance  | Pass       |
| -------- | --------- | -------- | ----- | ---------- | ---------- |
| max      | error     | of v_C   | 0 V   | 0.000246 V | 0.000246 V | 0.003 V | yes |

## Inductive circuits

### RL step response

- **Conditions:** 10 V step into R = 100 Ω, L = 10 mH (τ = 100 µs), i_L(0) = 0; 0 … 5τ.
- **Solver:** Trapezoidal, h = 1 µs, first step backward Euler.
- **Reference:** i_L(t) = (V/R)·(1 − e^(−t/τ)).

| Quantity | Reference | Measured  | Error      | Tolerance  | Pass       |
| -------- | --------- | --------- | ---------- | ---------- | ---------- |
| max      | error     | of i_L    | 0 A        | 4.92e-06 A | 4.92e-06 A | 2e-05 A | yes |
| i_L(5τ)  | 0.09933 A | 0.09933 A | 5.45e-09 A | 2e-05 A    | yes        |

## RLC

### Series RLC step response (underdamped)

- **Conditions:** 1 V step, R = 20 Ω, L = 1 mH, C = 1 µF; zero initial state; 0 … 1 ms.
- **Solver:** Trapezoidal, h = 0.5 µs (≈ 400 steps per period), first step backward Euler.
- **Reference:** v_C = 1 − e^(−αt)(cos ω_d t + (α/ω_d) sin ω_d t), α = R/2L, ω_d = √(1/LC − α²); first peak at π/ω_d with overshoot e^(−απ/ω_d).

| Quantity        | Reference | Measured | Error           | Tolerance   | Pass       |
| --------------- | --------- | -------- | --------------- | ----------- | ---------- |
| max             | error     | of v_C   | 0 V             | 0.000123 V  | 0.000123 V | 0.002 V | yes |
| first peak time | 0.000105  | 0.000104 | 0.002099 (rel.) | 0.01 (rel.) | yes        |
| overshoot       | 0.3509    | 0.3509   | 0.000106 (rel.) | 0.01 (rel.) | yes        |

## Nonlinear devices

### Diode–resistor operating point (nonlinear DC)

- **Conditions:** 5 V source, 1 kΩ, Shockley diode Is = 1e-14 A, n = 1, T = 27 °C (V_T = 25.865 mV), gmin = 0.
- **Solver:** Newton–Raphson with SPICE junction limiting (pnjlim); relTol 1e-6.
- **Reference:** Closed form: I = (nV_T/R)·W((Is·R/nV_T)·e^((V + Is·R)/nV_T)) − Is (Lambert W).

| Quantity                 | Reference | Measured | Error           | Tolerance    | Pass |
| ------------------------ | --------- | -------- | --------------- | ------------ | ---- |
| diode current            | 0.004307  | 0.004307 | 9.14e-14 (rel.) | 1e-06 (rel.) | yes  |
| diode voltage            | 0.6929 V  | 0.6929 V | 2e-15 V         | 1e-06 V      | yes  |
| Newton iterations (≤ 50) | 0         | 0        | 0               | 0            | yes  |

### NMOS square-law operating points (saturation and triode)

- **Conditions:** VDD = 10 V, RD = 1 kΩ, Vth = 2 V, K = 2 mA/V², λ = 0; gate at 3 V (saturation) and 10 V (triode).
- **Solver:** Newton–Raphson, level-1 square-law model.
- **Reference:** Saturation: Id = K/2·(Vgs − Vth)² = 1 mA ⇒ Vd = 9 V. Triode: quadratic in Vds solved in closed form.

| Quantity        | Reference | Measured | Error      | Tolerance | Pass |
| --------------- | --------- | -------- | ---------- | --------- | ---- |
| Id (saturation) | 0.001 A   | 0.001 A  | 0 A        | 1e-09 A   | yes  |
| Vd (triode)     | 0.6101 V  | 0.6101 V | 2.22e-16 V | 1e-06 V   | yes  |

### NPN forward-active operating point (Ebers–Moll)

- **Conditions:** Is = 1e-14 A, βF = 100, βR = 1; RB = 100 kΩ from 5 V, RC = 1 kΩ from 10 V.
- **Solver:** Newton–Raphson with junction limiting.
- **Reference:** KCL with the transport model: Ib from the base resistor equals Is/βF·(e^(Vbe/VT) − 1); Ic ≈ βF·Ib in forward active.

| Quantity                     | Reference | Measured | Error           | Tolerance    | Pass |
| ---------------------------- | --------- | -------- | --------------- | ------------ | ---- |
| Ib (resistor) vs Ib (model)  | 4.31e-05  | 4.31e-05 | 2.32e-10 (rel.) | 1e-06 (rel.) | yes  |
| Ic / Ib                      | 100       | 100      | 2.37e-10 (rel.) | 0.001 (rel.) | yes  |
| forward active (Vce > 0.3 V) | expected  | observed | —               | —            | yes  |

## Failure handling

### Numerical failures are reported, not fabricated

- **Conditions:** Contradictory parallel sources; a shorted source; a current source into a capacitor; no reference; a floating MOSFET gate.
- **Solver:** Topology checks before factorisation; singular-pivot detection in the LU.
- **Reference:** Each circuit has no unique DC solution: the solver must refuse with a diagnostic naming the cause.

| Quantity                        | Reference | Measured | Error | Tolerance | Pass |
| ------------------------------- | --------- | -------- | ----- | --------- | ---- |
| case 1 → voltage-source-loop    | expected  | observed | —     | —         | yes  |
| case 2 → shorted-source         | expected  | observed | —     | —         | yes  |
| case 3 → current-source-no-path | expected  | observed | —     | —         | yes  |
| case 4 → missing-reference      | expected  | observed | —     | —         | yes  |
| case 5 → floating-control       | expected  | observed | —     | —         | yes  |

## Digital circuits

### Gate truth tables and unknown-value propagation

- **Conditions:** Two-input gates driven through all four input combinations; 100 ns per combination; 10 ns gate delay.
- **Solver:** Discrete-event scheduler, integer-ns time, (time, sequence) ordering; inertial gate delays.
- **Reference:** Boolean definitions of AND/OR/NAND/NOR/XOR/XNOR; IEEE 1164-style dominance for unknown inputs.

| Quantity                      | Reference | Measured | Error | Tolerance | Pass |
| ----------------------------- | --------- | -------- | ----- | --------- | ---- |
| AND truth table               | expected  | observed | —     | —         | yes  |
| OR truth table                | expected  | observed | —     | —         | yes  |
| NAND truth table              | expected  | observed | —     | —         | yes  |
| NOR truth table               | expected  | observed | —     | —         | yes  |
| XOR truth table               | expected  | observed | —     | —         | yes  |
| XNOR truth table              | expected  | observed | —     | —         | yes  |
| Z/X dominance rules (6 cases) | expected  | observed | —     | —         | yes  |

### Propagation delay and inertial filtering

- **Conditions:** Inverter chain with 10 + 20 + 30 ns delays; input falls at t = 1 µs. A 5 ns pulse into a 10 ns buffer.
- **Solver:** Discrete-event scheduler, integer-ns time, (time, sequence) ordering; inertial gate delays.
- **Reference:** Output of the third inverter changes exactly 60 ns after the input; a pulse shorter than an inertial delay produces no output transition.

| Quantity                                 | Reference | Measured | Error | Tolerance | Pass |
| ---------------------------------------- | --------- | -------- | ----- | --------- | ---- |
| chain output edge time                   | 1060 ns   | 1060 ns  | 0 ns  | 0 ns      | yes  |
| 5 ns glitch filtered by the 10 ns buffer | expected  | observed | —     | —         | yes  |

### Counter and D flip-flop (toggle) on a 1 MHz clock

- **Conditions:** 1 MHz, 50 % clock; 4-bit counter (5 ns delay, reset low); D flip-flop with Q̅ fed back to D.
- **Solver:** Discrete-event scheduler, integer-ns time, (time, sequence) ordering; inertial gate delays.
- **Reference:** The counter increments on each rising edge after start-up (19 edges by 19.5 µs → 19 mod 16 = 3); the toggle flip-flop divides the clock by two (2 µs period).

| Quantity             | Reference | Measured | Error | Tolerance | Pass |
| -------------------- | --------- | -------- | ----- | --------- | ---- |
| counter value        | 3         | 3        | 0     | 0         | yes  |
| toggle output period | 2000 ns   | 2000 ns  | 0 ns  | 0 ns      | yes  |

### PWM duty cycle

- **Conditions:** Ideal PWM sources at 490.2 Hz/30 %, 1 kHz/75 % and 50 Hz/7.45 % (≈ 1.49 ms servo pulse); 10 periods.
- **Solver:** Discrete-event scheduler, integer-ns time, (time, sequence) ordering; inertial gate delays.
- **Reference:** High time / total time equals the configured duty (edge times rounded to 1 ns).

| Quantity         | Reference | Measured | Error   | Tolerance | Pass |
| ---------------- | --------- | -------- | ------- | --------- | ---- |
| duty at 490.2 Hz | 0.3       | 0.3      | 4.7e-08 | 1e-06     | yes  |
| duty at 1000 Hz  | 0.75      | 0.75     | 0       | 1e-06     | yes  |
| duty at 50 Hz    | 0.0745    | 0.0745   | 0       | 1e-06     | yes  |

### Output contention and floating inputs are explicit

- **Conditions:** Two push-pull clocks (50 % and 25 % duty) tied together for 5 µs; an inverter with an unconnected input.
- **Solver:** Discrete-event scheduler, integer-ns time, (time, sequence) ordering; inertial gate delays.
- **Reference:** Conflicting strong drivers resolve to X and raise contention events; an undriven input is Z (not assumed LOW or HIGH), so the inverter output is X.

| Quantity                                 | Reference | Measured | Error | Tolerance | Pass |
| ---------------------------------------- | --------- | -------- | ----- | --------- | ---- |
| net resolves to X while drivers disagree | expected  | observed | —     | —         | yes  |
| contention events raised                 | expected  | observed | —     | —         | yes  |
| floating input reads Z                   | expected  | observed | —     | —         | yes  |
| inverter of a floating input outputs X   | expected  | observed | —     | —         | yes  |

### Digital output → analog divider → digital input thresholds

- **Conditions:** Logic output V_OH = 5 V behind 10 Ω; divider R1 = 10 kΩ, R2 = 1 k / 10 k / 30 kΩ; reader thresholds 0.3·5 V and 0.7·5 V.
- **Solver:** Discrete-event scheduler, integer-ns time, (time, sequence) ordering; inertial gate delays. Mixed nets solved by MNA (quasi-static).
- **Reference:** Tap voltage 5·R2/(10 Ω + R1 + R2); level 0 below 1.5 V, 1 above 3.5 V, X between — a wire never implies a level.

| Quantity                            | Reference | Measured | Error | Tolerance | Pass |
| ----------------------------------- | --------- | -------- | ----- | --------- | ---- |
| tap voltage (R2 = 10 kΩ)            | 2.499 V   | 2.499 V  | 0 V   | 1e-09 V   | yes  |
| 2.50 V reads X (between thresholds) | expected  | observed | —     | —         | yes  |
| 3.75 V reads 1                      | expected  | observed | —     | —         | yes  |
| 0.45 V reads 0                      | expected  | observed | —     | —         | yes  |

## Embedded control

### Known input/output program: arithmetic, pin mapping, delays

- **Conditions:** UNO (USB), sketch computes Σi² (i = 1…10), a 16-bit overflow and integer division; 5 pulses on D12; D13 toggled every 250 ms.
- **Solver:** UNO Level 2 runtime, op cost 250 ns, integer-ns event scheduler.
- **Reference:** C/AVR semantics: Σ = 385, 30000 + 10000 = −25536 in int16, 7/2 + 7%2 = 4. delay(250) twice per cycle → 500 ms period plus the modelled call costs (≈ 4 µs per digitalWrite).

| Quantity                               | Reference | Measured | Error       | Tolerance | Pass |
| -------------------------------------- | --------- | -------- | ----------- | --------- | ---- |
| printed 385, −25536, 4                 | expected  | observed | —           | —         | yes  |
| D12 pulses (pin mapping D12 → its net) | 5         | 5        | 0           | 0         | yes  |
| D13 period                             | 5e+08 ns  | 5e+08 ns | 1.18e+04 ns | 5e+04 ns  | yes  |

### Timer resolution and UART timing

- **Conditions:** micros() around delay(10); millis() after it; 20 bytes printed at 9600 baud.
- **Solver:** UNO Level 2 runtime, op cost 250 ns, integer-ns event scheduler.
- **Reference:** micros() has 4 µs resolution on a 16 MHz UNO (Arduino reference), so the delta is a multiple of 4 near 10 000 µs; UART: 10 bits per byte.

| Quantity                              | Reference | Measured  | Error     | Tolerance | Pass |
| ------------------------------------- | --------- | --------- | --------- | --------- | ---- |
| micros() delta is a multiple of 4 µs  | expected  | observed  | —         | —         | yes  |
| micros() delta over delay(10)         | 1e+04 µs  | 1e+04 µs  | 0 µs      | 40 µs     | yes  |
| millis() after setup                  | 10 ms     | 10 ms     | 0 ms      | 1 ms      | yes  |
| UART completion time, 20 bytes @ 9600 | 0.02083 s | 0.02083 s | 1.5e-06 s | 0.0001 s  | yes  |

## Sensor model

### HC-SR04: known distance → echo duration; range limits; no-echo timeout

- **Conditions:** Stub world: a plane at a set distance in front of the sensor (exact geometry). 20 °C, noise off. Firmware triggers with 10 µs and reads pulseIn(…, 60 ms).
- **Solver:** UNO Level 2 runtime, op cost 250 ns, integer-ns event scheduler. HC-SR04 model: centre + 6 cone rays (nearest hit).
- **Reference:** Echo width = 2d / c with c = 331.3 + 0.606·T = 343.42 m/s; outside 2–400 cm the module returns its no-echo pulse (38 ms, configured).

| Quantity                                           | Reference  | Measured   | Error | Tolerance | Pass |
| -------------------------------------------------- | ---------- | ---------- | ----- | --------- | ---- |
| echo width at 0.500 m                              | 2912 µs    | 2912 µs    | 0 µs  | 1e-06 µs  | yes  |
| echo width at 1.234 m                              | 7187 µs    | 7187 µs    | 0 µs  | 1e-06 µs  | yes  |
| pulseIn() reading at 0.500 m (integer µs)          | 2912 µs    | 2912 µs    | 0 µs  | 1 µs      | yes  |
| beyond 4 m → no-echo pulse                         | 3.8e+04 µs | 3.8e+04 µs | 0 µs  | 0 µs      | yes  |
| inside 2 cm → no-echo pulse                        | 3.8e+04 µs | 3.8e+04 µs | 0 µs  | 0 µs      | yes  |
| no reflector → no-echo pulse                       | 3.8e+04 µs | 3.8e+04 µs | 0 µs  | 0 µs      | yes  |
| the firmware reads 38 000 µs for the no-echo pulse | expected   | observed   | —     | —         | yes  |
| noise off: identical repeated readings             | expected   | observed   | —     | —         | yes  |

### HC-SR04 noise model: unbiased, configured σ, reproducible

- **Conditions:** Plane at 1.000 m, σ = 5 mm, 308 measurements (seed 1).
- **Solver:** UNO Level 2 runtime, op cost 250 ns, integer-ns event scheduler.
- **Reference:** Gaussian noise (Box–Muller on the seeded generator): sample mean ≈ 1 m, sample σ ≈ 5 mm; the same seed gives the same sequence.

| Quantity                  | Reference | Measured | Error           | Tolerance  | Pass |
| ------------------------- | --------- | -------- | --------------- | ---------- | ---- |
| sample mean               | 1 m       | 1 m      | 0.000206 m      | 0.000955 m | yes  |
| sample σ                  | 0.005     | 0.00496  | 0.007924 (rel.) | 0.2 (rel.) | yes  |
| same seed → same readings | expected  | observed | —               | —          | yes  |

## Actuator integration

### PWM command → servo target (Servo library mapping, pulse decoding)

- **Conditions:** write(0), write(90), write(180) at 100 ms intervals; 50 Hz frames; servo model 544–2400 µs over 180°.
- **Solver:** UNO Level 2 runtime, op cost 250 ns, integer-ns event scheduler.
- **Reference:** Servo library: µs = map(angle, 0, 180, 544, 2400) (integer) → 544, 1472, 2400 µs; decoded angle = (µs − 544)/(2400 − 544)·180.

| Quantity                  | Reference | Measured | Error | Tolerance | Pass |
| ------------------------- | --------- | -------- | ----- | --------- | ---- |
| pulse for write(0)        | 544 µs    | 544 µs   | 0 µs  | 1e-06 µs  | yes  |
| pulse for write(90)       | 1472 µs   | 1472 µs  | 0 µs  | 1e-06 µs  | yes  |
| pulse for write(180)      | 2400 µs   | 2400 µs  | 0 µs  | 1e-06 µs  | yes  |
| decoded angle for 1472 µs | 90 °      | 90 °     | 0 °   | 1e-09 °   | yes  |

### Servo command → Phase 5 joint motion within the actuator limits; repeated cycles

- **Conditions:** Ultrasonic servo gauge sample (SG90-cited limits, generic dynamics); target moved from 0.25 m to 0.40 m at t = 2 s.
- **Solver:** UNO Level 2 runtime, op cost 250 ns, integer-ns event scheduler. Rapier 0.19.2 at 120 Hz × 4 sub-steps.
- **Reference:** The servo only sets the joint target; the Phase 5 actuator (speed-limited setpoint + PID, effort-saturated) produces the motion: the joint settles near the target and never exceeds the cited no-load speed.

| Quantity                                                                 | Reference | Measured   | Error      | Tolerance    | Pass |
| ------------------------------------------------------------------------ | --------- | ---------- | ---------- | ------------ | ---- |
| settled joint error before the move                                      | 0 °       | 3.89e-06 ° | 3.89e-06 ° | 1.5 °        | yes  |
| settled joint error after the move                                       | 0 °       | 8.7e-06 °  | 8.7e-06 °  | 1.5 °        | yes  |
| peak joint speed ≤ speed limit                                           | 0 rad/s   | 0 rad/s    | 0 rad/s    | 0.5236 rad/s | yes  |
| joint moved after the target moved (peak speed > 0.3 rad/s)              | expected  | observed   | —          | —            | yes  |
| sensor → controller → actuator cycles continued (≥ 25 more measurements) | expected  | observed   | —          | —            | yes  |

## Also covered by tests (not recorded cases)

- Sparse LU against random MNA-like systems with zero diagonals (n = 5, 40, 300) to 1e-9; singular-column reporting.
- Netlist: connectivity only from explicit relations; moving symbols changes no net; device-internal terminals (UNO GND pins).
- Commands: validation, undo/redo, save/reload (schema v6), v5 migration, corrupt-circuit rejection, import link resolution.
- Firmware front end: compile errors with line numbers, unsupported features refused, SRAM estimate, every bundled sketch compiles.
- Co-simulation: the Arduino–HC-SR04–servo chain with real Rapier (distance within 0.02 cm of the geometric expectation, joint within 1.5° of the decoded target, speed-limited motion, ≥ 40 measurement cycles), determinism of two runs, firmware edits change the outcome, the arm following firmware poses on all four joints, and the arm going limp without a shared ground.
- Browser: the acceptance workflow (tests/end-to-end/electronics-*.spec.ts).
