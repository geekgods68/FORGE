# Sensor and actuator models (Phase 6)

`@forge/electronics/src/cosim/devices.ts`. Sensors derive measurements from the **simulated world** (ray casts against current body poses, joint coordinates); nothing is read from a table of expected outputs. Each device exposes telemetry channels labelled measured / commanded / true-geometry.

## Shared interface

`DeviceModel`: `start`, `stop`, optional `afterPhysics(t0, t1)` (joint-linked sensors), `channels`, `sample`, `status`. Mounting transform: the placed component node's world matrix — simulated if the node moves with a physics body (e.g. a sensor on the arm), otherwise its CAD pose. Noise: a seeded generator (`settings.cosim.seed`), so runs are reproducible. Power: devices check their own supply pins against the solved circuit.

| Model              | Observes                               | Output                          | Validity     |
| ------------------ | -------------------------------------- | ------------------------------- | ------------ |
| HC-SR04            | Ray geometry (Phase 5 colliders)       | Echo pulse width (digital)      | approximate  |
| Potentiometer      | Manual wiper or a joint coordinate     | Wiper voltage (analog, MNA)     | approximate  |
| Limit switch       | Manual or joint coordinate threshold   | Contact closure (analog, MNA)   | approximate  |
| Quadrature encoder | Joint coordinate                       | A/B quadrature edges            | approximate  |
| Temperature sensor | The configured **ambient** temperature | 0.5 V + 10 mV/°C (analog)       | illustrative |
| Servo              | Control pulses                         | Joint target → Phase 5 actuator | approximate  |

IMU, camera, LiDAR and force sensors are **not implemented** (none is faked).

## HC-SR04-compatible module

Generic model, not verified manufacturer behaviour. Pins VCC, TRIG, ECHO, GND.

- **Power**: operates when VCC−GND is within 4.5–5.5 V (assumption: ±10 % of the cited 5 V); otherwise no response. Supply current: an equivalent load of 5 V / 15 mA (cited working current).
- **Trigger**: TTL thresholds (assumption). A HIGH pulse ≥ `minTriggerUs` (10 µs, cited) is accepted on its falling edge; shorter pulses are ignored with an event; triggers while a measurement is in progress are ignored.
- **Measurement**: at the trigger, rays are cast from the midpoint of the two transducers along the board's +Z axis — the central ray, or the centre plus 6 rays on a cone of half-angle 7.5° (the cited 15° measuring angle). The **nearest hit** is the distance. The sensor's own body is excluded. Geometry is the physics state of the latest completed step (≤ 8.3 ms old).
- **Speed of sound**: c = 331.3 + 0.606·T m/s (dry-air linear approximation), T = the module's temperature or the circuit's ambient (20 °C → 343.42 m/s).
- **Echo**: rises `burstDelayUs` (200 µs = 8 cycles at the cited 40 kHz) after the trigger falls and stays HIGH for 2·d/c. Outside 2–400 cm (cited range), or with no hit, the echo is the **no-echo pulse** (38 ms — commonly published, varies between modules; configurable). Output drive: V_OH = VCC behind 100 Ω (assumption).
- **Noise**: optional Gaussian on the distance (σ configurable, default 0), deterministic per seed.
- **Not modelled**: surface angle and material, specular/diffuse reflection, multipath and ghost echoes, beam pattern weighting, temperature gradients, humidity, crosstalk between sensors, minimum dead time between measurements.

## Servo

Pins: signal, V+, GND. Supply range from the catalogue (SG90 4.8–6 V, MG996R 4.8–7.2 V, cited; generic classes 4.8–6 V assumed). Pulse mapping default 544–2400 µs → 0–180° (assumed equal to the Arduino Servo library; real servos vary), configurable per part. Deadband: SG90 10 µs (cited), others 0 (unknown).

On each falling edge the pulse width is decoded. Valid widths (400–2600 µs default) beyond the deadband set the **joint target** `jointCentre + direction·(angle − 90°)` through a Phase 5 `MotorCommand` (`source: 'electronics'`, position mode). The Phase 5 actuator — speed-limited setpoint, PID, effort saturation at the cited stall torque — produces the motion; the control signal **cannot** bypass these limits. Behaviour:

- Before the first valid pulse the actuator is off (limp).
- Supply outside the range (or no reference because the ground is not shared): the actuator is switched off with an event, and pulses are not accepted.
- Invalid pulse widths are ignored with a (rate-limited) event; the last target is held when pulses stop.
- Signal current is negligible; **motor current, back-EMF, losses, heating and supply sag are not modelled** — the supply rule says so explicitly.

DC motors, steppers and motor drivers have no models yet; `MotorCommand` already carries `source: 'electronics'` for them.

## Joint-linked sensors

After every physics step: the potentiometer wiper maps `(q − qMin)/(qMax − qMin)`; the limit switch closes at a joint threshold; the encoder computes `floor(q/2π · PPR · 4)` and emits the quadrature edges, spread evenly over the step interval (edge times are therefore quantised to the step — documented accuracy limit).
