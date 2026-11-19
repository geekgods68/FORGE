import { WebXRDefaultExperience } from '../render/babylon';
import type { Scene } from '@babylonjs/core';

/**
 * Creates the Babylon WebXR helper with every default that would fetch remote
 * assets switched off (verified in @babylonjs/core 9.37.0 sources):
 *   - default enter/exit UI (loads cdn.babylonjs.com/Assets/vrButton.png)
 *   - controller meshes (controllers.babylonjs.com)
 *   - online input-profile repository (immersive-web.github.io)
 *   - hand tracking meshes (assets.babylonjs.com)
 * Teleportation and near interaction are disabled: W0.1 is seated/stationary.
 * Pointer selection (laser + trigger) stays on; it is procedural.
 */
export async function createXr(scene: Scene): Promise<WebXRDefaultExperience> {
  return WebXRDefaultExperience.CreateAsync(scene, {
    disableDefaultUI: true,
    disableTeleportation: true,
    disableNearInteraction: true,
    disableHandTracking: true,
    optionalFeatures: false,
    inputOptions: {
      doNotLoadControllerMeshes: true,
      disableOnlineControllerRepository: true,
    },
  });
}
