/**
 * Single entry point for Babylon VALUE imports, using per-module paths so the
 * bundle contains only what the workshop uses (importing the package root pulls
 * in the whole engine: ~6.9 MB minified). Type-only imports may still use
 * '@babylonjs/core' because they are erased at build time.
 *
 * Side-effect modules required by features we use:
 *   - Culling/ray: scene.pick / pickWithRay / createPickingRay
 *   - Rendering/outlineRenderer: mesh.renderOutline (selection highlight)
 */
import '@babylonjs/core/Culling/ray';
import '@babylonjs/core/Rendering/outlineRenderer';

export { Engine } from '@babylonjs/core/Engines/engine';
export { Scene } from '@babylonjs/core/scene';
export { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
export { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
export { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
export { Ray } from '@babylonjs/core/Culling/ray';
export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
export { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
export { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
export { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
export { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
export { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
export { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
export { WebXRDefaultExperience } from '@babylonjs/core/XR/webXRDefaultExperience';
export { WebXRState } from '@babylonjs/core/XR/webXRTypes';

export { AdvancedDynamicTexture } from '@babylonjs/gui/2D/advancedDynamicTexture';
export { Button } from '@babylonjs/gui/2D/controls/button';
export { Control } from '@babylonjs/gui/2D/controls/control';
export { StackPanel } from '@babylonjs/gui/2D/controls/stackPanel';
export { TextBlock } from '@babylonjs/gui/2D/controls/textBlock';
