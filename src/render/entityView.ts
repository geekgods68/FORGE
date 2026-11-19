import { Color3, CreateBox, Quaternion, StandardMaterial, Vector3 } from './babylon';
import type { AbstractMesh, Matrix, Mesh, Scene } from '@babylonjs/core';
import type { InteractionView } from '../interaction/controller';
import { CATALOG } from '../model/catalog';
import type { Quat, Transform, Vec3, WorkshopDocument } from '../model/types';

/**
 * Renders entities from the authoritative document. `sync(doc)` reconciles:
 * creates meshes for new ids, updates existing ones, disposes removed ones.
 * It is idempotent, so calling it again (e.g. on XR re-entry) never duplicates
 * meshes. Previews override the rendered pose only; the document is untouched.
 */
export class EntityView implements InteractionView {
  private meshes = new Map<string, Mesh>();
  private materials = new Map<string, StandardMaterial>();
  private previews = new Map<string, Transform>();
  private doc: WorkshopDocument | null = null;
  private hovered: string | null = null;
  private selected: string | null = null;

  constructor(private readonly scene: Scene) {}

  sync(doc: WorkshopDocument) {
    this.doc = doc;
    for (const [id, mesh] of this.meshes) {
      if (!doc.entities[id]) {
        mesh.dispose(false, false); // shared materials are kept
        this.meshes.delete(id);
        this.previews.delete(id);
      }
    }
    for (const e of Object.values(doc.entities)) {
      let mesh = this.meshes.get(e.id);
      if (!mesh) {
        const def = CATALOG[e.partDefId]!;
        const [w, h, d] = def.dimensionsM;
        mesh = CreateBox(`entity:${e.id}`, { width: w, height: h, depth: d }, this.scene);
        mesh.material = this.material(e.partDefId);
        mesh.metadata = { entityId: e.id };
        mesh.rotationQuaternion = new Quaternion();
        mesh.outlineWidth = 0.004;
        mesh.outlineColor = new Color3(0.2, 0.85, 1);
        mesh.overlayColor = new Color3(0.4, 0.9, 1);
        mesh.overlayAlpha = 0.25;
        this.meshes.set(e.id, mesh);
      }
    }
    // Parent links after all meshes exist.
    for (const e of Object.values(doc.entities)) {
      const mesh = this.meshes.get(e.id)!;
      const parent = e.parentId ? (this.meshes.get(e.parentId) ?? null) : null;
      if (mesh.parent !== parent) mesh.parent = parent;
      this.applyPose(e.id);
    }
    this.refreshHighlights();
  }

  setPreview(entityId: string, transform: Transform | null) {
    if (transform) this.previews.set(entityId, transform);
    else this.previews.delete(entityId);
    this.applyPose(entityId);
  }

  setHover(entityId: string | null) {
    this.hovered = entityId;
    this.refreshHighlights();
  }

  setSelected(entityId: string | null) {
    this.selected = entityId;
    this.refreshHighlights();
  }

  entityIdOf(mesh: AbstractMesh | null | undefined): string | null {
    const id = mesh?.metadata?.entityId;
    return typeof id === 'string' && this.meshes.has(id) ? id : null;
  }

  isEntityMesh = (mesh: AbstractMesh) => this.entityIdOf(mesh) !== null;

  meshFor(id: string): Mesh | undefined {
    return this.meshes.get(id);
  }

  meshCount() {
    return this.meshes.size;
  }

  /** Convert a world pose to the entity's parent-local document transform. */
  worldToLocal(entityId: string, worldPos: Vector3, worldRot: Quaternion): Transform {
    const parent = this.meshes.get(entityId)?.parent as AbstractMesh | null;
    let pos = worldPos;
    let rot = worldRot;
    if (parent) {
      parent.computeWorldMatrix(true);
      const inv = parent.getWorldMatrix().clone().invert();
      pos = Vector3.TransformCoordinates(worldPos, inv);
      const pr = new Quaternion();
      parent.getWorldMatrix().decompose(undefined, pr);
      rot = Quaternion.Inverse(pr).multiply(worldRot);
    }
    rot.normalize();
    return { position: [pos.x, pos.y, pos.z] as Vec3, rotation: [rot.x, rot.y, rot.z, rot.w] as Quat };
  }

  worldPose(entityId: string): { position: Vector3; rotation: Quaternion } {
    const m = this.meshes.get(entityId)!;
    m.computeWorldMatrix(true);
    const position = new Vector3();
    const rotation = new Quaternion();
    m.getWorldMatrix().decompose(undefined, rotation, position);
    return { position, rotation };
  }

  worldMatrix(entityId: string): Matrix {
    const m = this.meshes.get(entityId)!;
    return m.computeWorldMatrix(true).clone();
  }

  dispose() {
    for (const m of this.meshes.values()) m.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.meshes.clear();
    this.materials.clear();
  }

  private applyPose(id: string) {
    const mesh = this.meshes.get(id);
    const t = this.previews.get(id) ?? this.doc?.entities[id]?.transform;
    if (!mesh || !t) return;
    mesh.position.set(...t.position);
    mesh.rotationQuaternion!.set(...t.rotation);
  }

  private refreshHighlights() {
    for (const [id, m] of this.meshes) {
      m.renderOutline = id === this.selected;
      m.renderOverlay = id === this.hovered && id !== this.selected;
    }
  }

  private material(partDefId: string) {
    let m = this.materials.get(partDefId);
    if (!m) {
      m = new StandardMaterial(`part:${partDefId}`, this.scene);
      m.diffuseColor = new Color3(0.85, 0.55, 0.2);
      m.specularColor = new Color3(0.1, 0.1, 0.1);
      this.materials.set(partDefId, m);
    }
    return m;
  }
}
