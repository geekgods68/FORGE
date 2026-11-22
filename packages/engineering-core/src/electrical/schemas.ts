import { z } from 'zod';
import { IdSchema } from '../schemas';
import { devicePins } from './devices';

/**
 * Electrical DEFINITION (Phase 6): the circuit as persistent engineering data — parts
 * (device models, optionally linked to a placed 3D component), explicit wires, net labels,
 * groups, firmware sources and analysis settings. It is stored on the root node next to the
 * Phase 5 simulation definition and changed only through undoable `electrical.*` commands.
 *
 * It never contains runtime state: node voltages, branch currents, logic levels, firmware
 * execution state and instrument traces live in an @forge/electronics session.
 *
 * Connectivity is EXPLICIT: two pins are on the same net only if a chain of wires, a shared
 * net label, a junction, or a device's internal terminal joins them. Positions (3D or
 * schematic) never create a connection.
 *
 * Units (SI): Ω, F, H, V, A, W, s, Hz, °C (temperatures are a documented exception: the
 * catalogue and datasheets use °C), rad for joint coordinates.
 */
export const ELECTRICAL_SCHEMA_VERSION = 1 as const;

const finite = z.number().finite();
const positive = finite.positive();
const nonNeg = finite.min(0);
const Note = z.string().max(500);
const Label = z.string().trim().min(1).max(40);
const Name = z.string().trim().min(1).max(200);
const NetName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-./$#]+$/, 'net names use letters, digits and _ + - . / $ #');

// -- waveforms ------------------------------------------------------------------------------
export const WaveformSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dc'), value: finite.min(-1e6).max(1e6) }),
  /** Step from v0 to v1 at time atS (a breakpoint for the transient solver). */
  z.object({ kind: z.literal('step'), v0: finite, v1: finite, atS: nonNeg }),
  /** SPICE PULSE semantics: v1 → v2 after delay, linear rise/fall, width at v2, period. */
  z.object({
    kind: z.literal('pulse'),
    v1: finite,
    v2: finite,
    delayS: nonNeg,
    riseS: nonNeg,
    fallS: nonNeg,
    widthS: nonNeg,
    periodS: positive,
  }),
  z.object({
    kind: z.literal('sine'),
    offset: finite,
    amplitude: finite,
    frequencyHz: positive.max(1e9),
    delayS: nonNeg,
    phaseDeg: finite,
  }),
  /** Piecewise-linear (time strictly increasing; held at the last value). */
  z.object({
    kind: z.literal('pwl'),
    points: z
      .array(z.tuple([nonNeg, finite]))
      .min(1)
      .max(1000)
      .refine((pts) => pts.every((q, i) => i === 0 || q[0] > pts[i - 1]![0]), {
        message: 'PWL times must be strictly increasing',
      }),
  }),
]);
export type Waveform = z.infer<typeof WaveformSchema>;

// -- device models --------------------------------------------------------------------------
const DiodeModel = z.object({
  /** Shockley saturation current Is (A). */
  saturationCurrentA: positive.max(1),
  /** Emission coefficient n. */
  emissionCoefficient: finite.min(0.5).max(10),
  /** Ohmic series resistance (Ω). */
  seriesResistanceOhm: nonNeg.max(1e6),
});

const JointLink = z.object({
  kind: z.literal('joint'),
  mateId: IdSchema,
  /** Joint coordinate (rad or m) mapped to the start / end of the device's range. */
  qMin: finite,
  qMax: finite,
});

export const DeviceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resistor'),
    resistanceOhm: positive.min(1e-6).max(1e12),
    powerRatingW: positive.nullable(),
  }),
  z.object({
    type: z.literal('capacitor'),
    capacitanceF: positive.max(1e3),
    voltageRatingV: positive.nullable(),
    initialVoltageV: finite.nullable(),
    polarized: z.boolean(),
  }),
  z.object({
    type: z.literal('inductor'),
    inductanceH: positive.max(1e3),
    currentRatingA: positive.nullable(),
    initialCurrentA: finite.nullable(),
  }),
  z.object({
    type: z.literal('vsource'),
    waveform: WaveformSchema,
    /** Internal (series) resistance; 0 = ideal source. */
    seriesResistanceOhm: nonNeg.max(1e6),
    /** Rated output current (A), for design-rule checks only; null = unknown/not rated. */
    currentLimitA: positive.nullable(),
    purpose: z.enum(['signal', 'supply']),
  }),
  z.object({ type: z.literal('isource'), waveform: WaveformSchema }),
  z.object({ type: z.literal('ground') }),
  z.object({ type: z.literal('junction') }),
  z.object({
    type: z.literal('switch'),
    closed: z.boolean(),
    /** Idealised switch: closed = this resistance, open = no connection. */
    onResistanceOhm: positive.max(1e3),
  }),
  z.object({ type: z.literal('vcvs'), gain: finite.min(-1e9).max(1e9) }),
  z.object({ type: z.literal('vccs'), transconductanceS: finite.min(-1e6).max(1e6) }),
  z.object({
    type: z.literal('diode'),
    model: DiodeModel,
    maxForwardCurrentA: positive.nullable(),
    maxReverseVoltageV: positive.nullable(),
    preset: z.string().max(64),
  }),
  z.object({
    type: z.literal('led'),
    model: DiodeModel,
    color: z.enum(['red', 'green', 'yellow', 'blue', 'white']),
    maxForwardCurrentA: positive.nullable(),
    maxReverseVoltageV: positive.nullable(),
    preset: z.string().max(64),
  }),
  z.object({
    type: z.literal('npn'),
    /** Ebers–Moll transport model parameters. */
    saturationCurrentA: positive.max(1),
    betaF: positive.max(1e5),
    betaR: positive.max(1e5),
    maxCollectorCurrentA: positive.nullable(),
  }),
  z.object({
    type: z.literal('nmos'),
    /** Shichman–Hodges (level-1) square-law switching approximation. */
    thresholdV: finite.min(-50).max(50),
    /** K = µCox·W/L (A/V²). */
    transconductanceAPerV2: positive.max(1e3),
    lambdaPerV: nonNeg.max(1),
    maxDrainCurrentA: positive.nullable(),
  }),
  z.object({
    type: z.literal('potentiometer'),
    resistanceOhm: positive.min(1).max(1e9),
    /** Wiper position 0 (at A) … 1 (at B); overridden at runtime by a joint link. */
    position: finite.min(0).max(1),
    link: z.discriminatedUnion('kind', [z.object({ kind: z.literal('manual') }), JointLink]),
  }),
  z.object({
    type: z.literal('mcu'),
    board: z.literal('arduino-uno-r3'),
    /** usb: the 5 V rail is supplied by a USB host (fused 500 mA); external: by its pins. */
    power: z.enum(['usb', 'external']),
    firmwareId: IdSchema.nullable(),
  }),
  z.object({
    type: z.literal('hc-sr04'),
    /** Air temperature for the speed of sound (°C); null = the circuit's ambient. */
    temperatureC: finite.min(-40).max(85).nullable(),
    minRangeM: positive.max(1),
    maxRangeM: positive.max(20),
    /** Half-angle of the sensing cone (rad); 7.5° ≈ the cited 15° measuring angle. */
    beamHalfAngleRad: finite.min(0).max(Math.PI / 4),
    /** 1 = central ray only; 7 = centre + 6 rays on the cone (nearest hit). */
    rays: z.union([z.literal(1), z.literal(7)]),
    /** Gaussian range noise σ (m); 0 = deterministic. */
    noiseStdM: nonNeg.max(1),
    /** Echo pulse width when nothing is detected (µs). */
    noEchoPulseUs: positive.max(1e6),
    /** Delay from the trigger's falling edge to the echo's rising edge (µs). */
    burstDelayUs: nonNeg.max(1e5),
    /** Minimum trigger pulse accepted (µs). */
    minTriggerUs: positive.max(1e4),
  }),
  z.object({
    type: z.literal('servo'),
    model: z.enum(['sg90', 'mg996r', 'generic']),
    /** Joint driven by this servo (Phase 5 actuator); null = not mechanically linked. */
    mateId: IdSchema.nullable(),
    /** Pulse width at 0° and at angleRangeDeg. */
    pulseMinUs: positive.max(1e5),
    pulseMaxUs: positive.max(1e5),
    angleRangeDeg: positive.max(360),
    /** Joint coordinate (rad) when the servo is at the centre of its range, and direction. */
    jointCentreRad: finite,
    direction: z.union([z.literal(1), z.literal(-1)]),
    /** Pulse-width changes smaller than this are ignored (µs). */
    deadbandUs: nonNeg.max(1000),
    /** Pulses outside [validMinUs, validMaxUs] are rejected as invalid. */
    validMinUs: positive.max(1e5),
    validMaxUs: positive.max(1e5),
    /** Supply range the model accepts; outside it the actuator is disabled (unpowered). */
    minSupplyV: positive.max(100),
    maxSupplyV: positive.max(100),
  }),
  z.object({
    type: z.literal('limit-switch'),
    link: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('manual'), pressed: z.boolean() }),
      z.object({
        kind: z.literal('joint'),
        mateId: IdSchema,
        thresholdQ: finite,
        pressedWhen: z.enum(['above', 'below']),
      }),
    ]),
    onResistanceOhm: positive.max(1e3),
  }),
  z.object({
    type: z.literal('encoder'),
    mateId: IdSchema.nullable(),
    /** Pulses per revolution per channel (4× counts in quadrature). */
    pulsesPerRev: z.number().int().min(1).max(100_000),
  }),
  z.object({
    type: z.literal('temp-sensor'),
    /** Linear transfer Vout = offsetV + slopeVPerC × T. */
    offsetV: finite.min(-10).max(10),
    slopeVPerC: finite.min(-1).max(1),
  }),
  z.object({
    type: z.literal('logic-gate'),
    op: z.enum(['and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buffer']),
    inputs: z.number().int().min(1).max(8),
    delayNs: nonNeg.max(1e9),
    logicV: positive.max(50),
  }),
  z.object({ type: z.literal('dff'), delayNs: nonNeg.max(1e9), logicV: positive.max(50) }),
  z.object({
    type: z.literal('counter'),
    bits: z.number().int().min(1).max(16),
    delayNs: nonNeg.max(1e9),
    logicV: positive.max(50),
  }),
  z.object({
    type: z.literal('clock'),
    frequencyHz: positive.max(1e8),
    duty: finite.min(0).max(1),
    logicV: positive.max(50),
  }),
]);
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceType = Device['type'];
export type DeviceOf<T extends DeviceType> = Extract<Device, { type: T }>;

export const SchematicPlacementSchema = z.object({
  /** Schematic grid units (1 unit = 0.1 inch at 100 % zoom). */
  x: finite.min(-1e5).max(1e5),
  y: finite.min(-1e5).max(1e5),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});
export type SchematicPlacement = z.infer<typeof SchematicPlacementSchema>;

export const ElectricalPartSchema = z.object({
  id: IdSchema,
  /** Reference designator (R1, U1 …), unique within the circuit. */
  label: Label,
  name: Name,
  device: DeviceSchema,
  /** Catalogue definition this part represents (null = an ideal analysis element). */
  definitionId: z.string().min(1).max(128).nullable(),
  /** Placed 3D component instance (null = schematic-only). A dangling id is reported, not fatal. */
  nodeId: IdSchema.nullable(),
  schematic: SchematicPlacementSchema,
  note: Note.default(''),
});
export type ElectricalPart = z.infer<typeof ElectricalPartSchema>;

export const PinRefSchema = z.object({ partId: IdSchema, pin: z.string().min(1).max(32) });
export type PinRef = z.infer<typeof PinRefSchema>;

export const WireSchema = z.object({
  id: IdSchema,
  a: PinRefSchema,
  b: PinRefSchema,
  /** Schematic intermediate route points (grid units); empty = automatic orthogonal route. */
  route: z.array(z.tuple([finite, finite])).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
});
export type Wire = z.infer<typeof WireSchema>;

/** A named signal: every pin carrying the same label name is on the same net. */
export const NetLabelSchema = z.object({ id: IdSchema, name: NetName, pin: PinRefSchema });
export type NetLabel = z.infer<typeof NetLabelSchema>;

/** Hierarchical circuit group (organisation only; no electrical effect). */
export const CircuitGroupSchema = z.object({
  id: IdSchema,
  name: Name,
  parentId: IdSchema.nullable(),
  partIds: z.array(IdSchema).max(10_000),
});

/** Named bus: a set of net names shown and probed together (no extra connectivity). */
export const BusSchema = z.object({ id: IdSchema, name: NetName, nets: z.array(NetName).min(1).max(64) });

export const FIRMWARE_LANGUAGES = ['arduino-subset'] as const;
export const FIRMWARE_MAX_BYTES = 64 * 1024;
export const FirmwareSchema = z.object({
  id: IdSchema,
  name: Name,
  /** "arduino-subset": FORGE's documented Arduino C/C++ subset (docs/EMBEDDED_RUNTIME.md). */
  language: z.enum(FIRMWARE_LANGUAGES),
  source: z.string().max(FIRMWARE_MAX_BYTES),
  /** Incremented on every change; recorded in telemetry as the firmware revision. */
  revision: z.number().int().min(1),
});
export type Firmware = z.infer<typeof FirmwareSchema>;

export const ElectricalSettingsSchema = z.object({
  /** Nonlinear DC / transient Newton iteration. */
  solver: z.object({
    relTol: positive.max(0.1),
    absTolV: positive.max(1),
    absTolA: positive.max(1),
    maxNewtonIterations: z.number().int().min(5).max(1000),
    /** Conductance (S) from every node to ground, as in SPICE; 0 disables it. */
    gmin: nonNeg.max(1e-3),
  }),
  transient: z.object({
    method: z.enum(['trapezoidal', 'backward-euler']),
    stepS: positive.min(1e-12).max(10),
    stopS: positive.max(1e4),
  }),
  cosim: z.object({
    /** Simulated time charged per interpreted firmware operation (ns); not cycle-accurate. */
    opCostNs: nonNeg.max(1e6),
    /** Ambient air temperature (°C) for sensors (no thermal simulation exists). */
    ambientC: finite.min(-40).max(85),
    /** Seed of the deterministic noise generator. */
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1),
    recording: z.object({
      sampleRateHz: positive.max(10_000),
      maxSamples: z.number().int().min(100).max(200_000),
      maxTransitions: z.number().int().min(100).max(500_000),
    }),
  }),
});
export type ElectricalSettings = z.infer<typeof ElectricalSettingsSchema>;

export const DEFAULT_ELECTRICAL_SETTINGS: ElectricalSettings = {
  solver: { relTol: 1e-6, absTolV: 1e-9, absTolA: 1e-12, maxNewtonIterations: 100, gmin: 1e-12 },
  transient: { method: 'trapezoidal', stepS: 1e-5, stopS: 0.01 },
  cosim: {
    opCostNs: 250,
    ambientC: 20,
    seed: 1,
    recording: { sampleRateHz: 120, maxSamples: 12_000, maxTransitions: 50_000 },
  },
};

export const ElectricalDefinitionSchema = z
  .object({
    schemaVersion: z.literal(ELECTRICAL_SCHEMA_VERSION),
    name: Name,
    parts: z.array(ElectricalPartSchema).max(5000),
    wires: z.array(WireSchema).max(20_000),
    netLabels: z.array(NetLabelSchema).max(5000),
    groups: z.array(CircuitGroupSchema).max(1000),
    buses: z.array(BusSchema).max(256),
    firmware: z.array(FirmwareSchema).max(32),
    settings: ElectricalSettingsSchema,
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const unique = (vals: string[], path: string, what: string) => {
      const seen = new Set<string>();
      for (const v of vals) {
        if (seen.has(v)) issue([path], `duplicate ${what} "${v}"`);
        seen.add(v);
      }
    };
    unique(
      d.parts.map((x) => x.id),
      'parts',
      'part id',
    );
    unique(
      d.parts.map((x) => x.label),
      'parts',
      'reference designator',
    );
    unique(
      d.wires.map((x) => x.id),
      'wires',
      'wire id',
    );
    unique(
      d.netLabels.map((x) => x.id),
      'netLabels',
      'label id',
    );
    unique(
      d.firmware.map((x) => x.id),
      'firmware',
      'firmware id',
    );
    const pins = new Map(d.parts.map((x) => [x.id, new Set(devicePins(x.device).map((q) => q.id))]));
    const checkRef = (r: PinRef, path: (string | number)[]) => {
      const set = pins.get(r.partId);
      if (!set) issue(path, `unknown part "${r.partId}"`);
      else if (!set.has(r.pin)) issue(path, `part "${r.partId}" has no pin "${r.pin}"`);
    };
    d.wires.forEach((w, i) => {
      checkRef(w.a, ['wires', i, 'a']);
      checkRef(w.b, ['wires', i, 'b']);
      if (w.a.partId === w.b.partId && w.a.pin === w.b.pin)
        issue(['wires', i], 'a wire cannot connect a pin to itself');
    });
    d.netLabels.forEach((l, i) => checkRef(l.pin, ['netLabels', i, 'pin']));
    const fw = new Set(d.firmware.map((f) => f.id));
    d.parts.forEach((x, i) => {
      if (x.device.type === 'mcu' && x.device.firmwareId && !fw.has(x.device.firmwareId))
        issue(['parts', i, 'device', 'firmwareId'], `unknown firmware "${x.device.firmwareId}"`);
      if (x.device.type === 'servo') {
        if (x.device.pulseMaxUs <= x.device.pulseMinUs)
          issue(['parts', i, 'device'], 'pulseMaxUs must exceed pulseMinUs');
        if (x.device.validMaxUs <= x.device.validMinUs)
          issue(['parts', i, 'device'], 'validMaxUs must exceed validMinUs');
        if (x.device.maxSupplyV < x.device.minSupplyV)
          issue(['parts', i, 'device'], 'maxSupplyV must be ≥ minSupplyV');
      }
      if (x.device.type === 'hc-sr04' && x.device.maxRangeM <= x.device.minRangeM)
        issue(['parts', i, 'device'], 'maxRangeM must exceed minRangeM');
    });
    const partIds = new Set(d.parts.map((x) => x.id));
    const groupIds = new Set(d.groups.map((g) => g.id));
    d.groups.forEach((g, i) => {
      if (g.parentId && !groupIds.has(g.parentId)) issue(['groups', i, 'parentId'], 'unknown parent group');
      g.partIds.forEach((pid) => {
        if (!partIds.has(pid)) issue(['groups', i, 'partIds'], `unknown part "${pid}"`);
      });
    });
  });
export type ElectricalDefinition = z.infer<typeof ElectricalDefinitionSchema>;

export function defaultElectricalDefinition(name = 'Circuit'): ElectricalDefinition {
  return {
    schemaVersion: ELECTRICAL_SCHEMA_VERSION,
    name,
    parts: [],
    wires: [],
    netLabels: [],
    groups: [],
    buses: [],
    firmware: [],
    settings: JSON.parse(JSON.stringify(DEFAULT_ELECTRICAL_SETTINGS)) as ElectricalSettings,
  };
}
