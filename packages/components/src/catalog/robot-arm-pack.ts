import type { ComponentDefinitionInput } from '../schemas';
import { C, fam, L, N, spec, V } from './builders';

/**
 * Robotic-arm assembly pack (VEYRIS demonstration set).
 *
 * Named products cite the public documents their values come from and are marked
 * `datasheet-cited` — transcribed, not measured or verified by FORGE. Geometry for
 * named parts reproduces published OVERALL dimensions; internal/detail placement is
 * approximate and says so. Commodity boards sold under many brands (breadboards,
 * L298N-type driver modules, MB102-type power modules) are GENERIC.
 * No entry claims actuation, circuit behaviour or validated joint constraints.
 */
const DC = 'datasheet-cited' as const;

export const ROBOT_ARM_PACK: ComponentDefinitionInput[] = [
  fam('computing-microcontrollers', 'Arduino boards', 'arduino-uno-r3', 'Arduino UNO R3', {
    description:
      'ATmega328P development board. Board outline (68.6 × 53.4 mm) and the four mounting holes follow the published board drawing; header, USB-B and DC-jack positions are approximate. Header pins carry their Arduino signal names.',
    tier: 'B',
    generator: 'board',
    representation: 'envelope',
    fixed: { layout: 'arduino-uno' },
    materialId: null,
    aliases: ['arduino', 'uno', 'atmega328p', 'microcontroller'],
    manufacturer: { name: 'Arduino', product: 'UNO R3' },
    references: [
      {
        title: 'Arduino UNO R3 — product documentation and technical specifications',
        kind: 'documentation',
        url: 'https://docs.arduino.cc/hardware/uno-rev3/',
      },
    ],
    dataStatus: DC,
    specifiedMassKg: 0.025,
    electrical: [
      spec('mcu', 'Microcontroller', 'ATmega328P', '', DC),
      spec('operating-voltage', 'Operating voltage', 5, 'V', DC),
      spec('input-voltage', 'Input voltage (recommended)', '7–12', 'V', DC),
      spec('digital-io', 'Digital I/O pins', 14, '', DC, '6 provide PWM output.'),
      spec('analog-in', 'Analog input pins', 6, '', DC),
      spec('io-current', 'DC current per I/O pin', 20, 'mA', DC),
      spec('flash', 'Flash memory', 32, 'KB', DC, '0.5 KB used by the bootloader.'),
      spec('sram', 'SRAM', 2, 'KB', DC),
      spec('eeprom', 'EEPROM', 1, 'KB', DC),
      spec('clock', 'Clock speed', 16, 'MHz', DC),
    ],
    mechanical: [
      spec('board-size', 'Board size', '68.6 × 53.4', 'mm', DC),
      spec('mass', 'Mass', 25, 'g', DC),
    ],
    domains: ['rigid-body', 'electrical'],
  }),
  fam('motors-actuators', 'Micro servos', 'towerpro-sg90', 'SG90 micro servo', {
    description:
      '9 g class micro servo. Overall case dimensions follow the commonly published SG90 datasheet (22.2 × 11.8 × 31 mm); flange, boss and lead positions are approximate. Plastic gears; 3-wire lead (PWM, V+, GND).',
    tier: 'B',
    generator: 'servo',
    representation: 'envelope',
    materialId: null,
    aliases: ['sg90', 'micro servo', '9g servo', 'servo'],
    parameters: [
      C(
        'spline',
        'Output spline',
        [['servo-spline-micro', 'Micro-servo spline (tooth count varies by source)']],
        'servo-spline-micro',
      ),
    ],
    fixed: {
      caseLength: 0.0222,
      caseWidth: 0.0118,
      caseHeight: 0.0227,
      flangeLength: 0.0322,
      flangeHeight: 0.0159,
      overallHeight: 0.031,
      color: 'servo-blue',
      tabScrew: 'M2',
    },
    manufacturer: { name: 'TowerPro', product: 'SG90' },
    references: [
      {
        title: 'TowerPro SG90 micro servo datasheet',
        kind: 'datasheet',
        note: 'Values as published by the vendor; clones vary.',
      },
    ],
    dataStatus: DC,
    specifiedMassKg: 0.009,
    mechanical: [
      spec(
        'stall-torque',
        'Stall torque (4.8 V)',
        1.8,
        'kgf·cm',
        DC,
        '≈ 0.18 N·m. Not a continuous-duty rating.',
      ),
      spec('speed', 'Operating speed (4.8 V)', 0.1, 's / 60°', DC),
      spec('size', 'Case size', '22.2 × 11.8 × 31', 'mm', DC),
    ],
    electrical: [
      spec(
        'voltage',
        'Operating voltage',
        4.8,
        'V',
        DC,
        'Commonly operated at 4.8–6 V; check the specific part.',
      ),
      spec('deadband', 'Dead band width', 10, 'µs', DC),
      spec('stall-current', 'Stall current', null, 'A', 'unverified', 'Not given in the cited datasheet.'),
    ],
    domains: ['rigid-body', 'kinematics', 'electrical'],
  }),
  fam('motors-actuators', 'High-torque servos', 'towerpro-mg996r', 'MG996R high-torque servo', {
    description:
      'Standard-size metal-gear servo. Overall dimensions follow the commonly published MG996R datasheet (40.7 × 19.7 × 42.9 mm); flange and boss positions are approximate.',
    tier: 'B',
    generator: 'servo',
    representation: 'envelope',
    materialId: null,
    aliases: ['mg996r', 'mg996', 'metal gear servo', 'servo'],
    parameters: [
      C(
        'spline',
        'Output spline',
        [['servo-spline-25T', '25-tooth (as commonly specified)']],
        'servo-spline-25T',
      ),
    ],
    fixed: {
      caseLength: 0.0407,
      caseWidth: 0.0197,
      caseHeight: 0.0372,
      flangeLength: 0.0545,
      flangeHeight: 0.0275,
      overallHeight: 0.0429,
      color: 'black',
      tabScrew: 'M4',
    },
    manufacturer: { name: 'TowerPro', product: 'MG996R' },
    references: [
      {
        title: 'TowerPro MG996R servo datasheet',
        kind: 'datasheet',
        note: 'Values as published by the vendor; clones vary.',
      },
    ],
    dataStatus: DC,
    specifiedMassKg: 0.055,
    mechanical: [
      spec('stall-torque-4-8', 'Stall torque (4.8 V)', 9.4, 'kgf·cm', DC, '≈ 0.92 N·m'),
      spec('stall-torque-6', 'Stall torque (6 V)', 11, 'kgf·cm', DC, '≈ 1.08 N·m'),
      spec('speed-4-8', 'Operating speed (4.8 V)', 0.17, 's / 60°', DC),
      spec('speed-6', 'Operating speed (6 V)', 0.14, 's / 60°', DC),
      spec('size', 'Case size', '40.7 × 19.7 × 42.9', 'mm', DC),
    ],
    electrical: [
      spec('voltage', 'Operating voltage', '4.8–7.2', 'V', DC),
      spec(
        'stall-current',
        'Stall current',
        null,
        'A',
        'unverified',
        'Varies between sources; treated as unknown.',
      ),
    ],
    domains: ['rigid-body', 'kinematics', 'electrical'],
  }),
  fam('sensors-measurement', 'Ultrasonic sensors', 'hc-sr04', 'HC-SR04 ultrasonic ranging module', {
    description:
      'Ultrasonic distance module: two 40 kHz transducers and a 4-pin header (VCC, Trig, Echo, GND). Module size follows the commonly published datasheet (45 × 20 × 15 mm); transducer spacing is approximate. The board stands upright with transducers facing +Z.',
    tier: 'B',
    generator: 'ultrasonic',
    representation: 'envelope',
    materialId: null,
    aliases: ['ultrasonic', 'sonar', 'distance sensor', 'hc-sr04'],
    fixed: {
      length: 0.045,
      height: 0.02,
      transducerDiameter: 0.016,
      transducerLength: 0.012,
      transducerSpacing: 0.026,
      pins: 'VCC,Trig,Echo,GND',
    },
    references: [
      {
        title: 'HC-SR04 ultrasonic ranging module user manual / datasheet',
        kind: 'datasheet',
        note: 'Widely redistributed generic datasheet; many manufacturers.',
      },
    ],
    dataStatus: DC,
    electrical: [
      spec('voltage', 'Working voltage', 5, 'V DC', DC),
      spec('current', 'Working current', 15, 'mA', DC),
      spec('frequency', 'Working frequency', 40, 'kHz', DC),
      spec('trigger', 'Trigger input', '10 µs TTL pulse', '', DC),
    ],
    mechanical: [
      spec('range', 'Measuring range', '2–400', 'cm', DC),
      spec('angle', 'Measuring angle', 15, '°', DC),
      spec('size', 'Module size', '45 × 20 × 15', 'mm', DC),
    ],
    domains: ['rigid-body', 'electrical', 'optical'],
  }),
  fam('robotics-mobility', 'Robot joints', 'servo-mount-bracket', 'Servo mounting bracket', {
    description:
      'L-bracket that holds a standard or micro servo by its flange tabs and mounts to a link or base.',
    tier: 'A',
    generator: 'bracket-l',
    representation: 'exact',
    materialId: 'al-6061-t6',
    allowedMaterialIds: ['al-6061-t6', 'pla', 'petg', 'steel-1018'],
    aliases: ['servo bracket'],
    parameters: [
      L('width', 'Width', 25, 10, 80),
      L('legA', 'Base leg', 30, 10, 100),
      L('legB', 'Upright', 45, 10, 120),
      L('thickness', 'Thickness', 2.5, 1, 8),
      C('holeSize', 'Holes', ['M2', 'M3', 'M4'], 'M3'),
    ],
    variants: [
      V('standard', 'Standard servo (MG996R class)', { width: 25, legB: 45 }, ['width', 'legB']),
      V(
        'micro',
        'Micro servo (SG90 class)',
        { width: 15, legA: 20, legB: 28, thickness: 2, holeSize: 'M2' },
        ['width', 'legA', 'legB', 'thickness'],
      ),
    ],
  }),
  fam('robotics-mobility', 'Robot chassis', 'arm-base-plate', 'Robot arm base plate', {
    description: 'Square base plate with corner fixing holes for mounting an arm to the bench.',
    tier: 'A',
    generator: 'plate',
    representation: 'exact',
    materialId: 'al-6061-t6',
    allowedMaterialIds: ['al-6061-t6', 'steel-1018', 'pla', 'birch-plywood'],
    parameters: [
      L('length', 'Length', 150, 40, 500),
      L('width', 'Width', 150, 40, 500),
      L('thickness', 'Thickness', 6, 2, 20),
      C('holes', 'Corner holes', ['M4', 'M5', 'M6'], 'M5'),
      L('holeInset', 'Hole inset', 10, 4, 40),
    ],
  }),
  fam('connectors-wiring-pcbs', 'Breadboards', 'breadboard', 'Solderless breadboard (generic)', {
    description:
      'Solderless breadboard with two power rails. Generic sizes; tie-point holes are not modelled individually.',
    tier: 'B',
    generator: 'breadboard',
    representation: 'envelope',
    materialId: null,
    aliases: ['protoboard', 'solderless'],
    parameters: [
      C(
        'size',
        'Size',
        [
          ['half', 'Half (≈400 tie points)'],
          ['full', 'Full (≈830 tie points)'],
        ],
        'half',
      ),
      L('length', 'Length', 82, 30, 200),
      L('width', 'Width', 55, 30, 80),
      L('height', 'Height', 8.5, 5, 15),
    ],
    variants: [
      V('half', 'Half size (82 × 55 mm)', { size: 'half', length: 82 }, ['length']),
      V('full', 'Full size (165 × 55 mm)', { size: 'full', length: 165 }, ['length']),
    ],
    domains: ['rigid-body', 'electrical'],
  }),
  fam('connectors-wiring-pcbs', 'Dupont connectors', 'jumper-wire', 'Jumper wire (Dupont-style)', {
    description: 'Pre-crimped 2.54 mm jumper lead. Shown straight between its end housings.',
    tier: 'A',
    generator: 'wire',
    representation: 'envelope',
    materialId: null,
    aliases: ['jumper', 'dupont', 'wire'],
    parameters: [
      L('length', 'Length', 100, 30, 500),
      L('diameter', 'Diameter', 1.3, 0.5, 3),
      C(
        'color',
        'Colour',
        [
          ['red', 'Red'],
          ['black', 'Black'],
          ['yellow', 'Yellow'],
          ['blue', 'Blue'],
          ['green', 'Green'],
          ['white', 'White'],
        ],
        'red',
      ),
      C(
        'ends',
        'Ends',
        [
          ['male-male', 'Male–male'],
          ['male-female', 'Male–female'],
          ['female-female', 'Female–female'],
        ],
        'male-male',
      ),
    ],
    variants: [
      V('mm-100', 'M–M 100 mm', { ends: 'male-male', length: 100 }, ['length']),
      V('mf-200', 'M–F 200 mm', { ends: 'male-female', length: 200 }, ['length']),
      V('ff-200', 'F–F 200 mm', { ends: 'female-female', length: 200 }, ['length']),
    ],
    domains: ['rigid-body', 'electrical'],
  }),
  fam(
    'power-electronics-electrical',
    'Linear regulators',
    'breadboard-power-module',
    'Breadboard power supply module (generic)',
    {
      description:
        'Plug-in breadboard power module with selectable 3.3 V / 5 V rails (MB102-type, many makers). Ratings are not specified for this generic entry.',
      tier: 'B',
      generator: 'board',
      representation: 'envelope',
      fixed: { layout: 'generic', pins: '5V,GND,3V3,GND' },
      materialId: null,
      aliases: ['dc power module', 'mb102', 'power supply'],
      parameters: [
        L('length', 'Board length', 53, 30, 80),
        L('width', 'Board width', 33, 20, 60),
        L('componentHeight', 'Component height', 11, 2, 20),
        C(
          'pcbColor',
          'PCB colour',
          [
            ['pcb', 'Green'],
            ['pcb-blue', 'Blue'],
          ],
          'pcb',
        ),
      ],
      electrical: [
        spec('outputs', 'Output rails', '3.3 V / 5 V (selectable)', '', 'generic'),
        spec('current', 'Output current', null, 'A', 'unverified', 'Depends on the board; unknown.'),
      ],
      domains: ['rigid-body', 'electrical'],
    },
  ),
  fam('power-energy-storage', 'Battery packs', 'battery-pack', 'Battery pack', {
    description:
      'Series/parallel cell pack in a holder tray with leads; capacity depends on the cells fitted (unknown).',
    tier: 'B',
    generator: 'cell-pack',
    representation: 'envelope',
    materialId: null,
    aliases: ['batteries', '4xaa', '2s', 'battery'],
    parameters: [
      C('format', 'Cell format', ['AA', 'AAA', '18650', '21700'], 'AA'),
      N('series', 'Cells in series', 4, 1, 8),
      N('parallel', 'Parallel strings', 1, 1, 4),
      { kind: 'boolean', id: 'cellsFitted', label: 'Cells fitted', default: true },
    ],
    variants: [
      V('4xaa', '4 × AA (≈6 V alkaline / 4.8 V NiMH)', { format: 'AA', series: 4 }),
      V('2s-18650', '2S 18650 (≈7.4 V nominal Li-ion)', { format: '18650', series: 2 }),
    ],
    electrical: [spec('capacity', 'Capacity', null, 'mAh', 'unverified', 'Depends on cells.')],
    domains: ['rigid-body', 'electrical'],
  }),
  fam(
    'power-electronics-electrical',
    'Motor drivers',
    'dual-h-bridge-module',
    'Dual H-bridge motor driver module (L298N-type, generic)',
    {
      description:
        'Commodity dual H-bridge board built around an L298 driver IC with heat sink and screw terminals. Module ratings are not specified; the IC limits below are from the IC datasheet and do not guarantee the board.',
      tier: 'B',
      generator: 'board',
      representation: 'envelope',
      fixed: { layout: 'generic', pins: 'ENA,IN1,IN2,IN3,IN4,ENB' },
      materialId: null,
      aliases: ['l298n', 'motor control module', 'motor driver', 'h-bridge'],
      parameters: [
        L('length', 'Board length', 43, 30, 80),
        L('width', 'Board width', 43, 30, 80),
        L('componentHeight', 'Heat-sink height', 25, 5, 40),
        C(
          'pcbColor',
          'PCB colour',
          [
            ['pcb', 'Green'],
            ['red', 'Red'],
          ],
          'pcb',
        ),
      ],
      references: [
        {
          title: 'STMicroelectronics L298 dual full-bridge driver datasheet',
          kind: 'datasheet',
          note: 'IC-level limits only.',
        },
      ],
      dataStatus: 'generic',
      electrical: [
        spec(
          'ic-supply',
          'IC supply voltage (max)',
          46,
          'V',
          DC,
          'L298 absolute maximum; module limits may be lower.',
        ),
        spec(
          'ic-current',
          'IC total DC current (max)',
          4,
          'A',
          DC,
          'L298 datasheet; heat-sinking dependent.',
        ),
        spec(
          'module-current',
          'Module continuous current',
          null,
          'A',
          'unverified',
          'Board-specific; unknown.',
        ),
      ],
      domains: ['rigid-body', 'electrical'],
    },
  ),
];
