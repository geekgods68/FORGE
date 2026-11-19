import { Color3, CreateBox, Quaternion, Ray, StandardMaterial, Vector3 } from '../render/babylon';
import type { AbstractMesh, Matrix, Mesh, Observer, Scene, WebXRDefaultExperience, WebXRInputSource } from '@babylonjs/core';
import type { InputSourceInfo, Intent } from '../interaction/intents';
import type { EntityView } from '../render/entityView';

/**
 * XR controller adapter (input stage I0). Reads the standard WebXR gamepad
 * mapping directly ('xr-standard': buttons[0] = trigger, buttons[1] = squeeze),
 * so it does not depend on downloaded controller profiles.
 *
 * - Trigger on a part: select. (Trigger on the wall panel is handled by
 *   Babylon's pointer-selection feature → GUI buttons.)
 * - Squeeze while the ray hits a part: grab. The part keeps its offset relative
 *   to the controller's aim pose (distance grab with rotation) until release.
 * - Controller removal → 'source-lost' (cancels an active grab).
 *
 * The adapter only emits intents; it never mutates the document.
 */
interface ControllerState {
  info: InputSourceInfo;
  source: WebXRInputSource;
  trigger: boolean;
  squeeze: boolean;
  hover: string | null;
  grab: { entityId: string; offset: Matrix } | null;
  proxy: Mesh;
}

export class XrControllerAdapter {
  private states = new Map<string, ControllerState>();
  private ray = new Ray(Vector3.Zero(), Vector3.Forward(), 10);
  private frameObserver: Observer<XRFrame> | null;
  private proxyMat: StandardMaterial;

  constructor(
    private readonly xr: WebXRDefaultExperience,
    private readonly scene: Scene,
    private readonly view: EntityView,
    private readonly emit: (i: Intent) => void,
  ) {
    this.proxyMat = new StandardMaterial('controller-proxy', scene);
    this.proxyMat.diffuseColor = new Color3(0.15, 0.16, 0.18);
    this.proxyMat.emissiveColor = new Color3(0.05, 0.3, 0.36);
    xr.input.onControllerAddedObservable.add((c) => this.add(c));
    xr.input.onControllerRemovedObservable.add((c) => this.remove(c, 'controller removed'));
    this.frameObserver = xr.baseExperience.sessionManager.onXRFrameObservable.add(() => this.frame());
  }

  /** Called on session end: report every source as lost and drop proxies. */
  releaseAll(reason: string) {
    for (const s of [...this.states.values()]) this.remove(s.source, reason);
  }

  dispose() {
    this.releaseAll('adapter disposed');
    if (this.frameObserver) this.xr.baseExperience.sessionManager.onXRFrameObservable.remove(this.frameObserver);
    this.frameObserver = null;
    this.proxyMat.dispose();
  }

  private add(c: WebXRInputSource) {
    if (this.states.has(c.uniqueId)) return;
    const handed = c.inputSource.handedness;
    // Procedural controller proxy (no downloaded model).
    const proxy = CreateBox(`controller-proxy-${handed}`, { width: 0.03, height: 0.025, depth: 0.11 }, this.scene);
    proxy.material = this.proxyMat;
    proxy.isPickable = false;
    proxy.parent = c.grip ?? c.pointer;
    proxy.position.set(0, 0, 0.02);
    this.states.set(c.uniqueId, {
      info: { id: `xr:${c.uniqueId}`, type: 'xr-controller', handedness: handed === 'left' || handed === 'right' ? handed : 'none' },
      source: c,
      trigger: false,
      squeeze: false,
      hover: null,
      grab: null,
      proxy,
    });
  }

  private remove(c: WebXRInputSource, reason: string) {
    const s = this.states.get(c.uniqueId);
    if (!s) return;
    this.states.delete(c.uniqueId);
    s.proxy.dispose();
    this.emit({ kind: 'source-lost', source: s.info, time: performance.now(), reason });
  }

  private frame() {
    const now = performance.now();
    for (const s of this.states.values()) {
      const gp = s.source.inputSource.gamepad;
      s.source.getWorldPointerRayToRef(this.ray);
      const hit = this.scene.pickWithRay(this.ray, (m: AbstractMesh) => this.view.isEntityMesh(m) || m.metadata?.ui === true);
      const hitEntity = this.view.entityIdOf(hit?.pickedMesh);
      const hitUi = hit?.pickedMesh?.metadata?.ui === true;

      if (hitEntity !== s.hover) {
        s.hover = hitEntity;
        this.emit({ kind: 'hover', source: s.info, time: now, entityId: hitEntity });
      }
      if (!gp) continue; // tracked source without buttons: hover only

      const trigger = !!gp.buttons[0]?.pressed;
      const squeeze = !!gp.buttons[1]?.pressed;

      if (trigger && !s.trigger && !hitUi) this.emit({ kind: 'select', source: s.info, time: now, entityId: hitEntity });

      if (squeeze && !s.squeeze && hitEntity) {
        const pointerWorld = s.source.pointer.computeWorldMatrix(true);
        // Row-vector convention: entityWorld = offset * pointerWorld.
        const offset = this.view.worldMatrix(hitEntity).multiply(pointerWorld.clone().invert());
        s.grab = { entityId: hitEntity, offset };
        this.emit({ kind: 'grab-start', source: s.info, time: now, entityId: hitEntity });
      } else if (squeeze && s.grab) {
        const world = s.grab.offset.multiply(s.source.pointer.computeWorldMatrix(true));
        const pos = new Vector3();
        const rot = new Quaternion();
        world.decompose(undefined, rot, pos);
        this.emit({ kind: 'grab-move', source: s.info, time: now, transform: this.view.worldToLocal(s.grab.entityId, pos, rot) });
      } else if (!squeeze && s.squeeze && s.grab) {
        s.grab = null;
        this.emit({ kind: 'grab-end', source: s.info, time: now });
      }
      s.trigger = trigger;
      s.squeeze = squeeze;
    }
  }
}
