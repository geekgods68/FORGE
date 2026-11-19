import { Matrix, PointerEventTypes, Vector3 } from '../render/babylon';
import type { ArcRotateCamera, Quaternion, Scene } from '@babylonjs/core';
import type { InputSourceInfo, Intent } from '../interaction/intents';
import type { EntityView } from '../render/entityView';

/**
 * Desktop debugging adapter: mouse + keyboard → intents.
 * - Left-drag a part: move it on a horizontal plane at the grabbed point's height.
 * - Right-drag: orbit camera. Wheel: zoom. (Camera is view state, not document.)
 * - Keys: Q/E rotate ±15°, R reset, Esc cancel drag, ⌘/Ctrl+Z undo,
 *   ⇧⌘/Ctrl+Z or ⌘/Ctrl+Y redo, F reset camera.
 * Inactive while an XR session is running.
 */
const MOUSE: InputSourceInfo = { id: 'desktop:mouse', type: 'desktop-mouse', handedness: 'none' };
const KEYS: InputSourceInfo = { id: 'desktop:keyboard', type: 'desktop-keyboard', handedness: 'none' };
const STEP = Math.PI / 12;

export class DesktopAdapter {
  private drag: { entityId: string; planeY: number; offset: Vector3; rotation: Quaternion } | null = null;
  private hover: string | null = null;
  private readonly home: { alpha: number; beta: number; radius: number; target: Vector3 };

  constructor(
    private readonly scene: Scene,
    private readonly camera: ArcRotateCamera,
    private readonly view: EntityView,
    private readonly emit: (i: Intent) => void,
    private readonly isXr: () => boolean,
  ) {
    this.home = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() };
    scene.onPointerObservable.add((pi) => {
      if (this.isXr()) return;
      const ev = pi.event as PointerEvent;
      const t = performance.now();
      if (pi.type === PointerEventTypes.POINTERDOWN && ev.button === 0) {
        const picked = pi.pickInfo?.pickedMesh;
        if (picked?.metadata?.ui) return; // GUI handles its own clicks
        const id = this.view.entityIdOf(picked);
        this.emit({ kind: 'select', source: MOUSE, time: t, entityId: id });
        if (id && pi.pickInfo?.pickedPoint) {
          const pose = this.view.worldPose(id);
          this.drag = { entityId: id, planeY: pi.pickInfo.pickedPoint.y, offset: pi.pickInfo.pickedPoint.subtract(pose.position), rotation: pose.rotation };
          this.emit({ kind: 'grab-start', source: MOUSE, time: t, entityId: id });
        }
      } else if (pi.type === PointerEventTypes.POINTERMOVE) {
        if (this.drag) this.moveDrag(t);
        else this.updateHover(t);
      } else if (pi.type === PointerEventTypes.POINTERUP && ev.button === 0 && this.drag) {
        this.drag = null;
        this.emit({ kind: 'grab-end', source: MOUSE, time: t });
      }
    });

    addEventListener('keydown', (e) => {
      if (this.isXr() || e.repeat) return;
      const t = performance.now();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        this.drag = null;
        this.emit({ kind: 'cancel', source: KEYS, time: t, reason: 'escape' });
      } else if (mod && k === 'z') {
        e.preventDefault();
        this.emit({ kind: e.shiftKey ? 'redo' : 'undo', source: KEYS, time: t });
      } else if (mod && k === 'y') {
        e.preventDefault();
        this.emit({ kind: 'redo', source: KEYS, time: t });
      } else if (!mod && k === 'q') this.emit({ kind: 'rotate-step', source: KEYS, time: t, radians: STEP });
      else if (!mod && k === 'e') this.emit({ kind: 'rotate-step', source: KEYS, time: t, radians: -STEP });
      else if (!mod && k === 'r') this.emit({ kind: 'reset', source: KEYS, time: t });
      else if (!mod && k === 'f') this.resetCamera();
    });
    // Losing the window mid-drag (e.g. ⌘-Tab) must not leave a half-finished grab.
    addEventListener('blur', () => {
      this.drag = null;
      this.emit({ kind: 'source-lost', source: MOUSE, time: performance.now(), reason: 'window blur' });
    });
  }

  resetCamera() {
    this.camera.alpha = this.home.alpha;
    this.camera.beta = this.home.beta;
    this.camera.radius = this.home.radius;
    this.camera.setTarget(this.home.target.clone());
  }

  private moveDrag(t: number) {
    const d = this.drag!;
    const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera);
    if (Math.abs(ray.direction.y) < 1e-6) return;
    const k = (d.planeY - ray.origin.y) / ray.direction.y;
    if (!(k > 0) || !Number.isFinite(k)) return;
    const hit = ray.origin.add(ray.direction.scale(k));
    const world = hit.subtract(d.offset);
    this.emit({ kind: 'grab-move', source: MOUSE, time: t, transform: this.view.worldToLocal(d.entityId, world, d.rotation.clone()) });
  }

  private updateHover(t: number) {
    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, this.view.isEntityMesh);
    const id = this.view.entityIdOf(pick?.pickedMesh);
    if (id !== this.hover) {
      this.hover = id;
      this.emit({ kind: 'hover', source: MOUSE, time: t, entityId: id });
    }
  }
}
