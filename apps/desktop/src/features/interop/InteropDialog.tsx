import {
  CAPABILITIES,
  capabilityOf,
  exportCircuit,
  exportMeshScene,
  importStatus,
  previewGeometry,
  type Diagnostic,
  type ExportUnit,
  type Frame,
} from '@forge/interop';
import type { ModelRef } from '@forge/engineering-core';
import { Download, FileUp, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { downloadText } from '@/lib/download';
import { exportSceneFor } from './exportGeometry';
import { analyseFiles, applyPlan, dryRun, planFor, readFiles, type Pending } from './importer';
import { importStamp, interopUi, lastImport } from './state';

/** Import / export dialog (main area). */

const UNITS: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };
const inputCls = 'rounded border border-border bg-background px-1 py-0.5 text-xs';
const mm = (x: number) => `${(x * 1000).toFixed(x * 1000 >= 100 ? 1 : 3)} mm`;

function Diags({ list, testId }: { list: readonly Diagnostic[]; testId?: string }) {
  if (!list.length) return null;
  return (
    <ul className="space-y-0.5 text-[11px]" data-testid={testId}>
      {list.map((d, i) => (
        <li
          key={i}
          className={
            d.severity === 'error'
              ? 'text-destructive'
              : d.severity === 'warning'
                ? 'text-amber-300'
                : 'text-muted-foreground'
          }
        >
          {d.severity === 'error' ? '✗' : d.severity === 'warning' ? '!' : 'i'} {d.message}
        </li>
      ))}
    </ul>
  );
}

export function InteropDialog() {
  const ui = useStore(interopUi);
  if (!ui.open) return null;
  return (
    <div
      className="absolute inset-0 z-30 overflow-auto bg-background/95 p-4 text-sm"
      data-testid="interop-dialog"
    >
      <div className="mx-auto max-w-3xl space-y-3">
        <header className="flex items-center gap-2">
          <h2 className="flex-1 text-base font-semibold">Engineering data exchange</h2>
          {(['import', 'export', 'imports'] as const).map((t) => (
            <button
              key={t}
              data-testid={`interop-tab-${t}`}
              className={`rounded px-2 py-0.5 text-xs ${ui.tab === t ? 'bg-secondary font-medium' : 'text-muted-foreground'}`}
              onClick={() => interopUi.setState({ tab: t })}
            >
              {t === 'import' ? 'Import' : t === 'export' ? 'Export' : 'Project imports'}
            </button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => interopUi.setState({ open: false })}
            aria-label="Close"
            data-testid="interop-close"
          >
            <X />
          </Button>
        </header>
        {ui.tab === 'import' && <ImportTab />}
        {ui.tab === 'export' && <ExportTab />}
        {ui.tab === 'imports' && <ImportsTab />}
      </div>
    </div>
  );
}

function ImportTab() {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame & { unitName: string }>({
    toMetres: 0.001,
    upAxis: 'Z',
    handedness: 'right',
    unitName: 'mm',
  });
  const [name, setName] = useState('');
  const [split, setSplit] = useState(false);
  const [mass, setMass] = useState('');
  const [collider, setCollider] = useState<'bounds-box' | 'none'>('bounds-box');
  const [actuators, setActuators] = useState<'none' | 'hold-initial'>('hold-initial');
  const [replace, setReplace] = useState(false);
  const [partial, setPartial] = useState(false);
  const [stamp, setStamp] = useState('');
  const selection = useEditor((s) => s.selection);
  const sel = selection.length === 1 ? project.scene.nodes[selection[0]!] : undefined;
  const selParent = sel?.parentId ? project.scene.nodes[sel.parentId] : undefined;
  const attachTarget = useMemo(
    () =>
      sel && selParent?.kind === 'assembly'
        ? { assemblyId: selParent.id, bodyId: sel.id, name: sel.name }
        : null,
    [sel, selParent],
  );
  const [attach, setAttach] = useState(false);
  const [offset, setOffset] = useState('0, 20, 0');
  const [manual, setManual] = useState<
    Record<string, { as: 'omit' } | { as: 'resistor' | 'capacitor' | 'inductor'; value: number }>
  >({});
  const preview = useMemo(
    () =>
      pending?.kind === 'geometry' && pending.analysis.scene
        ? previewGeometry(pending.analysis, frame)
        : null,
    [pending, frame],
  );
  const plan = useMemo(() => {
    if (!pending || pending.kind === 'unsupported') return null;
    let n = 0;
    const p = planFor(
      pending,
      project,
      {
        geometry: {
          frame,
          name: name || pending.file.name.replace(/\.[^.]+$/, ''),
          categoryId: 'complete-modules-assemblies' as ModelRef['categoryId'],
          split,
          physics: mass ? { massKg: Number(mass), note: 'entered at import', collider } : null,
          attach:
            attach && attachTarget
              ? {
                  assemblyId: attachTarget.assemblyId,
                  bodyId: attachTarget.bodyId,
                  offsetM: offset
                    .split(/[ ,]+/)
                    .map((x) => Number(x) / 1000)
                    .slice(0, 3) as [number, number, number],
                }
              : null,
        },
        urdf: { createSimulation: true, actuators, name: name || undefined },
        circuit: { replaceExisting: replace, allowPartial: partial, manual },
      },
      () => `imp-${stamp}-${++n}`,
    );
    return dryRun(store, p);
  }, [
    pending,
    project,
    frame,
    name,
    split,
    mass,
    collider,
    actuators,
    replace,
    partial,
    manual,
    store,
    stamp,
    attach,
    attachTarget,
    offset,
  ]);
  useEffect(() => {
    lastImport.pending = pending;
    lastImport.plan = plan;
  }, [pending, plan]);
  const choose = async (list: FileList | null) => {
    if (!list?.length) return;
    setMsg(null);
    setBusy(`Reading ${list.length} file(s)…`);
    try {
      const p = await analyseFiles(await readFiles(list));
      setStamp(importStamp());
      setPending(p);
      if (p.kind === 'geometry') setFrame({ ...p.analysis.defaultFrame });
      setName('');
      setManual({});
    } catch (e) {
      setMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const confirm = async () => {
    if (!plan?.ok || !plan.dryRun?.ok || !pending) return;
    setBusy('Inserting…');
    const r = await applyPlan(store, plan, `Import ${pending.file.name}`);
    setBusy(null);
    setMsg(r.message);
    lastImport.message = r.message;
    if (r.ok) setPending(null);
  };
  const cap = pending && pending.kind !== 'unsupported' ? capabilityOf(pending.detection.format!) : null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => file.current?.click()} data-testid="interop-choose">
          <FileUp /> Choose file(s)…
        </Button>
        <input
          ref={file}
          type="file"
          multiple
          className="hidden"
          data-testid="interop-file"
          accept=".step,.stp,.stl,.glb,.gltf,.urdf,.xml,.cir,.sp,.spice,.ckt,.net,.kicad_pcb,.kicad_sch"
          onChange={(e) => void choose(e.target.files)}
        />
        <span className="text-[11px] text-muted-foreground">
          STEP, STL, glTF/GLB, URDF (+ its meshes), SPICE, KiCad netlist/PCB. Files are read locally; nothing
          is uploaded or fetched.
        </span>
      </div>
      {busy && <p className="text-xs text-muted-foreground">{busy}</p>}
      {pending && (
        <section className="space-y-2 rounded border border-border p-2">
          <p className="text-xs" data-testid="interop-format">
            <strong>{pending.file.name}</strong> — detected{' '}
            <strong>{pending.detection.format ?? 'unknown'}</strong> ({pending.detection.reason})
            {pending.detection.mismatch ? (
              <span className="text-amber-300"> · {pending.detection.mismatch}</span>
            ) : null}
            {'ms' in pending ? ` · analysed in ${pending.ms.toFixed(0)} ms` : ''}
          </p>
          {cap && (
            <p className="text-[11px] text-muted-foreground">
              Support: import {cap.import}, export {cap.export}. {cap.notes}
            </p>
          )}
          {pending.kind === 'unsupported' && <p className="text-xs text-destructive">{pending.message}</p>}
          {pending.kind === 'geometry' && (
            <>
              <p className="text-xs" data-testid="interop-class">
                Geometry:{' '}
                <strong>
                  {pending.analysis.geometryClass === 'tessellated-brep'
                    ? 'tessellated B-rep (OCCT)'
                    : 'triangle mesh'}
                </strong>{' '}
                — no parametric features or editable B-rep are recovered. Format version{' '}
                {pending.analysis.formatVersion ?? '—'}, generator {pending.analysis.generator ?? '—'}.
              </p>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <label>
                  Unit{' '}
                  <select
                    className={inputCls}
                    data-testid="interop-unit"
                    disabled={pending.analysis.format === 'step'}
                    value={frame.unitName in UNITS ? frame.unitName : 'm'}
                    onChange={(e) =>
                      setFrame({ ...frame, unitName: e.target.value, toMetres: UNITS[e.target.value]! })
                    }
                  >
                    {Object.keys(UNITS).map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                  {pending.analysis.format === 'step'
                    ? ` (from the file: ${pending.analysis.defaultFrame.unitName})`
                    : pending.analysis.defaultFrame.unitStated
                      ? ' (stated by the format)'
                      : ' (not in the file — confirm)'}
                </label>
                <label>
                  Up axis{' '}
                  <select
                    className={inputCls}
                    data-testid="interop-up"
                    value={frame.upAxis}
                    onChange={(e) => setFrame({ ...frame, upAxis: e.target.value as 'Y' | 'Z' })}
                  >
                    <option value="Z">+Z up</option>
                    <option value="Y">+Y up</option>
                  </select>
                </label>
                {pending.analysis.format === 'stl' && (
                  <label>
                    Handedness{' '}
                    <select
                      className={inputCls}
                      data-testid="interop-hand"
                      value={frame.handedness}
                      onChange={(e) => setFrame({ ...frame, handedness: e.target.value as 'right' | 'left' })}
                    >
                      <option value="right">right-handed</option>
                      <option value="left">left-handed (mirror)</option>
                    </select>
                  </label>
                )}
                <label>
                  Name{' '}
                  <input
                    className={inputCls}
                    value={name}
                    placeholder={pending.file.name}
                    onChange={(e) => setName(e.target.value)}
                    data-testid="interop-name"
                  />
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={split}
                    onChange={(e) => setSplit(e.target.checked)}
                    data-testid="interop-split"
                  />{' '}
                  one instance per part
                </label>
                {attachTarget && (
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={attach}
                      onChange={(e) => setAttach(e.target.checked)}
                      data-testid="interop-attach"
                    />{' '}
                    attach to “{attachTarget.name}” (fixed mate) at offset
                    <input
                      className={`${inputCls} w-24`}
                      value={offset}
                      onChange={(e) => setOffset(e.target.value)}
                      data-testid="interop-attach-offset"
                      aria-label="Attachment offset (mm)"
                    />{' '}
                    mm
                  </label>
                )}
              </div>
              {preview && (
                <div className="space-y-1 text-[11px]" data-testid="interop-preview">
                  <p data-testid="interop-size">
                    Size (FORGE frame, +Y up): {preview.metrics.bounds!.size.map(mm).join(' × ')} ·{' '}
                    {preview.metrics.triangles.toLocaleString()} triangles · {preview.metrics.components}{' '}
                    body/bodies ·{' '}
                    {preview.metrics.closed
                      ? `closed, volume ${(Math.abs(preview.metrics.volume) * 1e6).toFixed(3)} cm³`
                      : 'open mesh (volume not meaningful)'}{' '}
                    · area {(preview.metrics.surfaceAreaM2 * 1e4).toFixed(2)} cm²
                  </p>
                  {preview.parts.length > 1 && (
                    <p>
                      Parts:{' '}
                      {preview.parts.map((p) => `${p.name} (${p.boundsM.map(mm).join(' × ')})`).join('; ')}
                    </p>
                  )}
                  <details>
                    <summary className="cursor-pointer">
                      Hierarchy ({preview.summary.nodes} nodes, depth {preview.summary.depth})
                    </summary>
                    <pre
                      className="whitespace-pre-wrap font-mono text-[10px]"
                      data-testid="interop-hierarchy"
                    >
                      {preview.hierarchy.join('\n')}
                    </pre>
                  </details>
                  <Diags list={preview.warnings} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                Physical properties (never inferred):
                <input
                  className={`${inputCls} w-24`}
                  placeholder="mass (kg)"
                  value={mass}
                  onChange={(e) => setMass(e.target.value)}
                  data-testid="interop-mass"
                />
                <select
                  className={inputCls}
                  value={collider}
                  onChange={(e) => setCollider(e.target.value as 'bounds-box' | 'none')}
                  data-testid="interop-collider"
                >
                  <option value="bounds-box">bounding-box collider (approximate)</option>
                  <option value="none">no collider</option>
                </select>
                <span className="text-muted-foreground">
                  Leave the mass empty to set it later in Simulation mode.
                </span>
              </div>
              {pending.analysis.unsupported.length > 0 && (
                <p className="text-[11px] text-muted-foreground" data-testid="interop-unsupported">
                  Not imported: {pending.analysis.unsupported.join('; ')}.
                </p>
              )}
              <Diags list={pending.analysis.diagnostics} testId="interop-warnings" />
            </>
          )}
          {pending.kind === 'urdf' && (
            <>
              <p className="text-xs" data-testid="interop-class">
                Robot: {pending.links} links, {pending.joints} joints; {pending.files.length} other file(s)
                selected for meshes. Becomes an assembly (links → bodies, joints → mates).
              </p>
              <label className="text-[11px]">
                Actuators{' '}
                <select
                  className={inputCls}
                  value={actuators}
                  onChange={(e) => setActuators(e.target.value as 'none' | 'hold-initial')}
                  data-testid="interop-actuators"
                >
                  <option value="hold-initial">
                    generic position actuators holding the initial pose (assumption)
                  </option>
                  <option value="none">none (passive joints)</option>
                </select>
              </label>
              <Diags list={pending.diagnostics} testId="interop-warnings" />
            </>
          )}
          {(pending.kind === 'spice' || pending.kind === 'kicad') && (
            <>
              <p className="text-xs" data-testid="interop-class">
                Circuit: {pending.result.definition?.parts.length ?? 0} parts ·{' '}
                {pending.result.connectivity?.ok
                  ? `connectivity verified (${pending.result.connectivity.nets} nets, ${pending.result.connectivity.terminals} terminals identical to the source)`
                  : 'connectivity NOT verified'}
              </p>
              {pending.kind === 'kicad' && (
                <table className="w-full text-[11px]" data-testid="interop-mapping">
                  <tbody>
                    {pending.result.mappings.map((m) => (
                      <tr key={m.ref} data-testid={`interop-map-${m.ref}`}>
                        <td className="font-mono">{m.ref}</td>
                        <td className={m.status === 'unmapped' ? 'text-amber-300' : ''}>{m.status}</td>
                        <td>{m.reason}</td>
                        <td>
                          {m.status !== 'mapped' && (
                            <select
                              className={inputCls}
                              data-testid={`interop-map-${m.ref}-as`}
                              value={manual[m.ref]?.as ?? ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                const next = { ...manual };
                                if (!v) delete next[m.ref];
                                else if (v === 'omit') next[m.ref] = { as: 'omit' };
                                else
                                  next[m.ref] = {
                                    as: v as 'resistor',
                                    value:
                                      Number(prompt(`${m.ref}: value in SI units (Ω, F or H)`) ?? '0') || 1,
                                  };
                                setManual(next);
                              }}
                            >
                              <option value="">leave unmapped</option>
                              <option value="omit">omit</option>
                              <option value="resistor">resistor…</option>
                              <option value="capacitor">capacitor…</option>
                              <option value="inductor">inductor…</option>
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {pending.kind === 'spice' && pending.result.unsupported.length > 0 && (
                <p className="text-[11px] text-muted-foreground" data-testid="interop-unsupported">
                  Not imported: {pending.result.unsupported.join('; ')}.
                </p>
              )}
              <div className="flex flex-wrap gap-3 text-[11px]">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                    data-testid="interop-replace"
                  />{' '}
                  replace the project circuit
                </label>
                {pending.kind === 'spice' && (
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={partial}
                      onChange={(e) => setPartial(e.target.checked)}
                      data-testid="interop-partial"
                    />{' '}
                    accept a partial import (unsupported elements omitted and recorded)
                  </label>
                )}
              </div>
              <Diags list={pending.result.diagnostics} testId="interop-warnings" />
            </>
          )}
          {plan && (
            <div className="space-y-1">
              <Diags list={plan.diagnostics.filter((d) => d.severity === 'error')} />
              <p
                className={`text-[11px] ${plan.dryRun?.ok ? 'text-sky-300' : 'text-destructive'}`}
                data-testid="interop-dryrun"
              >
                {plan.ok
                  ? plan.dryRun?.ok
                    ? `Ready: ${plan.commands.length} validated command(s), one undo step${plan.assets.length ? `, ${plan.assets.length} derived asset(s)` : ''}.`
                    : `The engine refuses this import: ${plan.dryRun?.message ?? ''}`
                  : 'Not importable (see above).'}
              </p>
              <Button
                size="sm"
                disabled={!plan.ok || !plan.dryRun?.ok || !!busy}
                onClick={() => void confirm()}
                data-testid="interop-confirm"
              >
                Insert into project
              </Button>
            </div>
          )}
        </section>
      )}
      {msg && (
        <p className="text-xs" data-testid="interop-message">
          {msg}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-[11px]">Format capability matrix</summary>
        <table className="w-full text-[10px]" data-testid="interop-capabilities">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th>Format</th>
              <th>Import</th>
              <th>Export</th>
              <th>Geometry</th>
              <th>Simulation</th>
              <th>Round trip</th>
            </tr>
          </thead>
          <tbody>
            {CAPABILITIES.map((c) => (
              <tr key={c.format} className="border-t border-border/40">
                <td>{c.label}</td>
                <td>{c.import}</td>
                <td>{c.export}</td>
                <td>{c.geometry}</td>
                <td>{c.simulation}</td>
                <td>{c.roundTrip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function ExportTab() {
  const store = useEditorStore();
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const [fmt, setFmt] = useState<'stl' | 'stl-ascii' | 'glb' | 'spice' | 'forge-electrical'>('stl');
  const [unit, setUnit] = useState<ExportUnit>('mm');
  const [up, setUp] = useState<'Y' | 'Z'>('Z');
  const [report, setReport] = useState<string | null>(null);
  const root = project.scene.nodes[project.scene.rootId];
  const circuit = root?.kind === 'root' ? root.electrical : undefined;
  const run = async () => {
    if (fmt === 'spice' || fmt === 'forge-electrical') {
      if (!circuit) return setReport('This project has no circuit.');
      const r = exportCircuit(circuit, fmt, project.name);
      downloadText(r.fileName, r.text);
      return setReport(
        `Exported ${r.fileName} (${r.text.length} bytes)${fmt === 'spice' ? '. SPICE subset: devices without a SPICE equivalent are listed as comments; not verified against a SPICE simulator.' : '.'}`,
      );
    }
    const ids = selection.length ? [...selection] : project.scene.nodes[project.scene.rootId]!.childIds;
    const s = await exportSceneFor(project, ids, store.getState().assetStore);
    if (!s.nodes) return setReport(`Nothing to export. ${s.skipped.join('; ')}`);
    const r = exportMeshScene(s.scene, {
      format: fmt,
      unit,
      upAxis: up,
      name: selection.length ? (project.scene.nodes[selection[0]!]?.name ?? project.name) : project.name,
    });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: r.mediaType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    const b = r.report.bounds;
    setReport(
      `Exported ${r.fileName}: ${r.report.triangles.toLocaleString()} triangles from ${s.nodes} node(s); size ${b ? b.size.map((x) => x.toFixed(3)).join(' × ') : '—'} ${r.report.unit}, +${r.report.upAxis} up. Preserved: ${r.report.preserved.join(', ')}. Discarded: ${r.report.discarded.join(', ')}.${s.skipped.length ? ` Skipped: ${s.skipped.join('; ')}.` : ''}`,
    );
  };
  return (
    <div className="space-y-2 text-xs">
      <p className="text-[11px] text-muted-foreground">
        Exports never modify the project. Geometry exports are tessellated meshes of{' '}
        {selection.length ? 'the selection' : 'the whole project'} — not CAD models; STEP export is not
        offered (FORGE has no B-rep writer).
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          className={inputCls}
          value={fmt}
          onChange={(e) => setFmt(e.target.value as typeof fmt)}
          data-testid="interop-export-format"
        >
          <option value="stl">STL (binary)</option>
          <option value="stl-ascii">STL (ASCII)</option>
          <option value="glb">GLB (glTF binary, m, +Y up)</option>
          <option value="spice">SPICE netlist (circuit)</option>
          <option value="forge-electrical">FORGE electrical bundle (circuit)</option>
        </select>
        {(fmt === 'stl' || fmt === 'stl-ascii') && (
          <>
            <select
              className={inputCls}
              value={unit}
              onChange={(e) => setUnit(e.target.value as ExportUnit)}
              data-testid="interop-export-unit"
            >
              <option value="mm">mm</option>
              <option value="m">m</option>
              <option value="cm">cm</option>
              <option value="in">in</option>
            </select>
            <select
              className={inputCls}
              value={up}
              onChange={(e) => setUp(e.target.value as 'Y' | 'Z')}
              data-testid="interop-export-up"
            >
              <option value="Z">+Z up</option>
              <option value="Y">+Y up</option>
            </select>
          </>
        )}
        <Button size="sm" variant="outline" onClick={() => void run()} data-testid="interop-export">
          <Download /> Export
        </Button>
      </div>
      {report && (
        <p className="text-[11px]" data-testid="interop-export-report">
          {report}
        </p>
      )}
    </div>
  );
}

function ImportsTab() {
  const project = useEditor((s) => s.project);
  const root = project.scene.nodes[project.scene.rootId];
  const list = root?.kind === 'root' ? (root.imports ?? []) : [];
  if (!list.length)
    return (
      <p className="text-xs text-muted-foreground">
        No external imports in this project (all content is native FORGE data).
      </p>
    );
  return (
    <ul className="space-y-2 text-[11px]" data-testid="interop-imports">
      {list.map((r) => (
        <li key={r.id} className="rounded border border-border p-2">
          <p>
            <strong>{r.fileName}</strong> ({r.format}
            {r.formatVersion ? ` ${r.formatVersion}` : ''}) · {r.importedAt} · status{' '}
            <strong data-testid="interop-import-status">{importStatus(r, project.scene)}</strong>
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">{r.sourceHash}</p>
          <p>Conversions: {r.conversions.join(' → ')}</p>
          {r.unsupported.length > 0 && (
            <p className="text-muted-foreground">Not imported: {r.unsupported.join('; ')}</p>
          )}
          {r.warnings.length > 0 && <p className="text-amber-300">{r.warnings.join(' ')}</p>}
        </li>
      ))}
    </ul>
  );
}
