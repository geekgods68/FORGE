import type { ElectricalDefinition } from '@forge/engineering-core';
import { buildElements } from '../analog/build';
import { AnalogCircuit } from '../analog/circuit';
import { compileNetlist } from '../netlist';
import { attachLogicDevices } from './devices';
import { SignalNetwork } from './network';
import { Scheduler } from './scheduler';

/** Digital (+ quasi-static analog) simulation of a circuit without firmware or physics. */
export function createDigitalSim(def: ElectricalDefinition, opts: { maxTransitions?: number } = {}) {
  const netlist = compileNetlist(def);
  const sched = new Scheduler();
  const net = new SignalNetwork(
    def,
    netlist,
    sched,
    (o) => new AnalogCircuit(netlist, buildElements(def, netlist, o), def.settings).dc(),
    { maxTransitions: opts.maxTransitions ?? def.settings.cosim.recording.maxTransitions },
  );
  const cleanups = attachLogicDevices(def, net, sched);
  net.start();
  return {
    netlist,
    sched,
    net,
    /** Advance simulated time to tNs (inclusive). */
    runTo: (tNs: number) => sched.runUntil(tNs),
    dispose: () => cleanups.forEach((c) => c()),
  };
}
