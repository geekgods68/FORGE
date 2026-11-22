import type { ElectricalDefinition } from '@forge/engineering-core';

/** Firmware editor (Milestone D). */
export function CodeTab({ def }: { def: ElectricalDefinition | null }) {
  return <p className="text-xs text-muted-foreground">{def?.firmware.length ?? 0} firmware source(s).</p>;
}
