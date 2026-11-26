import type { FormatId } from './schemas';

/**
 * Format capability matrix — the single source shown in the import dialog and the docs.
 * Each entry states what FORGE actually does with the format today, verified by tests in
 * packages/interop/src/__tests__ (see docs/INTEROPERABILITY.md). "no" means not offered.
 */
export type Level = 'yes' | 'partial' | 'no';
export interface Capability {
  format: FormatId;
  label: string;
  extensions: string[];
  import: Level;
  export: Level;
  geometry: string;
  hierarchy: Level;
  materials: Level;
  units: string;
  editableFeatures: Level;
  simulation: string;
  roundTrip: string;
  notes: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    format: 'step',
    label: 'STEP (AP203/AP214/AP242)',
    extensions: ['.step', '.stp'],
    import: 'yes',
    export: 'no',
    geometry: 'Exact B-rep tessellated by OCCT (stated tolerance); B-rep not kept',
    hierarchy: 'yes',
    materials: 'partial',
    units: 'Declared length unit read; converted to metres by OCCT',
    editableFeatures: 'no',
    simulation: 'As imported model: explicit mass and bounding-box collider only',
    roundTrip: 'No STEP writer (no B-rep kernel for output); export as STL/GLB',
    notes:
      'Colours become materials; PMI, tolerances, material designations and kinematics are reported, not imported.',
  },
  {
    format: 'stl',
    label: 'STL (binary, ASCII)',
    extensions: ['.stl'],
    import: 'yes',
    export: 'yes',
    geometry: 'Triangle mesh as supplied',
    hierarchy: 'no',
    materials: 'no',
    units: 'None in the file: user confirms (default mm, +Z up)',
    editableFeatures: 'no',
    simulation: 'As imported model: explicit mass and bounding-box collider only',
    roundTrip: 'Geometry within float32 precision; names/units/hierarchy not representable',
    notes: 'Multiple ASCII solids become separate nodes; stored normals checked against winding.',
  },
  {
    format: 'glb',
    label: 'glTF binary (GLB)',
    extensions: ['.glb'],
    import: 'yes',
    export: 'yes',
    geometry: 'Triangle mesh; original bytes kept for display',
    hierarchy: 'yes',
    materials: 'partial',
    units: 'Metres, +Y up (specification)',
    editableFeatures: 'no',
    simulation: 'As imported model: explicit mass and bounding-box collider only',
    roundTrip: 'Hierarchy, names, transforms, triangles and PBR factors preserved; textures not exported',
    notes:
      'Compressed geometry (Draco, meshopt), skins and animations are not supported; external URIs refused.',
  },
  {
    format: 'gltf',
    label: 'glTF JSON (embedded buffers)',
    extensions: ['.gltf'],
    import: 'yes',
    export: 'no',
    geometry: 'Triangle mesh (data-URI buffers only)',
    hierarchy: 'yes',
    materials: 'partial',
    units: 'Metres, +Y up (specification)',
    editableFeatures: 'no',
    simulation: 'As imported model',
    roundTrip: 'Exported as GLB',
    notes: 'External .bin/texture files are never fetched.',
  },
  {
    format: 'urdf',
    label: 'URDF robot description',
    extensions: ['.urdf'],
    import: 'yes',
    export: 'no',
    geometry: 'Box/cylinder/sphere → FORGE primitives; STL/GLB meshes from selected files',
    hierarchy: 'yes',
    materials: 'partial',
    units: 'Metres, radians; z-up (REP-103) rotated to FORGE +Y up',
    editableFeatures: 'partial',
    simulation:
      'Links → bodies with URDF inertials; fixed/revolute/continuous/prismatic joints → mates with limits and dynamics',
    roundTrip: 'No URDF writer',
    notes:
      'Floating/planar joints, mimic, transmissions, Gazebo/ros2_control, Collada/OBJ meshes and separate collision geometry are reported, not imported.',
  },
  {
    format: 'spice',
    label: 'SPICE netlist (FORGE subset)',
    extensions: ['.cir', '.sp', '.spice', '.ckt'],
    import: 'yes',
    export: 'yes',
    geometry: 'n/a',
    hierarchy: 'no',
    materials: 'no',
    units: 'SI with SPICE suffixes',
    editableFeatures: 'yes',
    simulation: 'Existing MNA solver: DC and transient (.tran)',
    roundTrip: 'Values and connectivity identical (tested); unsupported elements block or are listed',
    notes:
      'R, C, L, V/I (DC, PULSE, SIN, PWL), E, G, D, Q (NPN), M (NMOS level 1). No subcircuits, B/F/H/K/S/W/T, AC/noise analyses or includes.',
  },
  {
    format: 'kicad-netlist',
    label: 'KiCad netlist (.net, version E)',
    extensions: ['.net'],
    import: 'yes',
    export: 'no',
    geometry: 'n/a',
    hierarchy: 'no',
    materials: 'no',
    units: 'Component values with SI suffixes',
    editableFeatures: 'yes',
    simulation: 'Mapped parts in the existing circuit solver',
    roundTrip: 'No KiCad writer; export SPICE or the FORGE electrical bundle',
    notes:
      'Exact library symbols map (Device R/C/L/D/LED/NPN/NMOS/Battery, Arduino UNO module); others are reported unmapped and can be mapped manually.',
  },
  {
    format: 'kicad-pcb',
    label: 'KiCad PCB (.kicad_pcb)',
    extensions: ['.kicad_pcb'],
    import: 'partial',
    export: 'no',
    geometry: 'Not imported (footprint placement recorded only)',
    hierarchy: 'no',
    materials: 'no',
    units: 'mm placement',
    editableFeatures: 'partial',
    simulation: 'Connectivity from pad nets into the circuit solver',
    roundTrip: 'No',
    notes:
      'Not an electromagnetic, thermal or manufacturing analysis; tracks, zones and 3D models are reported only.',
  },
  {
    format: 'kicad-schematic',
    label: 'KiCad schematic (.kicad_sch)',
    extensions: ['.kicad_sch'],
    import: 'partial',
    export: 'no',
    geometry: 'n/a',
    hierarchy: 'no',
    materials: 'no',
    units: 'n/a',
    editableFeatures: 'no',
    simulation: 'No: inspection only (symbol list)',
    roundTrip: 'No',
    notes: 'Connectivity is geometric in schematics and is not derived; export a netlist from KiCad.',
  },
  {
    format: 'forge-electrical',
    label: 'FORGE electrical bundle',
    extensions: ['.json'],
    import: 'yes',
    export: 'yes',
    geometry: 'n/a',
    hierarchy: 'yes',
    materials: 'no',
    units: 'SI',
    editableFeatures: 'yes',
    simulation: 'Complete',
    roundTrip: 'Exact (schema-validated)',
    notes: 'Phase 6 format.',
  },
  {
    format: 'forge-bundle',
    label: 'FORGE project bundle',
    extensions: ['.forge-bundle.json'],
    import: 'yes',
    export: 'yes',
    geometry: 'All FORGE representations',
    hierarchy: 'yes',
    materials: 'yes',
    units: 'SI',
    editableFeatures: 'yes',
    simulation: 'Complete',
    roundTrip: 'Exact (hash-verified assets)',
    notes: 'Phase 4 format; carries import provenance (schema v7).',
  },
];

export const capabilityOf = (f: FormatId) => CAPABILITIES.find((c) => c.format === f) ?? null;
