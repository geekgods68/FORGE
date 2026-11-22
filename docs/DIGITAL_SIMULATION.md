# Digital simulation (Phase 6)

`@forge/electronics/src/digital` — discrete-event logic on simulation time with explicit unknown states, and the boundary to the analog solver.

## Time and scheduling

`Scheduler`: a binary heap of events keyed by **(time, sequence)**. Time is an integer number of nanoseconds in a JS number (exact to 2⁵³ ns ≈ 104 days). Equal-time events run in scheduling order, so runs are deterministic. Browser frame timing never decides when an event happens — it only decides how far simulated time is advanced per frame. `runUntil` bounds the number of events per call (a zero-delay oscillation is reported, not hung on).

## Values

Four-valued logic: `0`, `1`, `Z` (undriven), `X` (unknown). Gates use IEEE 1164-style dominance: 0 dominates AND, 1 dominates OR; otherwise any `X`/`Z` input gives `X`. A floating input is `Z` and an inverter of it outputs `X` — no input is assumed LOW or HIGH because a wire exists.

## Net resolution (`SignalNetwork`)

- **Digital nets** (only digital device pins): strong drivers (push-pull outputs) and weak pulls (e.g. UNO `INPUT_PULLUP`, or `digitalWrite(HIGH)` on an input as on AVR). One level → that level; conflicting strong drivers → `X` plus a **contention event** naming the drivers; no driver and no pull → `Z`.
- **Mixed nets** (a digital pin and any analog element, rail or ground): solved by MNA. Each digital output becomes a Thevenin source (its level × V_OH behind its output resistance: UNO pins 25 Ω, typical for the datasheet's V_OH ≥ 4.2 V at 20 mA; ideal logic primitives 10 Ω; module outputs 100 Ω), pulls become resistors (UNO pull-up 35 kΩ, mid of the datasheet's 20–50 kΩ). The solve is quasi-static (DC operating point at the event); see ELECTROMECHANICAL_COSIMULATION.md.
- **Readers apply their own thresholds** to the net voltage — on digital nets too (a 3.3 V output into a 5 V input with V_IH = 3 V reads `X`): below V_IL → `0`, above V_IH → `1`, between → `X`.

| Input                      | Thresholds                         | Source                                    |
| -------------------------- | ---------------------------------- | ----------------------------------------- |
| ATmega328P (UNO) pins      | V_IL ≤ 0.3·VCC, V_IH ≥ 0.6·VCC     | ATmega328P datasheet                      |
| Ideal logic primitives     | 0.3·V, 0.7·V of their logic supply | Generic CMOS assumption                   |
| HC-SR04 TRIG, servo signal | 0.8 V / 2.0 V                      | TTL-compatible **assumption** (not cited) |

Watchers are notified with the exact event time, which is what edge detection, `pulseIn`, interrupts and servo pulse decoding use.

## Devices

| Device      | Behaviour                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Gate        | AND/OR/NOT/NAND/NOR/XOR/XNOR/buffer, 1–8 inputs, **inertial** delay (a pulse shorter than the delay is filtered) |
| D flip-flop | Samples D on a 0→1 clock edge; uncertain edges with D ≠ Q give `X`; Q and Q̅ outputs                              |
| Counter     | n-bit synchronous, increments on 0→1 clock edges, synchronous active-HIGH reset; unknown reset → unknown count   |
| Clock / PWM | Edge times from the cycle index (`k·T`, `k·T + D·T`, rounded to 1 ns) — no accumulated drift                     |

Power-on state of flip-flops and counters is 0 — an idealisation (real parts power up undefined). Logic primitives have no power pins (they are referenced to circuit ground).

## Analog ↔ digital boundaries

| Direction                | Model                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Analog → digital         | Reader thresholds on the solved net voltage; between thresholds = `X`                           |
| Digital output → analog  | Thevenin source (level × V_OH, R_out) re-solved at each driver change                           |
| PWM → time-varying logic | Edges scheduled per period (`analogWrite`, clock parts, Servo library frames)                   |
| ADC                      | `analogRead`: `floor(V/V_ref·1024)` clamped to 0…1023, V_ref = the UNO's solved 5 V rail (AVCC) |

## Recording

`TransitionLog`: a fixed-capacity ring buffer (time, net, level, voltage). Mixed nets are logged when their solved voltage changes, with a display-only level from 5 V CMOS thresholds (1.5 V / 3.0 V). It feeds the logic analyser (exact timestamps, pulse width, period, duty) and the oscilloscope (voltage steps between recorded events — no smoothing).

## Limits

No timing checks (setup/hold), no tri-state buses or open-drain devices beyond pull-ups, no wired-AND, no SPI/I²C peripherals, no metastability, no glitch power. Analog dynamics on digital nets (RC filtering of a PWM line) are not part of the event-driven model.
