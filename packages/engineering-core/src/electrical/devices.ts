/**
 * Electrical DEVICE TERMINALS (Phase 6): the pins every supported device model exposes and
 * the model terminal each pin connects to. Several physical pins may share one terminal
 * (e.g. the three GND header pins of an Arduino UNO are one internal net).
 *
 * This table is structural data used to validate wiring commands. Rich, catalogue-specific
 * pin metadata (voltage/current limits with their sources, connector descriptors, 3D
 * positions) extends the component catalogue in @forge/components (electrical-pins.ts) and
 * refers back to these pin ids.
 */

/** Electrical role of a pin (brief §3). */
export const PIN_ROLES = [
  'ground',
  'supply',
  'analog-input',
  'analog-output',
  'digital-input',
  'digital-output',
  'gpio',
  'pwm',
  'serial',
  'motor-output',
  'sensor-signal',
  'passive',
] as const;
export type PinRole = (typeof PIN_ROLES)[number];

export const PIN_DIRECTIONS = [
  'input',
  'output',
  'bidirectional',
  'power-in',
  'power-out',
  'passive',
] as const;
export type PinDirection = (typeof PIN_DIRECTIONS)[number];

export const PIN_DOMAINS = ['analog', 'digital', 'power', 'mixed'] as const;
export type PinDomain = (typeof PIN_DOMAINS)[number];

export interface DevicePin {
  /** Stable pin id (unique within the device). */
  id: string;
  /** Display name. */
  name: string;
  /** Model terminal the pin connects to (pins sharing a terminal are one internal net). */
  terminal: string;
  role: PinRole;
  direction: PinDirection;
  domain: PinDomain;
  /** Free-text electrical function (e.g. "PWM-capable digital I/O (Timer2)"). */
  fn: string;
}

const p = (
  id: string,
  name: string,
  role: PinRole,
  direction: PinDirection,
  domain: PinDomain,
  fn: string,
  terminal = id,
): DevicePin => ({ id, name, terminal, role, direction, domain, fn });

const passive2 = (fn: string): DevicePin[] => [
  p('p1', 'Terminal 1', 'passive', 'passive', 'analog', fn),
  p('p2', 'Terminal 2', 'passive', 'passive', 'analog', fn),
];

/** Arduino UNO R3 header pins (names as printed on the board). */
const UNO_PWM = new Set([3, 5, 6, 9, 10, 11]);
export const UNO_DIGITAL_PINS = Array.from({ length: 14 }, (_, i) => `D${i}`);
export const UNO_ANALOG_PINS = Array.from({ length: 6 }, (_, i) => `A${i}`);
export const UNO_PWM_PINS = [...UNO_PWM].map((n) => `D${n}`);
const UNO_PINS: DevicePin[] = [
  ...UNO_DIGITAL_PINS.map((id, n) =>
    p(
      id,
      id,
      n <= 1 ? 'serial' : UNO_PWM.has(n) ? 'pwm' : 'gpio',
      'bidirectional',
      'digital',
      n === 0
        ? 'Digital I/O; USART RX'
        : n === 1
          ? 'Digital I/O; USART TX'
          : UNO_PWM.has(n)
            ? 'Digital I/O; hardware PWM output (analogWrite)'
            : n === 2 || n === 3
              ? 'Digital I/O; external interrupt'
              : 'Digital I/O',
    ),
  ),
  ...UNO_ANALOG_PINS.map((id) =>
    p(id, id, 'analog-input', 'bidirectional', 'mixed', '10-bit ADC input; also usable as digital I/O'),
  ),
  p('5V', '5V', 'supply', 'bidirectional', 'power', '5 V rail (regulator/USB output, or 5 V input)'),
  p('3V3', '3V3', 'supply', 'power-out', 'power', '3.3 V regulator output'),
  p('VIN', 'VIN', 'supply', 'power-in', 'power', 'Unregulated input to the on-board regulator'),
  p('IOREF', 'IOREF', 'supply', 'power-out', 'power', 'I/O reference voltage (tied to 5 V)', '5V'),
  p('AREF', 'AREF', 'analog-input', 'input', 'analog', 'ADC reference input (not modelled: AVCC is used)'),
  p(
    'RESET',
    'RESET',
    'digital-input',
    'input',
    'digital',
    'Active-low reset with an on-board pull-up (not modelled)',
  ),
  p('GND.1', 'GND (power header)', 'ground', 'passive', 'power', 'Ground', 'GND'),
  p('GND.2', 'GND (power header)', 'ground', 'passive', 'power', 'Ground', 'GND'),
  p('GND.3', 'GND (digital header)', 'ground', 'passive', 'power', 'Ground', 'GND'),
];

const SUPPLY_PINS = (fnPos: string): DevicePin[] => [
  p('pos', '+', 'supply', 'power-out', 'power', fnPos),
  p('neg', '−', 'ground', 'power-out', 'power', 'Negative terminal'),
];

/** Pins of a device of the given type (a function of its parameters where the count varies). */
export function devicePins(device: { type: string } & Record<string, unknown>): DevicePin[] {
  switch (device.type) {
    case 'resistor':
      return passive2('Resistor terminal');
    case 'capacitor':
      return device.polarized
        ? [
            p('pos', '+', 'passive', 'passive', 'analog', 'Positive terminal (polarised)'),
            p('neg', '−', 'passive', 'passive', 'analog', 'Negative terminal (polarised)'),
          ]
        : passive2('Capacitor terminal');
    case 'inductor':
      return passive2('Inductor terminal');
    case 'switch':
      return passive2('Switch contact');
    case 'vsource':
      return SUPPLY_PINS('Positive terminal');
    case 'isource':
      return [
        p('pos', '+', 'passive', 'power-out', 'analog', 'Current leaves the source here'),
        p('neg', '−', 'passive', 'power-in', 'analog', 'Current returns here'),
      ];
    case 'ground':
      return [p('gnd', 'GND', 'ground', 'passive', 'power', 'Circuit reference (0 V)')];
    case 'junction':
      return [p('j', 'Junction', 'passive', 'passive', 'analog', 'Explicit wire junction')];
    case 'vcvs':
    case 'vccs':
      return [
        p('out+', 'Out +', 'analog-output', 'output', 'analog', 'Controlled output (+)'),
        p('out-', 'Out −', 'analog-output', 'output', 'analog', 'Controlled output (−)'),
        p('ctl+', 'Control +', 'analog-input', 'input', 'analog', 'Control voltage (+)'),
        p('ctl-', 'Control −', 'analog-input', 'input', 'analog', 'Control voltage (−)'),
      ];
    case 'diode':
    case 'led':
      return [
        p('a', 'Anode', 'passive', 'passive', 'analog', 'Anode'),
        p('k', 'Cathode', 'passive', 'passive', 'analog', 'Cathode'),
      ];
    case 'npn':
      return [
        p('c', 'Collector', 'passive', 'passive', 'analog', 'Collector'),
        p('b', 'Base', 'analog-input', 'input', 'analog', 'Base'),
        p('e', 'Emitter', 'passive', 'passive', 'analog', 'Emitter'),
      ];
    case 'nmos':
      return [
        p('d', 'Drain', 'passive', 'passive', 'analog', 'Drain'),
        p('g', 'Gate', 'analog-input', 'input', 'analog', 'Gate (insulated)'),
        p('s', 'Source', 'passive', 'passive', 'analog', 'Source (body tied to source)'),
      ];
    case 'potentiometer':
      return [
        p('a', 'End A', 'passive', 'passive', 'analog', 'Track end A'),
        p('w', 'Wiper', 'analog-output', 'passive', 'analog', 'Wiper'),
        p('b', 'End B', 'passive', 'passive', 'analog', 'Track end B'),
      ];
    case 'mcu':
      return UNO_PINS;
    case 'hc-sr04':
      return [
        p('vcc', 'VCC', 'supply', 'power-in', 'power', '5 V supply input'),
        p('trig', 'Trig', 'digital-input', 'input', 'digital', 'Trigger input (≥ 10 µs HIGH pulse)'),
        p('echo', 'Echo', 'sensor-signal', 'output', 'digital', 'Echo output (pulse width ∝ distance)'),
        p('gnd', 'GND', 'ground', 'passive', 'power', 'Ground'),
      ];
    case 'servo':
      return [
        p('signal', 'Signal (PWM)', 'digital-input', 'input', 'digital', 'Control pulse input'),
        p('vplus', 'V+', 'supply', 'power-in', 'power', 'Motor and electronics supply'),
        p('gnd', 'GND', 'ground', 'passive', 'power', 'Ground'),
      ];
    case 'limit-switch':
      return [
        p('com', 'COM', 'passive', 'passive', 'analog', 'Common contact'),
        p('no', 'NO', 'passive', 'passive', 'analog', 'Normally-open contact'),
        p('nc', 'NC', 'passive', 'passive', 'analog', 'Normally-closed contact'),
      ];
    case 'encoder':
      return [
        p('vcc', 'VCC', 'supply', 'power-in', 'power', 'Supply'),
        p('a', 'A', 'sensor-signal', 'output', 'digital', 'Quadrature channel A'),
        p('b', 'B', 'sensor-signal', 'output', 'digital', 'Quadrature channel B'),
        p('gnd', 'GND', 'ground', 'passive', 'power', 'Ground'),
      ];
    case 'temp-sensor':
      return [
        p('vcc', 'VCC', 'supply', 'power-in', 'power', 'Supply'),
        p('out', 'Vout', 'sensor-signal', 'output', 'analog', 'Analog output voltage'),
        p('gnd', 'GND', 'ground', 'passive', 'power', 'Ground'),
      ];
    case 'logic-gate': {
      const n = typeof device.inputs === 'number' ? device.inputs : 2;
      return [
        ...Array.from({ length: n }, (_, i) =>
          p(`in${i + 1}`, `In ${i + 1}`, 'digital-input', 'input', 'digital', 'Logic input'),
        ),
        p('out', 'Out', 'digital-output', 'output', 'digital', 'Logic output (ideal push-pull)'),
      ];
    }
    case 'dff':
      return [
        p('d', 'D', 'digital-input', 'input', 'digital', 'Data input'),
        p('clk', 'CLK', 'digital-input', 'input', 'digital', 'Clock (rising edge)'),
        p('q', 'Q', 'digital-output', 'output', 'digital', 'Output'),
        p('qn', 'Q̅', 'digital-output', 'output', 'digital', 'Inverted output'),
      ];
    case 'counter': {
      const bits = typeof device.bits === 'number' ? device.bits : 4;
      return [
        p('clk', 'CLK', 'digital-input', 'input', 'digital', 'Clock (rising edge)'),
        p('rst', 'RST', 'digital-input', 'input', 'digital', 'Synchronous reset (active HIGH)'),
        ...Array.from({ length: bits }, (_, i) =>
          p(`q${i}`, `Q${i}`, 'digital-output', 'output', 'digital', `Count bit ${i}`),
        ),
      ];
    }
    case 'clock':
      return [p('out', 'Out', 'digital-output', 'output', 'digital', 'Clock / PWM output (ideal)')];
    default:
      return [];
  }
}

/** Device types whose pins are referenced to the circuit ground implicitly (ideal logic primitives). */
export const IMPLICIT_GROUND_DEVICES = new Set(['logic-gate', 'dff', 'counter', 'clock']);
