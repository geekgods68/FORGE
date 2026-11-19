/**
 * The 28 planned top-level component-library categories (docs/COMPONENT_CATALOG.md).
 * Only the identifiers are defined in Phase 0; no category is populated yet.
 */
export const COMPONENT_CATEGORIES = [
  ['structure-raw-materials', 'Structure & Raw Materials'],
  ['fasteners-joining', 'Fasteners & Joining'],
  ['mechanical-motion-transmission', 'Mechanical Motion & Transmission'],
  ['motors-actuators', 'Motors & Actuators'],
  ['robotics-mobility', 'Robotics & Mobility'],
  ['passive-electronics', 'Passive Electronics'],
  ['semiconductors-ics', 'Semiconductors & Integrated Circuits'],
  ['computing-microcontrollers', 'Computing & Microcontrollers'],
  ['sensors-measurement', 'Sensors & Measurement Components'],
  ['power-energy-storage', 'Power & Energy Storage'],
  ['power-electronics-electrical', 'Power Electronics & Electrical Systems'],
  ['connectors-wiring-pcbs', 'Connectors, Wiring & PCBs'],
  ['communications-networking', 'Communications & Networking'],
  ['displays-human-interfaces', 'Displays & Human Interfaces'],
  ['optics-photonics-imaging', 'Optics, Photonics & Imaging'],
  ['audio-acoustics', 'Audio & Acoustics'],
  ['fluid-pneumatic-hydraulic', 'Fluid, Pneumatic & Hydraulic Systems'],
  ['thermal-environmental', 'Thermal & Environmental Systems'],
  ['manufacturing-fabrication', 'Manufacturing & Fabrication Parts'],
  ['aerospace-drones-propulsion', 'Aerospace, Drones & Propulsion'],
  ['automation-industrial-control', 'Automation & Industrial Control'],
  ['advanced-materials-smart-devices', 'Advanced Materials & Smart Devices'],
  ['enclosures-product-design', 'Enclosures & Product Design'],
  ['complete-modules-assemblies', 'Complete Modules & Assemblies'],
  ['semiconductor-microfabrication', 'Semiconductor & Microfabrication'],
  ['test-specimens-calibration', 'Scientific Test Specimens & Calibration'],
  ['biomechanics-soft-robotics', 'Biomechanics & Soft Robotics'],
  ['experimental-environments-test-objects', 'Experimental Environments & Test Objects'],
] as const;

export type ComponentCategoryId = (typeof COMPONENT_CATEGORIES)[number][0];

export const COMPONENT_CATEGORY_IDS = COMPONENT_CATEGORIES.map(([id]) => id) as [
  ComponentCategoryId,
  ...ComponentCategoryId[],
];
