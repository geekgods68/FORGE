import {
  sha256Bytes,
  type BatchSubCommand,
  type ElectricalDefinition,
  type ImportRecord,
  type Project,
} from '@forge/engineering-core';
import { exportElectricalBundle, exportSpiceNetlist } from '@forge/electronics';
import type { ComponentMapping } from './formats/kicad';
import { err, hasErrors, INTEROP_VERSION, warn, type Diagnostic, type FileInput } from './schemas';

/**
 * Circuit import plan (SPICE, KiCad netlist/PCB): one atomic batch that sets the project
 * circuit (`electrical.circuit.import`) and records provenance. An existing circuit is
 * REPLACED only with explicit confirmation; the CAD design is never touched.
 */
export interface CircuitImportInput {
  file: FileInput;
  format: 'spice' | 'kicad-netlist' | 'kicad-pcb';
  formatVersion: string | null;
  definition: ElectricalDefinition | null;
  diagnostics: Diagnostic[];
  unsupported: string[];
  mappings?: ComponentMapping[];
  connectivity: { ok: boolean; nets: number; terminals: number } | null;
}
export interface CircuitPlan {
  ok: boolean;
  diagnostics: Diagnostic[];
  commands: BatchSubCommand[];
  record: ImportRecord | null;
}

export function planCircuitImport(
  i: CircuitImportInput,
  o: { replaceExisting: boolean; importId: string; now?: Date },
  project: Project,
): CircuitPlan {
  const d = [...i.diagnostics];
  const fail = (e: Diagnostic): CircuitPlan => ({
    ok: false,
    diagnostics: [...d, e],
    commands: [],
    record: null,
  });
  if (!i.definition || hasErrors(d))
    return fail(err('not-importable', 'The circuit did not convert; nothing can be inserted.'));
  if (!i.connectivity?.ok)
    return fail(err('connectivity', 'Connectivity could not be verified against the source.'));
  const root = project.scene.nodes[project.scene.rootId];
  const existing = root?.kind === 'root' ? root.electrical : undefined;
  if (existing && !o.replaceExisting)
    return fail(
      err(
        'circuit-exists',
        `The project already has a circuit ("${existing.name}", ${existing.parts.length} parts); confirm replacing it.`,
      ),
    );
  if (existing)
    d.push(warn('circuit-replaced', `Replaces the existing circuit "${existing.name}" (undo restores it).`));
  const counts: Record<string, number> = {};
  for (const p of i.definition.parts)
    counts[`parts.${p.device.type}`] = (counts[`parts.${p.device.type}`] ?? 0) + 1;
  const record: ImportRecord = {
    id: o.importId,
    format: i.format,
    formatVersion: i.formatVersion,
    fileName: i.file.name.slice(0, 260),
    byteLength: i.file.bytes.byteLength,
    sourceHash: `sha256-${sha256Bytes(i.file.bytes)}`,
    referencedFiles: [],
    importedAt: (o.now ?? new Date()).toISOString(),
    importer: INTEROP_VERSION,
    sourceUnit: 'SI',
    toMetres: 1,
    upAxis: 'Y',
    handedness: 'right',
    geometryClass: 'none',
    nodeIds: [],
    assetHashes: [],
    summary: {
      parts: i.definition.parts.length,
      nets: i.connectivity.nets,
      terminals: i.connectivity.terminals,
      'connectivity.verified': 'yes',
      ...counts,
      ...(i.mappings
        ? {
            'kicad.mapped': i.mappings.filter((m) => m.status === 'mapped').length,
            'kicad.manual': i.mappings.filter((m) => m.status === 'manual').length,
            'kicad.omitted': i.mappings.filter((m) => m.status === 'omitted').length,
            'kicad.unmapped': i.mappings.filter((m) => m.status === 'unmapped').length,
          }
        : {}),
    },
    conversions: [
      `${i.format} → FORGE electrical definition (parts with net labels)`,
      'Connectivity re-derived by the FORGE netlist compiler and compared with the source: identical',
      ...(i.mappings ?? [])
        .filter((m) => m.status !== 'unmapped')
        .map((m) => `${m.ref}: ${m.reason}`.slice(0, 500)),
    ].slice(0, 100),
    unsupported: [
      ...i.unsupported,
      ...(i.mappings ?? []).filter((m) => m.status === 'unmapped').map((m) => `${m.ref}: ${m.reason}`),
    ]
      .slice(0, 500)
      .map((x) => x.slice(0, 500)),
    warnings: d
      .filter((x) => x.severity === 'warning')
      .map((x) => x.message.slice(0, 1000))
      .slice(0, 500),
    nodesFingerprint: `sha256-${'0'.repeat(64)}`, // computed by the record command
  };
  return {
    ok: true,
    diagnostics: d,
    commands: [
      { type: 'electrical.circuit.import', payload: { definition: i.definition } } as BatchSubCommand,
      { type: 'interop.import.record', payload: { record } } as BatchSubCommand,
    ],
    record,
  };
}

/** Electrical exports (never modify the project). */
export function exportCircuit(
  def: ElectricalDefinition,
  format: 'spice' | 'forge-electrical',
  projectName?: string,
) {
  return format === 'spice'
    ? {
        text: exportSpiceNetlist(def),
        fileName: `${def.name.replace(/[^\w.-]+/g, '_') || 'circuit'}.cir`,
        mediaType: 'text/plain',
      }
    : {
        text: exportElectricalBundle(def, { project: projectName }),
        fileName: `${def.name.replace(/[^\w.-]+/g, '_') || 'circuit'}.forge-electrical.json`,
        mediaType: 'application/json',
      };
}
