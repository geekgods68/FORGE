import type { ComponentInterface, InterfaceType } from './schemas';

/**
 * Connection compatibility FOUNDATION (Phase 3). Compatibility is decided only from
 * declared interface metadata — type pairing, gender and shared compatibility
 * descriptors — never from proximity. A positive result means "metadata says these
 * may mate", not that a joint/circuit is valid: mating solvers are Phase 4,
 * circuit simulation Phase 6.
 */
const PAIRS: Partial<Record<InterfaceType, InterfaceType[]>> = {
  'mechanical-mount': ['mechanical-mount', 'bolt-hole'],
  'bolt-hole': ['bolt-hole', 'mechanical-mount'],
  'shaft-coupling': ['shaft-coupling', 'revolute-joint'],
  'revolute-joint': ['revolute-joint', 'shaft-coupling'],
  slider: ['slider', 'mechanical-mount'],
  'electrical-terminal': ['electrical-terminal', 'gpio-pin', 'power-terminal'],
  'gpio-pin': ['gpio-pin', 'electrical-terminal'],
  'power-terminal': ['power-terminal', 'electrical-terminal'],
  'data-connector': ['data-connector'],
  'fluid-port': ['fluid-port'],
  'optical-interface': ['optical-interface'],
};

export interface Compatibility {
  compatible: boolean;
  reasons: string[];
  /** Descriptors both sides declare. */
  shared: string[];
}

export function checkCompatibility(a: ComponentInterface, b: ComponentInterface): Compatibility {
  const reasons: string[] = [];
  const typeOk = PAIRS[a.type]?.includes(b.type) ?? false;
  if (!typeOk) reasons.push(`${a.type} cannot mate with ${b.type}.`);
  const genderOk = !(
    a.gender &&
    b.gender &&
    a.gender !== 'neutral' &&
    b.gender !== 'neutral' &&
    a.gender === b.gender
  );
  if (!genderOk) reasons.push(`Both sides are ${a.gender}.`);
  const shared = a.compatibility.filter((c) => b.compatibility.includes(c));
  if (shared.length === 0)
    reasons.push(
      `No shared compatibility descriptor (${a.compatibility.join(', ')} vs ${b.compatibility.join(', ')}).`,
    );
  const powerClash =
    a.signal &&
    b.signal &&
    /^(GND|V-)$/i.test(a.signal) !== /^(GND|V-)$/i.test(b.signal) &&
    a.type === 'power-terminal' &&
    b.type === 'power-terminal';
  if (powerClash) reasons.push(`Signal mismatch: ${a.signal} ↔ ${b.signal}.`);
  return { compatible: typeOk && genderOk && shared.length > 0 && !powerClash, reasons, shared };
}
