import type { Vec3 } from '@forge/engineering-core';
import {
  chainToFacility,
  getEquipment,
  getZone,
  mountChain,
  requiredZones,
  type Equipment,
  type WorkspaceItem,
  type Zone,
} from '@forge/facility';
import { TransformControls } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Box3, Box3Helper, Color, Matrix4, Vector3, type Object3D } from 'three';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import { useEditor, useEditorStore } from '@/app/store';
import { useSharedGeometry, useSharedMaterial } from '@/rendering/hooks';
import {
  createPrimitiveGeometry,
  createStandardMaterial,
  geometryCache,
  geometryKey,
  materialCache,
  materialKey,
  type StandardMaterialSpec,
} from '@/rendering/resources';
import { MATERIALS, PALETTE_SPECS } from './materials';
import {
  subscribeZones,
  transitions,
  zoneComponent,
  zoneElement,
  zoneLifecycle,
  zoneSnapshot,
} from './zoneRuntime';

/** item id → rendered group (renderer-side lookup only). */
const ItemRegistry = createContext<Map<string, Object3D>>(new Map());

/**
 * Facility view: fixed architecture (lazy zone modules), the editable workspace layer,
 * and the engineering project mounted on its workbench. Three layers, three owners:
 *   architecture  → @forge/facility data (read-only, never pickable)
 *   workspace     → WorkspaceEngine (layout edit layer)
 *   project       → ForgeEngine (engineering edit layer), placed in mount frame M
 */
export function FacilityScene({ project }: { project: ReactNode }) {
  const zoneId = useEditor((s) => s.currentZoneId);
  const prefetch = useEditor((s) => s.prefetchZoneId);
  const states = useSyncExternalStore(subscribeZones, zoneSnapshot);
  const registry = useMemo(() => new Map<string, Object3D>(), []);
  const invalidate = useThree((s) => s.invalidate);
  const pending = useRef<{ zoneId: string; t0: number; cold: boolean; ready: boolean } | null>(null);
  const lastRequested = useRef<string | null>(null);

  // Declare the wanted set: active zone + its corridor (+ ≤ 1 prefetched destination).
  useEffect(() => {
    if (lastRequested.current !== zoneId) {
      lastRequested.current = zoneId;
      const z = getZone(zoneId);
      pending.current = {
        zoneId,
        t0: performance.now(),
        cold: !zoneComponent(z?.moduleKey ?? null),
        ready: false,
      };
    }
    zoneLifecycle.setTarget(zoneId, prefetch);
  }, [zoneId, prefetch]);
  // Leaving the facility view releases every zone (workspace/project data are untouched).
  useEffect(
    () => () => {
      zoneLifecycle.setTarget(null);
      for (const id of Object.keys(zoneLifecycle.snapshot())) zoneLifecycle.confirmUnloaded(id);
    },
    [],
  );
  // UNLOADING zones are no longer rendered: by the time this effect runs React has
  // unmounted them and their hooks released geometry/material/texture references.
  useEffect(() => {
    for (const [id, st] of Object.entries(states))
      if (st.state === 'unloading') zoneLifecycle.confirmUnloaded(id);
    const p = pending.current;
    if (p && !p.ready && requiredZones(p.zoneId).every((id) => states[id]?.state === 'active')) {
      p.ready = true;
      invalidate();
    }
  }, [states, invalidate]);
  // Transition time = request → required zones mounted → first frame rendered with them.
  useFrame(() => {
    const p = pending.current;
    if (p?.ready) {
      transitions.push({ zoneId: p.zoneId, ms: performance.now() - p.t0, coldModules: p.cold });
      if (transitions.length > 200) transitions.shift();
      pending.current = null;
    }
  });

  const mounted = useMemo(
    () =>
      Object.entries(states)
        .filter(([, st]) => st.state === 'active' && st.role !== 'prefetch')
        .map(([id]) => id),
    [states],
  );
  return (
    <ItemRegistry.Provider value={registry}>
      <color attach="background" args={['#1c1f24']} />
      <hemisphereLight args={['#f4f6f8', '#5b6068', 1.25]} />
      <directionalLight position={[6, 14, 4]} intensity={1.2} />
      <SharedPalettePin />
      {mounted.map((id) => (
        <ZoneMount key={id} zone={getZone(id)!} />
      ))}
      <WorkspaceLayer zones={mounted} />
      <MountedProject zones={mounted}>{project}</MountedProject>
      <LayoutManipulator />
    </ItemRegistry.Provider>
  );
}

/**
 * Holds one reference to every palette material and the unit template geometries while
 * the facility view is open, so moving between zones never disposes and recompiles
 * shared resources — only zone-specific ones (instance buffers, sign textures) churn.
 */
function SharedPalettePin() {
  useEffect(() => {
    const mats = PALETTE_SPECS.map((spec) => {
      const key = materialKey(spec);
      materialCache.acquire(key, () => createStandardMaterial(spec));
      return key;
    });
    const geos = [
      { shape: 'box', width: 1, height: 1, depth: 1 },
      { shape: 'cylinder', radius: 0.5, height: 1 },
    ] as const;
    const gkeys = geos.map((g) => {
      const key = geometryKey(g);
      geometryCache.acquire(key, () => createPrimitiveGeometry(g));
      return key;
    });
    return () => {
      mats.forEach((k) => materialCache.release(k));
      gkeys.forEach((k) => geometryCache.release(k));
    };
  }, []);
  return null;
}

function ZoneMount({ zone }: { zone: Zone }) {
  const element = zoneElement(zone);
  if (!element) return null;
  return (
    <group position={zone.pose.position} rotation={[0, zone.pose.yaw, 0]}>
      {element}
    </group>
  );
}

/** Equipment of loaded zones only; items elsewhere stay in the layout, just not rendered. */
function WorkspaceLayer({ zones }: { zones: string[] }) {
  const items = useEditor((s) => s.layout.items);
  const byZone = useMemo(() => {
    const m = new Map<string, WorkspaceItem[]>();
    for (const it of Object.values(items))
      if (zones.includes(it.zoneId)) m.set(it.zoneId, [...(m.get(it.zoneId) ?? []), it]);
    return m;
  }, [items, zones]);
  return (
    <>
      {[...byZone].map(([zoneId, list]) => {
        const zone = getZone(zoneId);
        if (!zone) return null;
        return (
          <group key={zoneId} position={zone.pose.position} rotation={[0, zone.pose.yaw, 0]}>
            {list.map((it) => (
              <EquipmentItem key={it.id} item={it} />
            ))}
          </group>
        );
      })}
    </>
  );
}

function EquipmentItem({ item }: { item: WorkspaceItem }) {
  const eq = getEquipment(item.equipmentId);
  const registry = useContext(ItemRegistry);
  const layoutActive = useEditor((s) => s.view === 'facility' && s.editLayer === 'layout');
  const selected = useEditor((s) => s.itemSelection === item.id);
  const hosting = useEditor((s) => item.mountedProjectId !== null && item.mountedProjectId === s.project.id);
  const selectItem = useEditor((s) => s.selectItem);
  if (!eq) return null;
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!layoutActive || e.delta > 4) return; // engineering layer: equipment is not a target
    e.stopPropagation();
    selectItem(item.id);
  };
  return (
    <group
      name={`item:${item.id}`}
      ref={(o) => {
        if (o) registry.set(item.id, o);
        else registry.delete(item.id);
      }}
      position={item.pose.position}
      rotation={[0, item.pose.yaw, 0]}
      userData={{ itemId: item.id, layer: 'workspace' }}
      onClick={onClick}
    >
      <EquipmentVisual eq={eq} highlight={selected ? 'selected' : hosting ? 'hosting' : 'none'} />
    </group>
  );
}

function Part({ size, position, spec }: { size: Vec3; position: Vec3; spec: StandardMaterialSpec }) {
  const geometry = useSharedGeometry({ shape: 'box', width: size[0], height: size[1], depth: size[2] });
  const material = useSharedMaterial(spec);
  return <mesh geometry={geometry} material={material} position={position} dispose={null} />;
}

function EquipmentVisual({ eq, highlight }: { eq: Equipment; highlight: 'none' | 'selected' | 'hosting' }) {
  const [w, h, d] = eq.sizeM;
  const tint = highlight === 'selected' ? '#0e7490' : '#000000';
  const top: StandardMaterialSpec = {
    color: '#6b7787',
    emissive: highlight === 'hosting' ? '#155e75' : tint,
    roughness: 0.5,
  };
  const frame: StandardMaterialSpec = { color: '#2f353d', emissive: tint, roughness: 0.6 };
  const body: StandardMaterialSpec = { color: '#4a5563', emissive: tint, roughness: 0.6 };
  switch (eq.visual) {
    case 'bench-standard':
    case 'bench-heavy': {
      const t = eq.visual === 'bench-heavy' ? 0.08 : 0.05;
      const leg = 0.07;
      return (
        <group>
          <Part size={[w, t, d]} position={[0, h - t / 2, 0]} spec={top} />
          {[-1, 1].flatMap((sx) =>
            [-1, 1].map((sz) => (
              <Part
                key={`${sx}${sz}`}
                size={[leg, h - t, leg]}
                position={[sx * (w / 2 - leg), (h - t) / 2, sz * (d / 2 - leg)]}
                spec={frame}
              />
            )),
          )}
          <Part size={[w - 0.2, 0.03, d - 0.15]} position={[0, 0.22, 0]} spec={frame} />
        </group>
      );
    }
    case 'cabinet':
      return (
        <group>
          <Part size={[w, h, d]} position={[0, h / 2, 0]} spec={body} />
          <Part
            size={[w * 0.9, 0.02, 0.01]}
            position={[0, h * 0.62, d / 2 + 0.005]}
            spec={MATERIALS.accent}
          />
        </group>
      );
    case 'rack':
      return (
        <group>
          {[-1, 1].flatMap((sx) =>
            [-1, 1].map((sz) => (
              <Part
                key={`${sx}${sz}`}
                size={[0.04, h, 0.04]}
                position={[sx * (w / 2 - 0.02), h / 2, sz * (d / 2 - 0.02)]}
                spec={frame}
              />
            )),
          )}
          {[0.3, 0.8, 1.3, 1.8].map((y) => (
            <Part key={y} size={[w, 0.03, d]} position={[0, y, 0]} spec={body} />
          ))}
        </group>
      );
    case 'pedestal':
      return (
        <group>
          <Part size={[w, h, d]} position={[0, h / 2, 0]} spec={body} />
          <Part size={[w * 0.8, 0.02, d * 0.8]} position={[0, h + 0.01, 0]} spec={MATERIALS.accent} />
        </group>
      );
  }
}

/** Places the engineering project's root in mount frame M of the bench hosting it. */
function MountedProject({ children, zones }: { children: ReactNode; zones: string[] }) {
  const projectId = useEditor((s) => s.project.id);
  const items = useEditor((s) => s.layout.items);
  const found = Object.values(items).find((i) => i.mountedProjectId === projectId);
  const bench = found && zones.includes(found.zoneId) ? found : undefined;
  const matrix = useMemo(() => {
    if (!bench) return null;
    const zone = getZone(bench.zoneId);
    const eq = getEquipment(bench.equipmentId);
    const chain = zone && eq ? mountChain(zone, bench, eq) : null;
    return chain ? new Matrix4().fromArray(chainToFacility(chain)) : null; // both column-major
  }, [bench]);
  if (!matrix) return null;
  return (
    <group name="project-mount" matrix={matrix} matrixAutoUpdate={false}>
      {children}
    </group>
  );
}

/** Floor-constrained gizmo for the selected workspace item (layout layer only). */
function LayoutManipulator() {
  const store = useEditorStore();
  const registry = useContext(ItemRegistry);
  const id = useEditor((s) => (s.view === 'facility' && s.editLayer === 'layout' ? s.itemSelection : null));
  const item = useEditor((s) => (id ? s.layout.items[id] : undefined));
  const mode = useEditor((s) => (s.toolMode === 'rotate' ? 'rotate' : 'translate'));
  const snap = useEditor((s) => s.snap);
  const cancelRequest = useEditor((s) => s.cancelDragRequest);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useRef<TransformControlsImpl>(null);
  const startRevision = useRef<number | null>(null);
  const cancelled = useRef(false);
  const resetting = useRef(false);
  const [target, setTarget] = useState<Object3D | null>(null);
  const helper = useMemo(() => new Box3Helper(new Box3(), new Color('#7dd3fc')), []);

  const editable = !!item && !item.locked;
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  // Read-only test diagnostic: client-pixel centre of a gizmo picker handle ('X', 'Z', 'XZ', 'Y'…).
  useEffect(() => {
    const w = window as unknown as { __forge?: Record<string, unknown> };
    w.__forge = {
      ...w.__forge,
      layoutGizmoHandle: (name: string) => {
        const c = controls.current as unknown as {
          mode: 'translate' | 'rotate' | 'scale';
          gizmo?: { picker: Record<string, Object3D> };
        } | null;
        const handle = c?.gizmo?.picker[c.mode]?.children.find((h) => h.name === name && h.visible);
        if (!handle) return null;
        handle.updateWorldMatrix(true, false);
        const v = new Box3().setFromObject(handle).getCenter(new Vector3()).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      },
    };
  }, [camera, gl]);
  useFrame(() => {
    const next = editable && id ? (registry.get(id) ?? null) : null;
    if (next !== target) setTarget(next);
    if (id) {
      const o = registry.get(id);
      if (o) helper.box.setFromObject(o);
    }
  });
  useEffect(() => invalidate(), [id, editable, invalidate]);

  const resetToStart = () => {
    if (resetting.current) return;
    resetting.current = true;
    try {
      controls.current?.reset();
    } finally {
      resetting.current = false;
    }
  };
  useEffect(() => {
    if (cancelRequest === 0 || startRevision.current === null) return;
    cancelled.current = true;
    resetToStart();
  }, [cancelRequest]);

  const resync = (o: Object3D) => {
    const it = store.getState().workspace.getItem(id ?? '');
    if (!it) return;
    o.position.set(...it.pose.position);
    o.rotation.set(0, it.pose.yaw, 0);
  };

  return (
    <>
      {id && <primitive object={helper} />}
      {target && id && (
        <TransformControls
          ref={controls}
          object={target}
          mode={mode}
          showY={mode === 'rotate'}
          showX={mode === 'translate'}
          showZ={mode === 'translate'}
          size={0.9}
          translationSnap={snap.enabled ? snap.translationM : null}
          rotationSnap={snap.enabled ? snap.rotationRad : null}
          onMouseDown={() => {
            cancelled.current = false;
            startRevision.current = store.getState().layout.revision;
            store.getState().setDragging(true);
          }}
          onObjectChange={() => {
            if (resetting.current) return;
            if (cancelled.current) resetToStart();
          }}
          onMouseUp={() => {
            const rev = startRevision.current;
            startRevision.current = null;
            store.getState().setDragging(false);
            if (cancelled.current || rev === null) {
              cancelled.current = false;
              resync(target);
              store.getState().setStatus({ tone: 'info', text: 'Layout manipulation cancelled.' });
              return;
            }
            const yaw = 2 * Math.atan2(target.quaternion.y, target.quaternion.w);
            const before = store.getState().workspace.getItem(id);
            const moved =
              before &&
              (Math.abs(before.pose.position[0] - target.position.x) > 1e-9 ||
                Math.abs(before.pose.position[2] - target.position.z) > 1e-9 ||
                Math.abs(before.pose.yaw - yaw) > 1e-9);
            if (moved)
              store
                .getState()
                .runWorkspace(
                  'workspace.item.move',
                  { itemId: id, position: [target.position.x, target.position.z], yaw },
                  { label: mode === 'rotate' ? 'Rotate equipment' : 'Move equipment', expectedRevision: rev },
                );
            resync(target); // accepted → same pose; rejected (collision/out of area) → snap back
          }}
        />
      )}
    </>
  );
}
