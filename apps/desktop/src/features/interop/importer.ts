import { makeCommand, type CommandInput, type Project } from '@forge/engineering-core';
import {
  analyseGeometry,
  detectFormat,
  importKicad,
  parseSpice,
  parseUrdf,
  planCircuitImport,
  planGeometryImport,
  planUrdfImport,
  type Detection,
  type Diagnostic,
  type FileInput,
  type GeometryAnalysis,
  type GeometryImportOptions,
  type ImportAsset,
  type KicadImport,
  type SpiceParse,
  type UrdfImportOptions,
} from '@forge/interop';
import type { StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';

/**
 * Import controller (UI-independent): file selection → detection → analysis (STEP in a
 * worker) → plan → engine dry run → user confirmation → assets stored (hash-verified) →
 * one atomic batch. A failed batch changes nothing; stored assets are content-addressed
 * and harmless if unused.
 */
export type Pending =
  | { kind: 'geometry'; file: FileInput; detection: Detection; analysis: GeometryAnalysis; ms: number }
  | {
      kind: 'urdf';
      file: FileInput;
      files: FileInput[];
      detection: Detection;
      links: number;
      joints: number;
      diagnostics: Diagnostic[];
      ms: number;
    }
  | { kind: 'spice'; file: FileInput; detection: Detection; result: SpiceParse; ms: number }
  | {
      kind: 'kicad';
      file: FileInput;
      detection: Detection;
      format: 'kicad-netlist' | 'kicad-pcb' | 'kicad-schematic';
      result: KicadImport;
      ms: number;
    }
  | { kind: 'unsupported'; file: FileInput; detection: Detection; message: string };

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: { analysis?: GeometryAnalysis; ms?: number; error?: string }) => void>();
function analyseStepInWorker(file: FileInput): Promise<{ analysis: GeometryAnalysis; ms: number }> {
  worker ??= new Worker(new URL('./stepWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (
    e: MessageEvent<{ id: number; analysis?: GeometryAnalysis; ms?: number; error?: string }>,
  ) => {
    waiting.get(e.data.id)?.(e.data);
    waiting.delete(e.data.id);
  };
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, (r) =>
      r.analysis
        ? resolve({ analysis: r.analysis, ms: r.ms ?? 0 })
        : reject(new Error(r.error ?? 'STEP worker failed')),
    );
    worker!.postMessage({ id, name: file.name, bytes: file.bytes });
  });
}

export async function readFiles(list: FileList | File[]): Promise<FileInput[]> {
  return Promise.all(
    [...list].map(async (f) => ({
      name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      bytes: new Uint8Array(await f.arrayBuffer()),
    })),
  );
}

export async function analyseFiles(files: FileInput[]): Promise<Pending> {
  const det = files.map((f) => ({ f, d: detectFormat(f) }));
  const urdf = det.find((x) => x.d.format === 'urdf');
  const main = urdf ?? det[0]!;
  const t0 = performance.now();
  const ms = () => performance.now() - t0;
  const f = main.f;
  switch (main.d.format) {
    case 'urdf': {
      const r = parseUrdf(f.bytes);
      return {
        kind: 'urdf',
        file: f,
        files: files.filter((x) => x !== f),
        detection: main.d,
        links: r.robot?.links.length ?? 0,
        joints: r.robot?.joints.length ?? 0,
        diagnostics: r.diagnostics,
        ms: ms(),
      };
    }
    case 'stl':
    case 'glb':
    case 'gltf':
      return {
        kind: 'geometry',
        file: f,
        detection: main.d,
        analysis: analyseGeometry(f, main.d.format),
        ms: ms(),
      };
    case 'step': {
      const r = await analyseStepInWorker(f);
      return { kind: 'geometry', file: f, detection: main.d, analysis: r.analysis, ms: r.ms };
    }
    case 'spice':
      return { kind: 'spice', file: f, detection: main.d, result: parseSpice(f.bytes), ms: ms() };
    case 'kicad-netlist':
    case 'kicad-pcb':
    case 'kicad-schematic':
      return {
        kind: 'kicad',
        file: f,
        detection: main.d,
        format: main.d.format,
        result: importKicad(f.bytes, main.d.format),
        ms: ms(),
      };
    default:
      return {
        kind: 'unsupported',
        file: f,
        detection: main.d,
        message: main.d.format
          ? `${main.d.format} files are opened elsewhere in FORGE (project/bundle import, Electronics panel).`
          : 'Not a recognised engineering file (STEP, STL, glTF/GLB, URDF, SPICE or KiCad).',
      };
  }
}

export interface Plan {
  ok: boolean;
  diagnostics: Diagnostic[];
  assets: ImportAsset[];
  commands: unknown[];
  nodeIds: string[];
  /** Result of the engine dry run (null when the plan itself failed). */
  dryRun: { ok: boolean; message: string } | null;
}
const newImportId = () => `import-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export function planFor(
  p: Pending,
  project: Project,
  o: {
    geometry?: Omit<GeometryImportOptions, 'importId' | 'newId'>;
    urdf?: Pick<UrdfImportOptions, 'createSimulation' | 'actuators' | 'name'>;
    circuit?: {
      replaceExisting: boolean;
      allowPartial: boolean;
      manual: Record<string, { as: 'omit' } | { as: 'resistor' | 'capacitor' | 'inductor'; value: number }>;
    };
  },
  newId: () => string,
): Plan {
  const importId = newImportId();
  if (p.kind === 'geometry' && o.geometry) {
    const r = planGeometryImport(p.analysis, { ...o.geometry, importId, newId }, project);
    return { ...r, commands: r.commands, dryRun: null };
  }
  if (p.kind === 'urdf' && o.urdf) {
    const r = planUrdfImport(
      p.file,
      { files: p.files, ...o.urdf, importId, idPrefix: `urdf-${importId.slice(7, 13)}` },
      project,
    );
    return {
      ok: r.ok,
      diagnostics: r.diagnostics,
      assets: r.assets,
      commands: r.commands,
      nodeIds: r.nodeIds,
      dryRun: null,
    };
  }
  if ((p.kind === 'spice' || p.kind === 'kicad') && o.circuit) {
    const res =
      p.kind === 'spice'
        ? o.circuit.allowPartial
          ? parseSpice(p.file.bytes, { allowPartial: true })
          : p.result
        : importKicad(p.file.bytes, p.format, o.circuit.manual);
    const r = planCircuitImport(
      {
        file: p.file,
        format: p.kind === 'spice' ? 'spice' : p.format === 'kicad-pcb' ? 'kicad-pcb' : 'kicad-netlist',
        formatVersion: p.kind === 'kicad' ? ((res as KicadImport).doc?.version ?? null) : null,
        definition: res.definition,
        diagnostics: res.diagnostics,
        unsupported:
          p.kind === 'spice'
            ? (res as SpiceParse).unsupported
            : ((res as KicadImport).doc?.unsupported ?? []),
        mappings: p.kind === 'kicad' ? (res as KicadImport).mappings : undefined,
        connectivity: res.connectivity,
      },
      { replaceExisting: o.circuit.replaceExisting, importId },
      project,
    );
    return {
      ok: r.ok,
      diagnostics: r.diagnostics,
      assets: [],
      commands: r.commands,
      nodeIds: [],
      dryRun: null,
    };
  }
  return { ok: false, diagnostics: [], assets: [], commands: [], nodeIds: [], dryRun: null };
}

/** Compatibility check: run the batch as a dry run (nothing is committed). */
export function dryRun(store: StoreApi<EditorState>, plan: Plan): Plan {
  if (!plan.ok || !plan.commands.length) return plan;
  const r = store
    .getState()
    .engine.preview(
      makeCommand('scene.batch', { commands: plan.commands } as never, 'desktop-ui') as CommandInput,
    );
  return {
    ...plan,
    dryRun: r.result.ok
      ? { ok: true, message: 'The engine accepts the import.' }
      : { ok: false, message: r.result.error.message },
  };
}

/** Store derived assets, then apply the batch as ONE undoable step. */
export async function applyPlan(
  store: StoreApi<EditorState>,
  plan: Plan,
  label: string,
): Promise<{ ok: boolean; message: string }> {
  const s = store.getState();
  for (const a of plan.assets)
    await s.assetStore.put({ hash: a.hash, mediaType: a.mediaType, name: label, bytes: a.bytes });
  const r = s.run('scene.batch', { commands: plan.commands } as never, { label });
  if (!r.ok) return { ok: false, message: r.error.message };
  if (plan.nodeIds[0]) s.select(plan.nodeIds[0]);
  return {
    ok: true,
    message: `${label}: ${plan.nodeIds.length ? `${plan.nodeIds.length} node(s)` : 'circuit'} inserted (one undo step).`,
  };
}
