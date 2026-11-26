import type { Project } from '@forge/engineering-core';
import { conversion } from '@forge/research';
import type { ChannelInfo } from './pipeline';
import type { ChannelMapping, Twin } from './schemas';

/**
 * Validation of model ↔ device mappings against the PROJECT and the device's DECLARED
 * channels. Incorrect units (dimension mismatch), a commanded channel mapped as measured,
 * missing components or a joint of the wrong type are errors: such a mapping would make the
 * virtual representation lie.
 */
export interface MappingIssue {
  severity: 'error' | 'warning';
  channel: string;
  message: string;
}

export function validateMappings(
  twin: Twin,
  project: Project,
  declared: ReadonlyMap<string, ChannelInfo> | null,
): MappingIssue[] {
  const out: MappingIssue[] = [];
  const e = (channel: string, message: string) => out.push({ severity: 'error', channel, message });
  const w = (channel: string, message: string) => out.push({ severity: 'warning', channel, message });
  const mates = new Map<string, string>();
  for (const n of Object.values(project.scene.nodes))
    if (n.kind === 'assembly') for (const m of n.mechanical.mates) mates.set(m.id, m.type);
  const root = project.scene.nodes[project.scene.rootId];
  const parts = root?.kind === 'root' ? (root.electrical?.parts ?? []) : [];
  const seen = new Set<string>();
  for (const m of twin.channels) {
    if (seen.has(m.channel)) e(m.channel, 'Channel mapped twice.');
    seen.add(m.channel);
    if (conversion(m.deviceUnit, m.modelUnit) === null)
      e(m.channel, `Unit "${m.deviceUnit}" cannot be converted to "${m.modelUnit}" (different dimensions).`);
    const d = declared?.get(m.channel);
    if (declared && !d) w(m.channel, 'The device has not declared this channel.');
    if (d && d.unit !== m.deviceUnit)
      e(m.channel, `The device declares unit "${d.unit}", the mapping assumes "${m.deviceUnit}".`);
    if (d && d.kind !== m.kind)
      e(m.channel, `The device declares this channel ${d.kind}; it cannot be mapped as ${m.kind}.`);
    if (m.target.kind === 'joint') {
      const type = mates.get(m.target.mateId);
      if (!type) e(m.channel, `Joint "${m.target.mateId}" does not exist in the project.`);
      else if (type === 'revolute' && conversion(m.modelUnit, 'rad') === null)
        e(m.channel, `Revolute joint values must be angles (got ${m.modelUnit}).`);
      else if (type === 'prismatic' && conversion(m.modelUnit, 'm') === null)
        e(m.channel, `Prismatic joint values must be lengths (got ${m.modelUnit}).`);
      else if (type !== 'revolute' && type !== 'prismatic')
        e(
          m.channel,
          `Joint "${m.target.mateId}" is ${type}; only revolute and prismatic joints take a single value.`,
        );
    }
    if (m.target.kind === 'sensor') {
      const partId = m.target.partId;
      const p = parts.find((x) => x.id === partId);
      if (!p) e(m.channel, `Circuit part "${m.target.partId}" does not exist.`);
      else if (p.device.type !== 'hc-sr04')
        e(m.channel, `Part "${p.id}" is a ${p.device.type}, not a distance sensor.`);
      if (conversion(m.modelUnit, 'm') === null) e(m.channel, 'Distances must be lengths.');
    }
  }
  return out;
}

/** Device value → model value: unit conversion, then the mapping's linear calibration. */
export function toModel(m: ChannelMapping, value: number): number {
  const k = conversion(m.deviceUnit, m.modelUnit) ?? NaN;
  return m.calibration.gain * value * k + m.calibration.offset;
}
