# Actuator models (Phase 5)

One **generic** joint actuator ("servo") model, `packages/physics/src/actuator.ts`. It is not a model of any specific product.

## Model

Per control update (default 480 Hz, the physics sub-step rate; zero-order hold between updates):

| Mode     | Command                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| position | the setpoint moves toward the target at ≤ `speedLimit` (and within the joint limits); τ = kp·(s − q) + kd·(ṡ − q̇) + ki·∫(s − q) |
| velocity | ω_t clamped to ±`speedLimit`; τ = kd·(ω_t − q̇) + ki·∫(ω_t − q̇)                                                                  |
| effort   | τ = `targetEffort`                                                                                                              |

The **applied** effort is the command clipped to a linear torque–speed envelope (a DC-motor characteristic with stall effort = `effortLimit`, no-load speed = `speedLimit`) and never beyond ±`effortLimit`:

```text
τ ∈ [ max(−τmax, −τmax·(1 + q̇/ωmax)),  min(τmax, τmax·(1 − q̇/ωmax)) ]
```

So the actuator can neither exert unlimited effort nor drive itself past its no-load speed; external loads can still back-drive it. Integral action uses conditional integration (only while unsaturated) and |ki·∫| ≤ τmax (anti-windup). It is applied as equal and opposite torques on the two bodies (prismatic: equal and opposite forces at the shared anchor), so the applied effort is known exactly — Rapier's own joint motors have no effort cap in its JavaScript API and report no motor effort, so they are not used.

**Distinguished quantities** (all shown and recorded): commanded position (target), controller setpoint, actual position (measured), commanded effort (raw), applied effort, velocity, error, saturation flag.

**Disabled** actuators and the **emergency stop** apply zero effort (torque off; the mechanism then moves under gravity and loads). The stop is latched until released or reset.

**Passive joint effort:** viscous damping −c·q̇ and Coulomb friction −μ·tanh(q̇/0.01) (smoothed near zero; approximate).

## Gains

- `auto` (default): from the joint's effective inertia I (the far side of the joint from the grounded side, at the initial pose, including payloads) and a bandwidth f: ω = 2πf, kp = 3Iω², kd = 3Iω, ki = Iω³ (a triple closed-loop pole at −ω). The inertia is an estimate; in reality it changes with configuration.
- `manual`: kp, kd, ki as given. Explicit-control stability is checked at initialisation (ω_n·h ≤ 0.5 and kd·h/I ≤ 1); otherwise a warning says the gains are too high for the control rate.

## Limits and their sources

| Source            | Meaning                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generic`         | default limits (1 N·m, 6 rad/s) — not a product                                                                                                                   |
| `datasheet-cited` | effort limit = the catalogue's cited **stall** torque, speed = its cited no-load operating speed. Not validated by FORGE; stall torque is not a continuous rating |
| `user`            | values the user enters                                                                                                                                            |

The robotic-arm setup uses the catalogue's cited values: **MG996R** 9.4 kgf·cm at 4.8 V ≈ 0.922 N·m, 0.17 s/60° ≈ 6.16 rad/s (yaw, shoulder, elbow); **SG90** 1.8 kgf·cm ≈ 0.177 N·m, 0.10 s/60° ≈ 10.47 rad/s (wrist). Gains: auto, 4 Hz. **This does not reproduce the dynamics of an SG90 or MG996R** (internal gearing, deadband, PWM update, supply sag, thermal limits are not modelled), and no payload capacity of the physical robot is predicted without calibration.

## Optional rating check

`ratedEffort` (continuous rating, optional): exceeding it raises a `rated-effort-exceeded` warning — a rating check, not a failure prediction.

## Command interface (prepared for Phase 6)

`MotorCommand { mateId, mode?, target?, targetVelocity?, targetEffort?, enabled?, source }` is accepted from any source; validated (finite values, actuated joint). Electronics-driven commands in Phase 6 will use the same structure.
