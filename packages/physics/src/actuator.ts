import type { Actuator } from '@forge/engineering-core';

/**
 * Generic joint actuator ("servo") — a documented, GENERIC model (docs/ACTUATOR_MODELS.md).
 * It does not reproduce any particular product's dynamics.
 *
 *   position mode: the internal setpoint moves toward the target at ≤ speedLimit;
 *                  τ_cmd = kp·(setpoint − q) + kd·(setpoint_rate − q̇) + ki·∫(setpoint − q) dt
 *   velocity mode: ω_t clamped to ±speedLimit;  τ_cmd = kd·(ω_t − q̇) + ki·∫(ω_t − q̇) dt
 *   effort mode:   τ_cmd = targetEffort
 *
 * The APPLIED effort is the command clipped to a linear torque–speed envelope (a DC-motor
 * characteristic with stall effort = effortLimit and no-load speed = speedLimit), and never
 * beyond ±effortLimit:
 *   τ ∈ [ max(−τmax, −τmax·(1 + q̇/ωmax)),  min(τmax, τmax·(1 − q̇/ωmax)) ]
 * So the actuator can neither exert infinite effort nor drive itself faster than its
 * no-load speed; external loads can still back-drive it.
 * Disabled or emergency-stopped actuators apply zero effort (torque off).
 * Integral action uses conditional integration (anti-windup): it accumulates only while
 * the output is not saturated, and |ki·∫| ≤ effortLimit.
 *
 * Units: joint coordinate rad (revolute) or m (prismatic); effort N·m or N.
 */
export interface Gains {
  kp: number;
  kd: number;
  ki: number;
}

export interface ActuatorState {
  setpoint: number;
  integral: number;
  /** Last raw (unsaturated) command, applied (saturated) effort and saturation flag. */
  command: number;
  applied: number;
  saturated: boolean;
  setpointRate: number;
}

export const initialActuatorState = (q: number): ActuatorState => ({
  setpoint: q,
  integral: 0,
  command: 0,
  applied: 0,
  saturated: false,
  setpointRate: 0,
});

/** Gains placing a triple closed-loop pole at −ω (ω = 2π·bandwidth) for inertia I. */
export function autoGains(inertia: number, bandwidthHz: number): Gains {
  const w = 2 * Math.PI * bandwidthHz;
  return { kp: 3 * inertia * w * w, kd: 3 * inertia * w, ki: inertia * w * w * w };
}

export function gainsFor(a: Actuator, inertia: number): Gains {
  return a.gains.mode === 'auto'
    ? autoGains(inertia, a.gains.bandwidthHz)
    : { kp: a.gains.kp, kd: a.gains.kd, ki: a.gains.ki };
}

/**
 * Explicit-integration stability check of the controller at control period h for
 * inertia I: ω_n·h and kd·h/I must stay well below the explicit-Euler bounds. Returns a
 * message when the gains are likely to be unstable, else null.
 */
export function controllerStabilityProblem(g: Gains, inertia: number, h: number): string | null {
  if (!(inertia > 0)) return 'effective inertia is zero; the controller cannot be tuned';
  const wn = Math.sqrt(g.kp / inertia);
  const damp = (g.kd * h) / inertia;
  if (wn * h > 0.5 || damp > 1)
    return `gains too high for a ${(h * 1000).toFixed(2)} ms control period (ω_n·h = ${(wn * h).toFixed(2)}, kd·h/I = ${damp.toFixed(2)}); expect oscillation or divergence — lower the gains or raise the control rate`;
  return null;
}

export const effortEnvelope = (
  qd: number,
  a: Pick<Actuator, 'effortLimit' | 'speedLimit'>,
): [number, number] => {
  const t = a.effortLimit;
  const r = qd / a.speedLimit;
  return [Math.max(-t, -t * (1 + r)), Math.min(t, t * (1 - r))];
};

export interface ActuatorStepInput {
  q: number;
  qd: number;
  /** Control period (s). */
  h: number;
  actuator: Actuator;
  gains: Gains;
  /** Emergency stop latched (simulation-level). */
  stopped: boolean;
  limits: { min: number; max: number } | null;
}

export function actuatorStep(s: ActuatorState, i: ActuatorStepInput): ActuatorState {
  const a = i.actuator;
  if (!a.enabled || i.stopped)
    return { setpoint: i.q, integral: 0, command: 0, applied: 0, saturated: false, setpointRate: 0 };
  const [lo, hi] = effortEnvelope(i.qd, a);
  let command: number;
  let setpoint = s.setpoint;
  let setpointRate = 0;
  let error: number;
  if (a.mode === 'position') {
    // The setpoint is limited to the joint travel and moves at ≤ speedLimit.
    const target = i.limits ? Math.min(i.limits.max, Math.max(i.limits.min, a.target)) : a.target;
    const step = Math.max(-a.speedLimit * i.h, Math.min(a.speedLimit * i.h, target - setpoint));
    setpoint += step;
    setpointRate = step / i.h;
    error = setpoint - i.q;
    command = i.gains.kp * error + i.gains.kd * (setpointRate - i.qd) + i.gains.ki * s.integral;
  } else if (a.mode === 'velocity') {
    const wt = Math.max(-a.speedLimit, Math.min(a.speedLimit, a.targetVelocity));
    error = wt - i.qd;
    command = i.gains.kd * error + i.gains.ki * s.integral;
    setpoint = i.q;
  } else {
    error = 0;
    command = a.targetEffort;
    setpoint = i.q;
  }
  const applied = Math.max(lo, Math.min(hi, command));
  const saturated = Math.abs(applied - command) > 1e-12;
  let integral = s.integral;
  if (a.mode !== 'effort' && !saturated && i.gains.ki > 0) {
    integral += error * i.h;
    const cap = a.effortLimit / i.gains.ki;
    integral = Math.max(-cap, Math.min(cap, integral));
  }
  return { setpoint, integral, command, applied, saturated, setpointRate };
}

/** Passive joint effort: viscous damping plus Coulomb friction smoothed over ±ε (rad/s or m/s). */
export function passiveEffort(qd: number, damping: number, friction: number, epsilon = 1e-2): number {
  return -damping * qd - friction * Math.tanh(qd / epsilon);
}

/**
 * Motor command, independent of its source (UI, test, script; Phase 6 electronics and
 * Phase 11 Vey will submit the same structure). Fields left out keep their value.
 */
export interface MotorCommand {
  mateId: string;
  mode?: Actuator['mode'];
  target?: number;
  targetVelocity?: number;
  targetEffort?: number;
  enabled?: boolean;
  source: 'desktop-ui' | 'test' | 'api' | 'electronics' | 'vey';
}
