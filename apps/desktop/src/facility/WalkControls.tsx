import { getZone } from '@forge/facility';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Euler } from 'three';
import { useEditorStore } from '@/app/store';
import { collidersAround, EYE_HEIGHT, resolveMove, spawnFor, zoneAt } from './collision';

/**
 * First-person walking (facility view): WASD / arrow keys to move, mouse-look via pointer
 * lock (click the viewport) or by dragging, Shift to walk faster. Collision uses the
 * architecture + furnishing data of the current zone and its neighbours. Crossing into
 * another zone's footprint makes it the current zone, so the zone lifecycle loads it
 * (and releases what is no longer required) exactly as directory navigation does.
 * Escape — or releasing pointer lock — returns to the orbit/editor camera.
 * Camera-only: never issues engineering or workspace commands.
 */
const KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);
const WALK_SPEED = 1.4; // m/s
const FAST_SPEED = 3.0;
const TURN_SPEED = Math.PI / 2; // rad/s for arrow-key turning
const LOOK_SENSITIVITY = 0.0025; // rad per pixel
const MAX_PITCH = (80 * Math.PI) / 180;

export function WalkControls() {
  const store = useEditorStore();
  const { camera, gl } = useThree();
  const pressed = useRef(new Set<string>());
  const look = useRef({ yaw: 0, pitch: 0 });
  const pos = useRef({ x: 0, z: 0 });
  const dragging = useRef<{ x: number; y: number; moved: number } | null>(null);
  const locked = useRef(false);

  // Spawn just inside the current zone's door.
  useEffect(() => {
    const zone = getZone(store.getState().currentZoneId);
    if (!zone) return;
    const s = spawnFor(zone);
    pos.current = { x: s.x, z: s.z };
    look.current = { yaw: s.yaw, pitch: 0 };
    camera.position.set(s.x, EYE_HEIGHT, s.z);
    camera.rotation.copy(new Euler(0, s.yaw, 0, 'YXZ'));
  }, [camera, store]);

  useEffect(() => {
    const el = gl.domElement;
    const keyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (KEYS.has(k) && !e.metaKey && !e.ctrlKey) pressed.current.add(k);
    };
    const keyUp = (e: KeyboardEvent) => pressed.current.delete(e.key.toLowerCase());
    const blur = () => pressed.current.clear();
    const turn = (dx: number, dy: number) => {
      look.current.yaw -= dx * LOOK_SENSITIVITY;
      look.current.pitch = Math.max(
        -MAX_PITCH,
        Math.min(MAX_PITCH, look.current.pitch - dy * LOOK_SENSITIVITY),
      );
    };
    const down = (e: PointerEvent) => {
      if (e.button === 0) dragging.current = { x: e.clientX, y: e.clientY, moved: 0 };
    };
    const move = (e: PointerEvent) => {
      if (locked.current) return turn(e.movementX, e.movementY);
      const d = dragging.current;
      if (!d) return;
      turn(e.clientX - d.x, e.clientY - d.y);
      d.moved += Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y);
      d.x = e.clientX;
      d.y = e.clientY;
    };
    const up = () => {
      const d = dragging.current;
      dragging.current = null;
      // A plain click (no drag) captures the mouse for continuous look, if the browser allows it.
      if (d && d.moved < 4 && !locked.current) {
        try {
          const r = el.requestPointerLock() as unknown as Promise<void> | undefined;
          r?.catch?.(() => {});
        } catch {
          /* pointer lock unavailable: drag-to-look still works */
        }
      }
    };
    const lockChange = () => {
      const now = document.pointerLockElement === el;
      // Escape releases pointer lock in the browser itself: treat that as "leave walking".
      if (locked.current && !now) store.getState().setNavMode('orbit');
      locked.current = now;
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.addEventListener('pointerlockchange', lockChange);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.removeEventListener('pointerlockchange', lockChange);
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [gl, store]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1); // clamp: no tunnelling after a stalled frame
    const k = pressed.current;
    if (k.has('arrowleft')) look.current.yaw += TURN_SPEED * dt;
    if (k.has('arrowright')) look.current.yaw -= TURN_SPEED * dt;
    const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const strafe = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    if (fwd || strafe) {
      const speed = (k.has('shift') ? FAST_SPEED : WALK_SPEED) * dt;
      const len = Math.hypot(fwd, strafe);
      const { yaw } = look.current;
      // Camera yaw 0 looks along −Z; right is +X.
      const dx = ((-Math.sin(yaw) * fwd + Math.cos(yaw) * strafe) / len) * speed;
      const dz = ((-Math.cos(yaw) * fwd - Math.sin(yaw) * strafe) / len) * speed;
      const current = store.getState().currentZoneId;
      const [nx, nz] = resolveMove(pos.current.x, pos.current.z, dx, dz, collidersAround(current));
      pos.current = { x: nx, z: nz };
      const here = zoneAt(nx, nz, current);
      if (here && here !== current) store.getState().setCurrentZone(here);
    }
    camera.position.set(pos.current.x, EYE_HEIGHT, pos.current.z);
    camera.rotation.set(look.current.pitch, look.current.yaw, 0, 'YXZ');
  });
  return null;
}
