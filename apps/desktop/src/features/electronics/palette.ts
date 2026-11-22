import { electricalModelFor, getDefinition } from '@forge/components';
import {
  newId,
  type BatchSubCommand,
  type Device,
  type ElectricalDefinition,
  type ElectricalPart,
  type SceneNode,
} from '@forge/engineering-core';
import type { StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';
import { circuitOf } from './state';

/** Ideal analysis elements (schematic-only; no physical product implied). */
export const PRIMITIVES: { key: string; label: string; prefix: string; device: Device }[] = [
  {
    key: 'resistor',
    label: 'Resistor',
    prefix: 'R',
    device: { type: 'resistor', resistanceOhm: 1000, powerRatingW: null },
  },
  {
    key: 'capacitor',
    label: 'Capacitor',
    prefix: 'C',
    device: {
      type: 'capacitor',
      capacitanceF: 1e-6,
      voltageRatingV: null,
      initialVoltageV: null,
      polarized: false,
    },
  },
  {
    key: 'inductor',
    label: 'Inductor',
    prefix: 'L',
    device: { type: 'inductor', inductanceH: 1e-3, currentRatingA: null, initialCurrentA: null },
  },
  {
    key: 'vsource',
    label: 'DC source',
    prefix: 'V',
    device: {
      type: 'vsource',
      waveform: { kind: 'dc', value: 5 },
      seriesResistanceOhm: 0,
      currentLimitA: null,
      purpose: 'supply',
    },
  },
  {
    key: 'pulse',
    label: 'Pulse source',
    prefix: 'V',
    device: {
      type: 'vsource',
      waveform: {
        kind: 'pulse',
        v1: 0,
        v2: 5,
        delayS: 1e-3,
        riseS: 0,
        fallS: 0,
        widthS: 2e-3,
        periodS: 4e-3,
      },
      seriesResistanceOhm: 0,
      currentLimitA: null,
      purpose: 'signal',
    },
  },
  {
    key: 'isource',
    label: 'Current source',
    prefix: 'I',
    device: { type: 'isource', waveform: { kind: 'dc', value: 1e-3 } },
  },
  { key: 'ground', label: 'Ground', prefix: 'GND', device: { type: 'ground' } },
  { key: 'junction', label: 'Junction', prefix: 'J', device: { type: 'junction' } },
  {
    key: 'switch',
    label: 'Switch',
    prefix: 'SW',
    device: { type: 'switch', closed: false, onResistanceOhm: 0.01 },
  },
  {
    key: 'diode',
    label: 'Diode',
    prefix: 'D',
    device: {
      type: 'diode',
      model: { saturationCurrentA: 1e-14, emissionCoefficient: 1, seriesResistanceOhm: 0 },
      maxForwardCurrentA: null,
      maxReverseVoltageV: null,
      preset: 'generic-silicon',
    },
  },
  {
    key: 'npn',
    label: 'NPN transistor',
    prefix: 'Q',
    device: { type: 'npn', saturationCurrentA: 1e-14, betaF: 100, betaR: 1, maxCollectorCurrentA: null },
  },
  {
    key: 'nmos',
    label: 'N-MOSFET',
    prefix: 'M',
    device: { type: 'nmos', thresholdV: 2, transconductanceAPerV2: 1, lambdaPerV: 0, maxDrainCurrentA: null },
  },
  { key: 'vcvs', label: 'VCVS', prefix: 'E', device: { type: 'vcvs', gain: 10 } },
  {
    key: 'and',
    label: 'AND gate',
    prefix: 'X',
    device: { type: 'logic-gate', op: 'and', inputs: 2, delayNs: 10, logicV: 5 },
  },
  {
    key: 'not',
    label: 'NOT gate',
    prefix: 'X',
    device: { type: 'logic-gate', op: 'not', inputs: 1, delayNs: 10, logicV: 5 },
  },
  { key: 'dff', label: 'D flip-flop', prefix: 'FF', device: { type: 'dff', delayNs: 10, logicV: 5 } },
  {
    key: 'counter',
    label: 'Counter (4-bit)',
    prefix: 'CNT',
    device: { type: 'counter', bits: 4, delayNs: 10, logicV: 5 },
  },
  {
    key: 'clock',
    label: 'Clock',
    prefix: 'CLK',
    device: { type: 'clock', frequencyHz: 1000, duty: 0.5, logicV: 5 },
  },
];

/** Catalogue components with an electrical model, offered for placement in 3D + circuit. */
export const CATALOG_PARTS = [
  ['arduino-uno-r3', 'U'],
  ['hc-sr04', 'US'],
  ['towerpro-sg90', 'SV'],
  ['towerpro-mg996r', 'SV'],
  ['resistor-axial', 'R'],
  ['led-5mm', 'LED'],
  ['potentiometer', 'RV'],
  ['microswitch', 'S'],
  ['temp-sensor-to92', 'TS'],
  ['ceramic-capacitor', 'C'],
  ['electrolytic-capacitor', 'C'],
  ['diode-axial', 'D'],
  ['bjt-to92', 'Q'],
  ['mosfet-to220', 'M'],
  ['battery-pack', 'BT'],
  ['breadboard-power-module', 'PS'],
] as const;
const PREFIX = new Map<string, string>(CATALOG_PARTS);

export function nextLabel(def: ElectricalDefinition | null, prefix: string): string {
  const used = new Set(def?.parts.map((p) => p.label) ?? []);
  for (let k = 1; ; k++) if (!used.has(`${prefix}${k}`)) return `${prefix}${k}`;
}

function slot(def: ElectricalDefinition | null) {
  const n = def?.parts.length ?? 0;
  return { x: (n % 5) * 20, y: Math.floor(n / 5) * 18, rotation: 0 as const };
}

function withCircuit(editor: StoreApi<EditorState>, cmds: BatchSubCommand[]): BatchSubCommand[] {
  return circuitOf(editor.getState().project.scene)
    ? cmds
    : [{ type: 'electrical.circuit.create', payload: {} } as BatchSubCommand, ...cmds];
}

export function addPrimitive(editor: StoreApi<EditorState>, key: string): string | null {
  const p = PRIMITIVES.find((x) => x.key === key);
  if (!p) return null;
  const def = circuitOf(editor.getState().project.scene);
  const part: ElectricalPart = {
    id: newId(),
    label: nextLabel(def, p.prefix),
    name: p.label,
    device: structuredClone(p.device),
    definitionId: null,
    nodeId: null,
    schematic: slot(def),
    note: '',
  };
  const r = editor.getState().run(
    'scene.batch',
    {
      commands: withCircuit(editor, [{ type: 'electrical.part.add', payload: { part } } as BatchSubCommand]),
    },
    { label: `Add ${p.label} ${part.label}` },
  );
  return r.ok ? part.id : null;
}

/** Part for a placed component (its catalogue model's default device). */
export function partForNode(def: ElectricalDefinition | null, node: SceneNode): ElectricalPart | null {
  if (node.kind !== 'component-instance' || !node.component) return null;
  const m = electricalModelFor(node.definitionId, node.component.parameters, node.component.variantId);
  if (!m) return null;
  return {
    id: newId(),
    label: nextLabel(def, PREFIX.get(node.definitionId) ?? 'P'),
    name: node.name,
    device: m.device,
    definitionId: node.definitionId,
    nodeId: node.id,
    schematic: slot(def),
    note: '',
  };
}

/** Add an already-placed 3D component to the circuit (one undoable step). */
export function linkNode(editor: StoreApi<EditorState>, nodeId: string): string | null {
  const st = editor.getState();
  const node = st.project.scene.nodes[nodeId];
  if (!node) return null;
  const part = partForNode(circuitOf(st.project.scene), node);
  if (!part) return null;
  const r = st.run(
    'scene.batch',
    {
      commands: withCircuit(editor, [{ type: 'electrical.part.add', payload: { part } } as BatchSubCommand]),
    },
    { label: `Add ${node.name} to the circuit` },
  );
  return r.ok ? part.id : null;
}

/** Place a catalogue component in 3D AND add it to the circuit — one atomic, undoable batch. */
export function addCatalogPart(editor: StoreApi<EditorState>, definitionId: string): string | null {
  const st = editor.getState();
  const cdef = getDefinition(definitionId);
  const model = electricalModelFor(definitionId);
  if (!cdef || !model) return null;
  const def = circuitOf(st.project.scene);
  const nodeId = newId();
  const placed = def?.parts.filter((p) => p.nodeId).length ?? 0;
  const part: ElectricalPart = {
    id: newId(),
    label: nextLabel(def, PREFIX.get(definitionId) ?? 'P'),
    name: cdef.name,
    device: model.device,
    definitionId,
    nodeId,
    schematic: slot(def),
    note: '',
  };
  const r = st.run(
    'scene.batch',
    {
      commands: withCircuit(editor, [
        {
          type: 'scene.node.create',
          payload: {
            node: {
              kind: 'component-instance',
              id: nodeId,
              definitionId,
              name: `${part.label} ${cdef.name}`,
              transform: { position: [-0.2 + (placed % 4) * 0.12, 0, 0.35 + Math.floor(placed / 4) * 0.1] },
            },
          },
        } as BatchSubCommand,
        { type: 'electrical.part.add', payload: { part } } as BatchSubCommand,
      ]),
    },
    { label: `Place ${cdef.name} (${part.label})` },
  );
  if (!r.ok) {
    st.setStatus({ tone: 'error', text: r.error.message });
    return null;
  }
  return part.id;
}
