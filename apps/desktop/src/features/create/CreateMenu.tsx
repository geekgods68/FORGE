import {
  DEFAULT_PRIMITIVE_GEOMETRY,
  PRIMITIVE_SHAPES,
  primitiveHalfHeight,
  type PrimitiveGeometry,
  type PrimitiveShape,
} from '@forge/engineering-core';
import { rectangleEntities } from '@forge/mechanics';
import {
  Axis3d,
  Box,
  Boxes,
  Circle,
  Cone,
  Cylinder,
  Folder,
  PenTool,
  Plus,
  Square,
  Torus,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/NumberField';
import { useEditor } from '@/app/store';

const ICONS = { box: Box, sphere: Circle, cylinder: Cylinder, cone: Cone, plane: Square, torus: Torus };
const PARAMS: { [K in PrimitiveShape]: { key: string; label: string }[] } = {
  box: [
    { key: 'width', label: 'Width' },
    { key: 'height', label: 'Height' },
    { key: 'depth', label: 'Depth' },
  ],
  sphere: [{ key: 'radius', label: 'Radius' }],
  cylinder: [
    { key: 'radius', label: 'Radius' },
    { key: 'height', label: 'Height' },
  ],
  cone: [
    { key: 'radius', label: 'Base radius' },
    { key: 'height', label: 'Height' },
  ],
  plane: [
    { key: 'width', label: 'Width' },
    { key: 'length', label: 'Length' },
  ],
  torus: [
    { key: 'majorRadius', label: 'Major radius' },
    { key: 'tubeRadius', label: 'Tube radius' },
  ],
};

/** Conjure generic engineering primitives with real dimensions (mm in the UI, m stored). */
export function CreateMenu() {
  const [open, setOpen] = useState(false);
  const [shape, setShape] = useState<PrimitiveShape>('box');
  const [dims, setDims] = useState<Record<string, number>>(
    () => ({ ...DEFAULT_PRIMITIVE_GEOMETRY.box }) as unknown as Record<string, number>,
  );
  const run = useEditor((s) => s.run);
  const select = useEditor((s) => s.select);
  const selection = useEditor((s) => s.selection);
  const nodes = useEditor((s) => s.project.scene.nodes);

  // Create inside the selected group, otherwise at the scene root.
  const selected = selection[0] ? nodes[selection[0]] : undefined;
  const parentId =
    selected && (selected.kind === 'group' || selected.kind === 'assembly') ? selected.id : undefined;

  const pick = (s: PrimitiveShape) => {
    setShape(s);
    setDims({ ...DEFAULT_PRIMITIVE_GEOMETRY[s] } as unknown as Record<string, number>);
  };

  const create = () => {
    const geometry = {
      shape,
      ...Object.fromEntries(PARAMS[shape].map((p) => [p.key, dims[p.key]])),
    } as PrimitiveGeometry;
    const r = run(
      'scene.node.create',
      {
        node: {
          kind: 'primitive',
          geometry,
          ...(parentId ? { parentId } : {}),
          transform: { position: [0.4, primitiveHalfHeight(geometry), 0] },
        },
      },
      { label: `Create ${shape}` },
    );
    if (r.ok) {
      select(r.affectedIds[0]!);
      setOpen(false);
    }
  };

  const createOther = (kind: 'group' | 'reference') => {
    const r = run(
      'scene.node.create',
      {
        node:
          kind === 'group'
            ? { kind: 'group', ...(parentId ? { parentId } : {}) }
            : {
                kind: 'reference',
                referenceType: 'datum-axes',
                sizeM: 0.1,
                ...(parentId ? { parentId } : {}),
              },
      },
      { label: kind === 'group' ? 'Create group' : 'Create datum' },
    );
    if (r.ok) {
      select(r.affectedIds[0]!);
      setOpen(false);
    }
  };

  /** Phase 4: an empty mechanical assembly, a constrained rectangle sketch, or a feature part. */
  const createMechanical = (kind: 'assembly' | 'sketch' | 'part') => {
    const at = { position: [0.4, 0, 0] as [number, number, number] };
    const where = parentId ? { parentId } : {};
    const r =
      kind === 'assembly'
        ? run('assembly.create', { nodeIds: [], ...where }, { label: 'Create assembly' })
        : kind === 'sketch'
          ? run(
              'sketch.create',
              { ...rectangleEntities('r', -0.05, -0.03, 0.1, 0.06), ...where, transform: at },
              { label: 'Create sketch' },
            )
          : run(
              'part.create',
              {
                ...where,
                transform: at,
                depth: 0.005,
                profile: {
                  outer: [
                    [-0.05, -0.03],
                    [0.05, -0.03],
                    [0.05, 0.03],
                    [-0.05, 0.03],
                  ],
                  holes: [],
                },
              },
              { label: 'Create part' },
            );
    if (r.ok) {
      select(r.affectedIds[0]!);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog">
        <Plus /> Add
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Create object"
          className="absolute top-10 left-0 z-20 w-72 space-y-3 rounded-lg border border-border bg-card p-3 shadow-2xl"
        >
          <div className="grid grid-cols-3 gap-1">
            {PRIMITIVE_SHAPES.map((s) => {
              const Icon = ICONS[s];
              return (
                <Button
                  key={s}
                  size="sm"
                  variant={s === shape ? 'default' : 'secondary'}
                  onClick={() => pick(s)}
                  aria-pressed={s === shape}
                  className="capitalize"
                >
                  <Icon /> {s}
                </Button>
              );
            })}
          </div>
          <div className="space-y-1.5">
            {PARAMS[shape].map((p) => (
              <div key={p.key} className="flex items-center gap-2 text-xs">
                <span className="w-24 text-muted-foreground">{p.label} (mm)</span>
                <div className="flex-1">
                  <NumberField
                    label=""
                    unit="mm"
                    testId={`create-${p.key}`}
                    value={dims[p.key]! * 1000}
                    decimals={3}
                    min={0.001}
                    onCommit={(mm) => setDims({ ...dims, [p.key]: mm / 1000 })}
                  />
                </div>
              </div>
            ))}
          </div>
          <Button className="w-full" onClick={create}>
            Create {shape}
          </Button>
          <div className="flex gap-2 border-t border-border pt-2">
            <Button size="sm" variant="ghost" onClick={() => createOther('group')}>
              <Folder /> Empty group
            </Button>
            <Button size="sm" variant="ghost" onClick={() => createOther('reference')}>
              <Axis3d /> Datum axes
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-1 border-t border-border pt-2" aria-label="Mechanical CAD">
            <Button
              size="sm"
              variant="ghost"
              data-testid="create-assembly"
              onClick={() => createMechanical('assembly')}
            >
              <Boxes /> Assembly
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="create-sketch"
              onClick={() => createMechanical('sketch')}
            >
              <PenTool /> Sketch
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="create-part"
              onClick={() => createMechanical('part')}
            >
              <Wrench /> Part
            </Button>
          </div>
          {parentId && (
            <p className="text-xs text-muted-foreground">Will be created inside “{selected!.name}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
