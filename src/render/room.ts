import { Color3, CreateBox, CreateGround, CreatePlane, DirectionalLight, HemisphericLight, StandardMaterial, Vector3 } from './babylon';
import type { Mesh, Scene } from '@babylonjs/core';
import { BENCH } from '../model/fixture';

/**
 * Static, original, procedural workshop shell. No textures, no downloads,
 * no shadows, no post-processing. Materials are shared and matte, with a single
 * restrained emissive accent colour.
 *
 * Layout (metres, user seated at origin facing -Z):
 *   bench centred at z = BENCH.centerZ, top at BENCH.topHeight
 *   wall panel on the back wall at z = -2.0, centre height 1.35 m
 */
export const PANEL = { z: -1.95, y: 1.35, width: 1.5, height: 0.86 };

export interface Room {
  staticMeshes: Mesh[];
  panelMesh: Mesh;
}

export function buildRoom(scene: Scene): Room {
  const mat = (name: string, rgb: [number, number, number], emissive?: [number, number, number]) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = new Color3(...rgb);
    m.specularColor = new Color3(0.04, 0.04, 0.05);
    if (emissive) m.emissiveColor = new Color3(...emissive);
    m.freeze();
    return m;
  };
  const floorMat = mat('floor', [0.16, 0.17, 0.19]);
  const wallMat = mat('wall', [0.25, 0.27, 0.3]);
  const benchTopMat = mat('benchTop', [0.42, 0.44, 0.46]);
  const frameMat = mat('frame', [0.12, 0.13, 0.15]);
  const accentMat = mat('accent', [0, 0, 0], [0.1, 0.65, 0.75]);
  const pegMat = mat('pegboard', [0.2, 0.22, 0.25]);

  const meshes: Mesh[] = [];
  const add = (m: Mesh, material: StandardMaterial) => {
    m.material = material;
    m.isPickable = false;
    m.freezeWorldMatrix();
    meshes.push(m);
    return m;
  };

  // Floor and three walls (open behind the user).
  const floor = CreateGround('floor', { width: 6, height: 6 }, scene);
  add(floor, floorMat);
  const back = CreateBox('wall-back', { width: 6, height: 3, depth: 0.05 }, scene);
  back.position.set(0, 1.5, -2.05);
  add(back, wallMat);
  for (const side of [-1, 1]) {
    const w = CreateBox(`wall-${side}`, { width: 0.05, height: 3, depth: 4 }, scene);
    w.position.set(side * 3, 1.5, -0.05);
    add(w, wallMat);
  }
  // Thin accent strips along the wall base (the only emissive elements in the room).
  const strip = CreateBox('accent-back', { width: 6, height: 0.02, depth: 0.01 }, scene);
  strip.position.set(0, 0.12, -2.02);
  add(strip, accentMat);

  // Bench.
  const top = CreateBox('bench-top', { width: BENCH.width, height: 0.04, depth: BENCH.depth }, scene);
  top.position.set(0, BENCH.topHeight - 0.02, BENCH.centerZ);
  add(top, benchTopMat);
  const edge = CreateBox('bench-edge', { width: BENCH.width, height: 0.008, depth: 0.004 }, scene);
  edge.position.set(0, BENCH.topHeight - 0.02, BENCH.centerZ + BENCH.depth / 2 + 0.002);
  add(edge, accentMat);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = CreateBox('bench-leg', { width: 0.05, height: BENCH.topHeight - 0.04, depth: 0.05 }, scene);
      leg.position.set(sx * (BENCH.width / 2 - 0.06), (BENCH.topHeight - 0.04) / 2, BENCH.centerZ + sz * (BENCH.depth / 2 - 0.06));
      add(leg, frameMat);
    }
  }
  // Low riser at the back of the bench. Kept short (0.15 m) so it never blocks the
  // wall panel from a seated eye height (~1.2 m); a 0.5 m pegboard did.
  const peg = CreateBox('bench-riser', { width: BENCH.width, height: 0.15, depth: 0.02 }, scene);
  peg.position.set(0, BENCH.topHeight + 0.075, BENCH.centerZ - BENCH.depth / 2 + 0.01);
  add(peg, pegMat);

  // Wall information panel (GUI texture is attached in wallPanel.ts).
  const panelFrame = CreateBox('panel-frame', { width: PANEL.width + 0.04, height: PANEL.height + 0.04, depth: 0.02 }, scene);
  panelFrame.position.set(0, PANEL.y, PANEL.z - 0.012);
  add(panelFrame, frameMat);
  const panelMesh = CreatePlane('wall-panel', { width: PANEL.width, height: PANEL.height }, scene);
  panelMesh.position.set(0, PANEL.y, PANEL.z);

  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.75;
  hemi.groundColor = new Color3(0.18, 0.18, 0.2);
  const sun = new DirectionalLight('key', new Vector3(-0.4, -1, -0.6), scene);
  sun.intensity = 0.45;

  return { staticMeshes: meshes, panelMesh };
}
