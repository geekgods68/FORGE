import { ArcRotateCamera, Color4, Engine, Matrix, Scene, Vector3, WebXRState } from './render/babylon';
import type { WebXRDefaultExperience } from '@babylonjs/core';
import { makeEnvelope, type Command } from './commands/commands';
import { WorkshopStore } from './commands/store';
import { InteractionController } from './interaction/controller';
import type { InputSourceInfo, Intent } from './interaction/intents';
import { DesktopAdapter } from './input/desktop';
import { XrControllerAdapter } from './input/xrControllers';
import { CATALOG, formatMm } from './model/catalog';
import { BENCH, initialDocument } from './model/fixture';
import { yawDegrees } from './model/math';
import { EntityView } from './render/entityView';
import { buildRoom } from './render/room';
import { WallPanel } from './render/wallPanel';
import { canEnter, detectXrSupport, status, type XrStatus } from './xr/readiness';
import { createXr } from './xr/xrSetup';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const overlayStatus = document.getElementById('xr-status')!;
const enterButton = document.getElementById('enter-vr') as HTMLButtonElement;

const engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, true);
const scene = new Scene(engine);
scene.useRightHandedSystem = true; // match WebXR / document convention: right-handed, +Y up, -Z forward
scene.clearColor = new Color4(0.06, 0.07, 0.09, 1);

// Desktop debugging camera: seated eye position looking at the bench. View state only.
// Default ≈ seated eye (y ≈ 1.35 m) behind the origin, seeing both bench and wall panel.
const camera = new ArcRotateCamera('desk-cam', Math.PI / 2, 1.4, 1.9, new Vector3(0, 1.05, BENCH.centerZ - 0.25), scene);
camera.minZ = 0.01;
camera.lowerRadiusLimit = 0.35;
camera.upperRadiusLimit = 4;
camera.wheelDeltaPercentage = 0.01;
camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
const pointers = camera.inputs.attached.pointers as unknown as { buttons: number[] } | undefined;
if (pointers) pointers.buttons = [2]; // right mouse orbits; left mouse is for interaction
camera.attachControl(canvas, true);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const room = buildRoom(scene);
room.panelMesh.metadata = { ui: true };

const store = new WorkshopStore(initialDocument());
const view = new EntityView(scene);
view.sync(store.document);
const ctl = new InteractionController(store, view);

let xr: WebXRDefaultExperience | null = null;
let xrAdapter: XrControllerAdapter | null = null;
let xrStatus: XrStatus = status('checking');
const inXr = () => xrStatus.state === 'in-xr' || xrStatus.state === 'entering' || xrStatus.state === 'exiting';

const UI: InputSourceInfo = { id: 'ui:wall-panel', type: 'in-world-ui', handedness: 'none' };
const emit = (i: Intent) => {
  ctl.handle(i);
  refreshPanel();
};

const panel = new WallPanel(room.panelMesh, {
  undo: () => emit({ kind: 'undo', source: UI, time: performance.now() }),
  redo: () => emit({ kind: 'redo', source: UI, time: performance.now() }),
  reset: () => emit({ kind: 'reset', source: UI, time: performance.now() }),
  exitXr: () => void xr?.baseExperience.exitXRAsync(),
});

function refreshPanel() {
  const doc = store.document;
  const id = ctl.selectedId ?? Object.keys(doc.entities)[0];
  const e = id ? doc.entities[id] : undefined;
  const partLines: string[] = [];
  if (e) {
    const def = CATALOG[e.partDefId]!;
    const [w, h, d] = def.dimensionsM;
    const [x, y, z] = e.transform.position;
    partLines.push(
      `${ctl.selectedId ? 'Selected' : 'Part'}: ${e.name}  [${def.inventory.toUpperCase()} · fidelity: ${def.fidelity}]`,
      `Declared size ${formatMm(w)} × ${formatMm(h)} × ${formatMm(d)} (${def.dimensionStatus})`,
      `Position x ${formatMm(x)}  y ${formatMm(y)}  z ${formatMm(z)}  ·  yaw ${yawDegrees(e.transform.rotation).toFixed(0)}°`,
      ctl.activeGrab ? `Grabbing with ${ctl.activeGrab.source.type} (${ctl.activeGrab.source.handedness})` : 'Not grabbed',
    );
  }
  panel.update({
    xrStatus: xrStatus.message,
    partLines,
    historyLine: `Revision ${doc.revision} · undo ${store.undoDepth}${store.lastUndoLabel ? ` (last: ${store.lastUndoLabel})` : ''} · redo ${store.redoDepth}`,
    lastEvent: ctl.lastEvent ? `Last: ${ctl.lastEvent.kind} — ${ctl.lastEvent.detail}` : 'Last: —',
    diagnostics: diagText,
    canUndo: store.canUndo && !ctl.activeGrab,
    canRedo: store.canRedo && !ctl.activeGrab,
    inXr: xrStatus.state === 'in-xr',
  });
}

store.subscribe((doc) => {
  view.sync(doc);
  refreshPanel();
});
ctl.onEvent = () => refreshPanel();

new DesktopAdapter(scene, camera, view, emit, inXr);

function setXrStatus(s: XrStatus) {
  xrStatus = s;
  overlayStatus.textContent = s.message;
  overlayStatus.dataset.state = s.state;
  enterButton.disabled = !canEnter(s.state);
  refreshPanel();
}

enterButton.addEventListener('click', async () => {
  if (!xr || !canEnter(xrStatus.state)) return;
  setXrStatus(status('entering'));
  try {
    await xr.baseExperience.enterXRAsync('immersive-vr', 'local-floor');
  } catch (e) {
    setXrStatus(status('error', `Could not enter VR: ${e instanceof Error ? e.message : String(e)}`));
  }
});

async function initXr() {
  const detected = await detectXrSupport({ isSecureContext: window.isSecureContext, xr: navigator.xr });
  if (detected.state !== 'ready') return setXrStatus(detected);
  try {
    xr = await createXr(scene);
  } catch (e) {
    return setXrStatus(status('error', `XR setup failed: ${e instanceof Error ? e.message : String(e)}`));
  }
  xrAdapter = new XrControllerAdapter(xr, scene, view, emit);
  // System menu / Meta button usually hides the session ('visible-blurred' or 'hidden')
  // rather than ending it. Never keep a grab alive across that.
  xr.baseExperience.sessionManager.onXRSessionInit.add((session) => {
    session.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible') {
        ctl.cancelGrab(`xr session ${session.visibilityState}`);
        refreshPanel();
      }
    });
  });
  xr.baseExperience.onStateChangedObservable.add((s) => {
    if (s === WebXRState.ENTERING_XR) setXrStatus(status('entering'));
    else if (s === WebXRState.IN_XR) setXrStatus(status('in-xr'));
    else if (s === WebXRState.EXITING_XR) {
      ctl.cancelGrab('xr session ending');
      xrAdapter?.releaseAll('xr session ended');
      setXrStatus(status('exiting'));
    } else if (s === WebXRState.NOT_IN_XR) {
      ctl.cancelGrab('xr session ended');
      xrAdapter?.releaseAll('xr session ended');
      view.sync(store.document); // idempotent: re-entry never duplicates meshes
      setXrStatus(status('ready'));
    }
  });
  setXrStatus(status('ready'));
}

// Diagnostics: rAF-cadence proxy only. NOT headset latency or GPU time.
let diagText = 'Frame interval: measuring…';
{
  const samples: number[] = [];
  let last = 0;
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (last) {
      samples.push(now - last);
      if (samples.length > 240) samples.shift();
    }
    last = now;
  });
  setInterval(() => {
    if (!samples.length) return;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const max = Math.max(...samples);
    diagText = `Frame interval (rAF proxy, not headset latency): mean ${mean.toFixed(1)} ms · max ${max.toFixed(1)} ms · meshes ${scene.meshes.length}`;
    panel.setDiagnostics(diagText);
  }, 1000);
}

engine.runRenderLoop(() => scene.render());
addEventListener('resize', () => engine.resize());
refreshPanel();
void initXr();

// ---- Local debug/test hook (same validated dispatcher as every other path) ----
const debugApi = {
  get document() {
    return store.document;
  },
  get undoDepth() {
    return store.undoDepth;
  },
  get redoDepth() {
    return store.redoDepth;
  },
  get selectedId() {
    return ctl.selectedId;
  },
  get activeGrab() {
    return ctl.activeGrab;
  },
  get xrState() {
    return xrStatus.state;
  },
  dispatchScripted(commands: Command[], expectedRevision = store.document.revision) {
    return store.dispatch(makeEnvelope(commands, { label: 'Scripted edit', expectedRevision, source: 'script', requestedBy: 'local-script' }));
  },
  undo: () => store.undo(),
  meshCountFor(id: string) {
    return scene.meshes.filter((m) => m.metadata?.entityId === id).length;
  },
  /** CSS-pixel client coordinates of an entity's world position (for tests). */
  entityClientPoint(id: string) {
    const p = view.worldPose(id).position;
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const s = Vector3.Project(p, Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(w, h));
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + (s.x * rect.width) / w, y: rect.top + (s.y * rect.height) / h };
  },
  ready: true,
};
(window as unknown as { __workshop: typeof debugApi }).__workshop = debugApi;
