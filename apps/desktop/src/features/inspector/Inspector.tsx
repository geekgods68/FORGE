import { GroupInspector } from './GroupInspector';
import { ComponentInspector } from './ComponentInspector';
import { AssemblyInspector } from './AssemblyInspector';
import { ModelInterfacesEditor } from './ModelInterfacesEditor';
import { ProvenanceSection } from '@/features/interop/ProvenanceSection';
import { PartInspector, SketchInspector } from './CadInspector';
import {
  degToRad,
  descendantsOf,
  eulerXYZFromQuat,
  isEffectivelyLocked,
  isMateDriven,
  quatFromEulerXYZ,
  radToDeg,
  type PrimitiveGeometry,
  type SceneNode,
  type Vec3,
} from '@forge/engineering-core';
import { getEquipment, getZone, mountChain, pointToFacility } from '@forge/facility';
import { Copy, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/NumberField';
import { formatNumber } from '@/lib/format';
import { useEditor } from '@/app/store';

const AXES = ['X', 'Y', 'Z'] as const;

/**
 * Inspector: precise, unit-explicit editing of the selected node.
 * Position in millimetres (stored as metres), rotation in degrees (stored as a unit
 * quaternion), scale as a ratio. Each committed field is one validated command.
 */
export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const scene = useEditor((s) => s.project.scene);
  const engine = useEditor((s) => s.engine);
  const run = useEditor((s) => s.run);
  const select = useEditor((s) => s.select);
  const id = selection[0];
  const node = id ? scene.nodes[id] : undefined;

  if (!node) {
    return (
      <section aria-label="Inspector" className="p-4 text-sm text-muted-foreground">
        <Heading />
        <p className="mt-3">Select an object in the viewport or hierarchy.</p>
      </section>
    );
  }

  const locked = isEffectivelyLocked(scene, node.id);
  const driven = isMateDriven(scene, node.id);
  const fixedPose = locked || driven;
  const isRoot = node.kind === 'root';
  const t = node.transform;
  const euler = eulerXYZFromQuat(t.rotation); // full precision, radians
  const world = engine.getWorldTransform(node.id);

  const setPosition = (axis: number, mm: number) => {
    const position = [...t.position] as Vec3;
    position[axis] = mm / 1000;
    run('scene.node.transform', { nodeId: node.id, position }, { label: `Set position ${AXES[axis]}` });
  };
  const setRotation = (axis: number, deg: number) => {
    const e = [...euler] as Vec3;
    e[axis] = degToRad(deg);
    run(
      'scene.node.transform',
      { nodeId: node.id, rotation: quatFromEulerXYZ(e) },
      { label: `Set rotation ${AXES[axis]}` },
    );
  };
  const setScale = (axis: number, v: number) => {
    const scale = [...t.scale] as Vec3;
    scale[axis] = v;
    run('scene.node.transform', { nodeId: node.id, scale }, { label: `Set scale ${AXES[axis]}` });
  };

  return (
    <section aria-label="Inspector" className="space-y-4 overflow-auto p-3 text-sm">
      <Heading />
      <div className="space-y-1">
        <NameField
          key={node.id + node.name}
          node={node}
          disabled={locked || isRoot}
          onRename={(name) => run('scene.node.rename', { nodeId: node.id, name }, { label: 'Rename' })}
        />
        <p className="text-xs text-muted-foreground">
          {node.kind}
          {node.kind === 'primitive' ? ` · ${node.geometry.shape}` : ''} ·{' '}
          <span className="font-mono" title={node.id}>
            {node.id.slice(0, 8)}
          </span>
          {locked ? ' · locked' : ''}
        </p>
      </div>

      {!isRoot && (
        <>
          {driven && (
            <p className="text-xs text-sky-300" data-testid="mate-driven-note">
              Placed by assembly mates — move it through its joints in the parent assembly.
            </p>
          )}
          <Fieldset title="Position (mm)">
            {AXES.map((a, i) => (
              <NumberField
                key={a}
                label={a}
                unit="mm"
                testId={`position-${a.toLowerCase()}`}
                value={t.position[i]! * 1000}
                decimals={3}
                disabled={fixedPose}
                onCommit={(v) => setPosition(i, v)}
              />
            ))}
          </Fieldset>
          <Fieldset title="Rotation (deg, XYZ)">
            {AXES.map((a, i) => (
              <NumberField
                key={a}
                label={a}
                unit="deg"
                testId={`rotation-${a.toLowerCase()}`}
                value={radToDeg(euler[i]!)}
                decimals={3}
                disabled={fixedPose}
                onCommit={(v) => setRotation(i, v)}
              />
            ))}
          </Fieldset>
          {node.kind === 'component-instance' && node.component ? (
            <p className="text-xs text-muted-foreground" data-testid="scale-locked-note">
              Scale is fixed at 1: catalogue parts are resized through their parameters below.
            </p>
          ) : (
            <Fieldset title="Scale (ratio)">
              {AXES.map((a, i) => (
                <NumberField
                  key={a}
                  label={a}
                  testId={`scale-${a.toLowerCase()}`}
                  value={t.scale[i]!}
                  decimals={4}
                  disabled={locked}
                  min={1e-6}
                  onCommit={(v) => setScale(i, v)}
                />
              ))}
            </Fieldset>
          )}
          <FacilityReadout worldPosition={world?.position} />
          {world && (
            <p className="text-xs text-muted-foreground" data-testid="world-position">
              World position: {world.position.map((v) => formatNumber(v * 1000, 3)).join(', ')} mm
            </p>
          )}
          <ProvenanceSection nodeId={node.id} />
          {node.kind === 'primitive' && <GeometrySummary g={node.geometry} />}
          {node.kind === 'component-instance' && node.component && (
            <ComponentInspector key={node.id} node={node} locked={locked} />
          )}
          {node.kind === 'model-instance' && (
            <ModelInterfacesEditor key={`mi-${node.id}`} node={node} locked={locked} />
          )}
          {node.kind === 'part' && <PartInspector key={`part-${node.id}`} node={node} locked={locked} />}
          {node.kind === 'sketch' && (
            <SketchInspector key={`sketch-${node.id}`} node={node} locked={locked} />
          )}
          {node.kind === 'assembly' && (
            <AssemblyInspector key={`asm-${node.id}`} node={node} locked={locked} />
          )}
          {(node.kind === 'group' || node.kind === 'assembly') && (
            <GroupInspector key={node.id} node={node} />
          )}
          <ParentPicker node={node} />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const r = run(
                  'scene.node.duplicate',
                  { nodeId: node.id, offset: [0.05, 0, 0] },
                  { label: 'Duplicate' },
                );
                if (r.ok) select(r.affectedIds[0]!);
              }}
            >
              <Copy /> Duplicate
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => run('scene.node.delete', { nodeId: node.id }, { label: 'Delete' })}
            >
              <Trash2 /> Delete
            </Button>
          </div>
        </>
      )}
      {node.kind === 'root' && (
        <p className="text-xs text-muted-foreground">
          The scene root is protected: it cannot be moved, hidden, locked or deleted.
        </p>
      )}
    </section>
  );
}

function Heading() {
  return <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Inspector</h2>;
}

function Fieldset({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs text-muted-foreground">{title}</legend>
      <div className="grid grid-cols-3 gap-1.5">{children}</div>
    </fieldset>
  );
}

function NameField({
  node,
  disabled,
  onRename,
}: {
  node: SceneNode;
  disabled: boolean;
  onRename: (name: string) => void;
}) {
  const [text, setText] = useState(node.name);
  return (
    <input
      aria-label="Name"
      className="h-8 w-full rounded border border-border bg-background/60 px-2 text-sm font-medium outline-none focus:border-ring disabled:opacity-60"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => (text.trim() && text.trim() !== node.name ? onRename(text.trim()) : setText(node.name))}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function GeometrySummary({ g }: { g: PrimitiveGeometry }) {
  const mm = (m: number) => `${formatNumber(m * 1000, 3)} mm`;
  const rows: [string, string][] =
    g.shape === 'box'
      ? [
          ['Width', mm(g.width)],
          ['Height', mm(g.height)],
          ['Depth', mm(g.depth)],
        ]
      : g.shape === 'sphere'
        ? [['Radius', mm(g.radius)]]
        : g.shape === 'cylinder' || g.shape === 'cone'
          ? [
              ['Radius', mm(g.radius)],
              ['Height', mm(g.height)],
            ]
          : g.shape === 'plane'
            ? [
                ['Width', mm(g.width)],
                ['Length', mm(g.length)],
              ]
            : [
                ['Major radius', mm(g.majorRadius)],
                ['Tube radius', mm(g.tubeRadius)],
              ];
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">Geometry (parametric, unscaled)</p>
      <dl className="grid grid-cols-[6rem_1fr] gap-y-0.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Explicit reparenting (reliable alternative to drag-and-drop). */
function ParentPicker({ node }: { node: SceneNode }) {
  const scene = useEditor((s) => s.project.scene);
  const run = useEditor((s) => s.run);
  const [keepWorld, setKeepWorld] = useState(true);
  const excluded = new Set([node.id, ...descendantsOf(scene, node.id)]);
  const options = Object.values(scene.nodes).filter(
    (n) => !excluded.has(n.id) && (n.kind === 'root' || n.kind === 'group' || n.kind === 'assembly'),
  );
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-xs">
        <span className="w-12 text-muted-foreground">Parent</span>
        <select
          aria-label="Parent"
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs"
          value={node.parentId ?? ''}
          onChange={(e) =>
            run(
              'scene.node.reparent',
              { nodeId: node.id, parentId: e.target.value, keepWorldTransform: keepWorld },
              { label: 'Reparent' },
            )
          }
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 pl-14 text-xs text-muted-foreground">
        <input type="checkbox" checked={keepWorld} onChange={(e) => setKeepWorld(e.target.checked)} /> keep
        world transform
      </label>
    </div>
  );
}

/** Where this node is in the facility frame, when the project is mounted on a bench. */
function FacilityReadout({ worldPosition }: { worldPosition: readonly number[] | undefined }) {
  const view = useEditor((s) => s.view);
  const projectId = useEditor((s) => s.project.id);
  const bench = useEditor((s) => Object.values(s.layout.items).find((i) => i.mountedProjectId === projectId));
  if (view !== 'facility' || !bench || !worldPosition) return null;
  const zone = getZone(bench.zoneId);
  const eq = getEquipment(bench.equipmentId);
  const chain = zone && eq ? mountChain(zone, bench, eq) : null;
  if (!chain) return null;
  const p = pointToFacility([worldPosition[0]!, worldPosition[1]!, worldPosition[2]!], chain);
  return (
    <p className="text-xs text-muted-foreground" data-testid="facility-position">
      Facility frame (on {bench.name}): {p.map((v) => formatNumber(v * 1000, 1)).join(', ')} mm
    </p>
  );
}
