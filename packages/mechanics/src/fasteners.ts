import type { ComponentInterface } from '@forge/components';

/**
 * Fastener compatibility checks for supported families (ISO metric screws, bolts, nuts,
 * washers) against declared hole interfaces. Geometric/dimensional checks only:
 * NO thread stress, preload, fatigue or torque rating is computed or implied.
 */
export interface FastenerCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const designation = (tags: readonly string[]) => {
  for (const t of tags) {
    const m = /^(M\d+(?:\.\d+)?)-(thread|clearance|tapped)$/.exec(t);
    if (m) return { size: m[1]!, kind: m[2]! as 'thread' | 'clearance' | 'tapped' };
  }
  return null;
};
const nominalMm = (size: string) => Number(size.slice(1));

/**
 * @param screw   the fastener's thread interface (e.g. machine-screw 'thread': M3-thread)
 * @param hole    the receiving interface (clearance hole, tapped hole or nut thread)
 * @param lengthM fastener length under head (m), when known
 * @param gripM   total clamped thickness (+ nut height when bolted) the fastener must pass, when known
 */
export function checkFastener(
  screw: ComponentInterface,
  hole: ComponentInterface,
  lengthM: number | null,
  gripM: number | null,
): FastenerCheck[] {
  const s = designation(screw.compatibility);
  const h = designation(hole.compatibility);
  const out: FastenerCheck[] = [];
  if (!s)
    return [
      {
        name: 'Thread designation',
        ok: false,
        detail: `"${screw.name}" declares no metric thread designation.`,
      },
    ];
  if (!h)
    return [
      {
        name: 'Hole designation',
        ok: false,
        detail: `"${hole.name}" declares no metric hole size (${hole.compatibility.join(', ')}).`,
      },
    ];
  out.push({
    name: 'Nominal diameter',
    ok: s.size === h.size,
    detail:
      s.size === h.size
        ? `${s.size} fastener into ${h.size} ${h.kind} interface.`
        : `${s.size} fastener does not match the ${h.size} ${h.kind} interface.`,
  });
  out.push({
    name: 'Hole type',
    ok: true,
    detail:
      h.kind === 'clearance'
        ? 'Clearance hole: needs a nut or a tapped part beyond it.'
        : h.kind === 'tapped' || h.kind === 'thread'
          ? 'Threaded engagement (thread form not modelled).'
          : '',
  });
  if (lengthM !== null && gripM !== null) {
    const engage = h.kind === 'clearance' ? 0 : nominalMm(s.size) / 1000; // ≥ 1×d engagement into a tapped part (rule of thumb)
    const need = gripM + engage;
    out.push({
      name: 'Length suitability',
      ok: lengthM >= need - 1e-9,
      detail: `${(lengthM * 1000).toFixed(1)} mm available vs ${(need * 1000).toFixed(1)} mm needed (grip ${(gripM * 1000).toFixed(1)} mm${engage ? ` + ${(engage * 1000).toFixed(1)} mm engagement — rule of thumb, not a strength check` : ''}).`,
    });
  }
  out.push({ name: 'Axis alignment', ok: true, detail: 'Aligned by the mate (concentric/axial).' });
  return out;
}
