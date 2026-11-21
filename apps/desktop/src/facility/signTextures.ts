import type { SignSpec } from '@forge/facility';
import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';

/**
 * Sign textures rasterised locally into CanvasTextures (system font stack — no remote
 * fonts or images, CSP-safe). Zone-specific GPU resources: reference-counted by content
 * and disposed when the last sign using them unmounts (i.e. when the owning zone unloads).
 */
const FONT = '-apple-system, "Segoe UI", system-ui, Roboto, Helvetica, Arial, sans-serif';
const PX_PER_M = 320;

interface Entry {
  texture: CanvasTexture;
  material: MeshBasicMaterial;
  refs: number;
  bytes: number;
}
const textures = new Map<string, Entry>();
export const unitPlane = new PlaneGeometry(1, 1); // shared for the app's lifetime (one tiny buffer)

function drawSign(spec: SignSpec): { canvas: HTMLCanvasElement; bytes: number } {
  const [w, h] = spec.size;
  const cw = Math.round(Math.min(2048, Math.max(512, w * PX_PER_M)));
  const ch = Math.round((cw * h) / w);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#2a2f35';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#9aa3ad';
    ctx.fillRect(0, 0, Math.round(ch * 0.06), ch); // aluminium edge strip
    const pad = ch * 0.14;
    const lines = spec.lines.filter(Boolean);
    const weights = lines.map((_, i) => (i === 0 ? 1 : 0.62));
    const total = weights.reduce((a, b) => a + b, 0);
    let y = pad;
    lines.forEach((text, i) => {
      const band = ((ch - 2 * pad) * weights[i]!) / total;
      let size = band * 0.78;
      ctx.font = `${i === 0 ? 650 : 450} ${size}px ${FONT}`;
      const maxW = cw - pad * 2 - ch * 0.06;
      const m = ctx.measureText(text).width;
      if (m > maxW) {
        size *= maxW / m;
        ctx.font = `${i === 0 ? 650 : 450} ${size}px ${FONT}`;
      }
      ctx.fillStyle = i === 0 ? '#f4f6f8' : '#c3cad2';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, pad + ch * 0.06, y + band / 2);
      y += band;
    });
  }
  return { canvas, bytes: Math.round(cw * ch * 4 * (4 / 3)) }; // RGBA8 + mip chain
}

export function acquireSign(spec: SignSpec): Entry {
  const key = `${spec.size.join('x')}|${spec.lines.join('\n')}`;
  let e = textures.get(key);
  if (!e) {
    const { canvas, bytes } = drawSign(spec);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.anisotropy = 4;
    e = { texture, material: new MeshBasicMaterial({ map: texture, toneMapped: false }), refs: 0, bytes };
    textures.set(key, e);
  }
  e.refs += 1;
  return e;
}
export function releaseSign(spec: SignSpec) {
  const key = `${spec.size.join('x')}|${spec.lines.join('\n')}`;
  const e = textures.get(key);
  if (!e) return;
  e.refs -= 1;
  if (e.refs <= 0) {
    e.texture.dispose();
    e.material.dispose();
    textures.delete(key);
  }
}

/** Live sign textures (diagnostics): count and estimated GPU bytes. */
export function signTextureStats() {
  let bytes = 0;
  let refs = 0;
  for (const e of textures.values()) {
    bytes += e.bytes;
    refs += e.refs;
  }
  return { textures: textures.size, refs, estimatedBytes: bytes };
}
