import { electricalModelFor, type CatalogPin } from '@forge/components';
import type { PinRole } from '@forge/engineering-core';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Vector3,
  type Group,
  type Object3D,
} from 'three';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { useSharedGeometry, useSharedMaterial } from '@/rendering/hooks';
import { analyse, circuitDiagnostics, circuitOf, clickPin, elecUiFor } from './state';

/**
 * 3D view of the circuit: pin markers at the catalogue pin positions of every placed
 * component that is part of the circuit, and wires drawn between 3D pins. It reads the SAME
 * electrical definition as the schematic; clicking pins (wire tool) issues the same
 * `electrical.wire.add` command. Drawing a wire in 3D never infers a connection from
 * proximity — only the two pins clicked are connected.
 */
const ROLE_COLOR: Partial<Record<PinRole, string>> = {
  ground: '#1f2937',
  supply: '#ef4444',
  pwm: '#f59e0b',
  gpio: '#eab308',
  serial: '#a855f7',
  'analog-input': '#06b6d4',
  'sensor-signal': '#22c55e',
  'digital-input': '#84cc16',
};
const SEGMENTS = 16;

interface Pin3D {
  key: string;
  partId: string;
  nodeId: string;
  pin: CatalogPin;
  position: [number, number, number];
}

export function CircuitLayer3D({ registry }: { registry: Map<string, Object3D> }) {
  const editor = useEditorStore();
  const ui = useStore(elecUiFor(editor));
  const def = useEditor((s) => circuitOf(s.project.scene));
  const scene = useEditor((s) => s.project.scene);
  const electronicsMode = useEditor((s) => s.workMode === 'electronics');
  const pins = useMemo(() => {
    const out: Pin3D[] = [];
    for (const p of def?.parts ?? []) {
      if (!p.nodeId || !p.definitionId) continue;
      const n = scene.nodes[p.nodeId];
      if (!n || n.kind !== 'component-instance') continue;
      const m = electricalModelFor(
        p.definitionId,
        n.component?.parameters ?? {},
        n.component?.variantId ?? null,
      );
      if (!m) continue;
      for (const pin of m.pins)
        if (pin.position)
          out.push({
            key: `${p.id}\u0000${pin.id}`,
            partId: p.id,
            nodeId: p.nodeId,
            pin,
            position: pin.position,
          });
    }
    return out;
  }, [def, scene]);
  const byKey = useMemo(() => new Map(pins.map((p) => [p.key, p])), [pins]);
  const nl = useMemo(() => (def ? analyse(def, scene).netlist : null), [def, scene]);
  const netOf = (partId: string, pin: string) => {
    const n = nl?.pinNet(partId, pin);
    return n === undefined || !nl ? null : nl.nets[n]!.name;
  };
  const wires = useMemo(
    () =>
      (def?.wires ?? []).flatMap((w) => {
        const a = byKey.get(`${w.a.partId}\u0000${w.a.pin}`);
        const b = byKey.get(`${w.b.partId}\u0000${w.b.pin}`);
        const n = nl?.pinNet(w.a.partId, w.a.pin);
        return a && b
          ? [{ id: w.id, a, b, color: w.color, net: n === undefined || !nl ? null : nl.nets[n]!.name }]
          : [];
      }),
    [def, byKey, nl],
  );

  const geometry = useSharedGeometry({ shape: 'sphere', radius: 0.0011 });
  const mats = {
    default: useSharedMaterial({ color: '#9ca3af', emissive: '#111827' }),
    pending: useSharedMaterial({ color: '#f97316', emissive: '#f97316' }),
    net: useSharedMaterial({ color: '#38bdf8', emissive: '#0284c7' }),
  };
  const roleMats = {
    ground: useSharedMaterial({ color: ROLE_COLOR.ground!, emissive: '#000000' }),
    supply: useSharedMaterial({ color: ROLE_COLOR.supply!, emissive: '#7f1d1d' }),
    signal: useSharedMaterial({ color: '#eab308', emissive: '#713f12' }),
    analog: useSharedMaterial({ color: '#06b6d4', emissive: '#164e63' }),
  };
  const matFor = (p: Pin3D) => {
    if (ui.pending?.partId === p.partId && ui.pending.pin === p.pin.id) return mats.pending;
    if (ui.selectedNet && netOf(p.partId, p.pin.id) === ui.selectedNet) return mats.net;
    const r = p.pin.role;
    if (r === 'ground') return roleMats.ground;
    if (r === 'supply') return roleMats.supply;
    if (r === 'analog-input') return roleMats.analog;
    if (r === 'passive') return mats.default;
    return roleMats.signal;
  };

  const markerRefs = useRef<(Group | null)[]>([]);
  const lineGroup = useRef<Group>(null);
  const v = useMemo(() => new Vector3(), []);
  const lines = useMemo(
    () =>
      wires.map((w) => {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
        const line = new Line(g, new LineBasicMaterial({ color: w.color ?? '#facc15' }));
        line.frustumCulled = false;
        line.userData = { wireId: w.id, net: w.net };
        return line;
      }),
    [wires],
  );
  useEffect(
    () => () =>
      lines.forEach((l) => {
        l.geometry.dispose();
        (l.material as LineBasicMaterial).dispose();
      }),
    [lines],
  );
  useFrame(() => {
    const world = (p: Pin3D, out: Vector3) => {
      const o = registry.get(p.nodeId);
      return o ? o.localToWorld(out.set(...p.position)) : null;
    };
    pins.forEach((p, i) => {
      const g = markerRefs.current[i];
      if (!g) return;
      const w = world(p, v);
      g.visible = !!w && electronicsMode;
      if (w) {
        g.position.copy(w);
        circuitDiagnostics.pins.set(`${p.partId}.${p.pin.id}`, [w.x, w.y, w.z]);
      }
    });
    const a = new Vector3();
    const b = new Vector3();
    const m = new Vector3();
    wires.forEach((w, i) => {
      const line = lines[i]!;
      const pa = world(w.a, a);
      const pb = world(w.b, b);
      line.visible = !!pa && !!pb;
      if (!pa || !pb) return;
      // A jumper-like arc: quadratic Bézier raised by a quarter of the span.
      m.addVectors(pa, pb).multiplyScalar(0.5);
      m.y += Math.max(0.01, pa.distanceTo(pb) * 0.25);
      const arr = (line.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
      for (let k = 0; k <= SEGMENTS; k++) {
        const t = k / SEGMENTS;
        const u = 1 - t;
        arr[3 * k] = u * u * pa.x + 2 * u * t * m.x + t * t * pb.x;
        arr[3 * k + 1] = u * u * pa.y + 2 * u * t * m.y + t * t * pb.y;
        arr[3 * k + 2] = u * u * pa.z + 2 * u * t * m.z + t * t * pb.z;
      }
      line.geometry.getAttribute('position').needsUpdate = true;
      const mat = line.material as LineBasicMaterial;
      mat.color.set(
        ui.selectedWire === w.id
          ? '#f97316'
          : ui.selectedNet && w.net === ui.selectedNet
            ? '#38bdf8'
            : (w.color ?? '#facc15'),
      );
    });
  });

  if (!def) return null;
  return (
    <group name="circuit-3d">
      <group ref={lineGroup}>
        {lines.map((l) => (
          <primitive key={l.uuid} object={l} />
        ))}
      </group>
      {pins.map((p, i) => (
        <group key={p.key} ref={(g) => void (markerRefs.current[i] = g)} visible={false}>
          <mesh
            geometry={geometry}
            material={matFor(p)}
            onClick={(e) => {
              e.stopPropagation();
              clickPin(editor, { partId: p.partId, pin: p.pin.id });
            }}
            userData={{ pin: `${p.partId}.${p.pin.id}` }}
          />
        </group>
      ))}
    </group>
  );
}
