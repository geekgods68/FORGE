# Robotics dynamics: the VEYRIS arm (Phase 5)

`createRoboticArmSimulationSample()` (`@forge/physics`) = the Phase 4 arm (mates, interfaces and limits unchanged) + a simulation setup created by one `physics.simulation.create` command. The library's "Open sample" uses it.

## Physical model

| Physics body (welded by fixed mates)                 | Mode             | Mass (source)                                           |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------------- |
| Base plate + base servo + sensor + 4 screws + 4 nuts | fixed (grounded) | —                                                       |
| Shoulder bracket + shoulder servo                    | dynamic          | 67.2 g (geometry × density; cited MG996R 55 g)          |
| Upper link + shaft + 608 bearing + elbow servo       | dynamic          | 110.6 g (incl. bearing **12 g generic, not measured**)  |
| Forearm + wrist bracket + wrist servo                | dynamic          | 36.5 g (cited SG90 9 g)                                 |
| Gripper                                              | dynamic          | **30 g generic, not measured** (catalogue mass unknown) |
| Electronics and battery (loose)                      | fixed obstacles  | —                                                       |

- **Gravity** −9.80665 m/s² (configurable), static work surface at y = 0.
- **Joints:** yaw, shoulder, elbow, wrist → Rapier revolute joints with the Phase 4 limits (±150°, ±90°, ±135°, ±90°); initial pose = current CAD pose (home optional).
- **Actuators** (ACTUATOR_MODELS.md): generic servo model, position mode holding the CAD pose; limits from the catalogue's cited values (MG996R 0.922 N·m / 6.16 rad/s; SG90 0.177 N·m / 10.47 rad/s); auto gains (4 Hz); joint damping 0.002 N·m·s/rad.
- **Collision:** primitive/convex colliders per modelled solid; jointed neighbours do not collide; self-collision between non-adjacent links is off by default (option).
- **End effector:** the gripper body (its frame, the wrist interface) carries the payload `payload-ee` (point mass, 0 kg by default).

## Measured behaviour (this model)

- Holds the CAD pose under gravity: joint drift about 8 µm / 0.008° (yaw), applied shoulder effort 0.066 N·m with no payload.
- Speed-limited, time-dependent motion: 0 → 30° shoulder takes ≥ 29°/6.16 rad/s of simulated time; intermediate positions are recorded.
- Payload response: shoulder at 45°, 0 → 0.1 kg payload raises the applied holding effort by > 0.05 N·m; integral action keeps the angle.
- Effort limit: 1 kg payload, shoulder commanded to 60° → the actuator saturates at 0.922 N·m, an `effort-limit` warning is raised and the joint stalls short of the target.
- Joint limits: driving the wrist with 1 N·m into +90° holds it at the limit (0 rad beyond, tolerance 0.01).
- Emergency stop: all efforts zero; the arm falls under gravity.
- Agreement with the kinematic solver: gripper pose within 1e-7 m of the Phase 4 solver at the same joint angles.

## Demonstration (browser test `tests/end-to-end/simulation.spec.ts`)

Open the sample → **Simulation** mode → inspect the gripper's mass (labelled generic) and joint properties → set gravity → Start → shoulder target 30° → motion over time (telemetry) → payload 0.2 kg → higher effort → payload 1 kg and 60° → effort saturated (warning) → Pause (time stops) → export CSV → Reset (t = 0, angle 0) → back to CAD: the CAD model is unchanged, and only the three setup commands were added to history → Save, reload: setup persisted.

## Limits of the claim

The model is **approximate**. It does not predict the physical robot's payload capacity, accuracy or speed without calibration; servo internals, gear backlash, compliance, supply voltage, thermal derating and fastener/joint strength are not modelled.
