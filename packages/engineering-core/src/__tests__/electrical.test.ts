import { describe, expect, it } from 'vitest';
import { devicePins } from '../electrical/devices';
import { defaultElectricalDefinition, type ElectricalPart } from '../electrical/schemas';
import { parseProjectFile, serializeProject } from '../project/file';
import { makeEngine } from './helpers';

const resistor = (id: string, label: string, x = 0): ElectricalPart => ({
  id,
  label,
  name: `Resistor ${label}`,
  device: { type: 'resistor', resistanceOhm: 1000, powerRatingW: null },
  definitionId: null,
  nodeId: null,
  schematic: { x, y: 0, rotation: 0 },
  note: '',
});

const circuit = (engine: ReturnType<typeof makeEngine>['engine']) => {
  const r = engine.getProject().scene.nodes[engine.getProject().scene.rootId]!;
  return r.kind === 'root' ? r.electrical : undefined;
};

describe('electrical definition (Phase 6 commands)', () => {
  it('creates a circuit, adds parts and wires, and undo/redo restores each step exactly', () => {
    const { engine, run, state } = makeEngine();
    const s0 = state();
    expect(run('electrical.circuit.create', {}).ok).toBe(true);
    expect(run('electrical.part.add', { part: resistor('r1', 'R1') }).ok).toBe(true);
    expect(run('electrical.part.add', { part: resistor('r2', 'R2', 10) }).ok).toBe(true);
    const s1 = state();
    const wire = {
      id: 'w1',
      a: { partId: 'r1', pin: 'p2' },
      b: { partId: 'r2', pin: 'p1' },
      route: [],
      color: null,
    };
    expect(run('electrical.wire.add', { wire }).ok).toBe(true);
    expect(circuit(engine)!.wires).toHaveLength(1);
    engine.undo();
    expect(state()).toBe(s1);
    engine.redo();
    expect(circuit(engine)!.wires).toHaveLength(1);
    // Removing a part removes its wires in the same undoable step.
    expect(run('electrical.part.remove', { partId: 'r1' }).ok).toBe(true);
    expect(circuit(engine)!.wires).toHaveLength(0);
    engine.undo();
    expect(circuit(engine)!.wires).toHaveLength(1);
    for (let i = 0; i < 5; i++) engine.undo();
    expect(state()).toBe(s0);
  });

  it('rejects invalid data without changing anything', () => {
    const { run, state } = makeEngine();
    run('electrical.circuit.create', {});
    run('electrical.part.add', { part: resistor('r1', 'R1') });
    const before = state();
    // Unknown pin, unknown part, duplicate designator, negative resistance, self-wire.
    expect(
      run('electrical.wire.add', {
        wire: {
          id: 'w',
          a: { partId: 'r1', pin: 'x' },
          b: { partId: 'r1', pin: 'p1' },
          route: [],
          color: null,
        },
      }).ok,
    ).toBe(false);
    expect(
      run('electrical.wire.add', {
        wire: {
          id: 'w',
          a: { partId: 'nope', pin: 'p1' },
          b: { partId: 'r1', pin: 'p1' },
          route: [],
          color: null,
        },
      }).ok,
    ).toBe(false);
    expect(
      run('electrical.wire.add', {
        wire: {
          id: 'w',
          a: { partId: 'r1', pin: 'p1' },
          b: { partId: 'r1', pin: 'p1' },
          route: [],
          color: null,
        },
      }).ok,
    ).toBe(false);
    expect(run('electrical.part.add', { part: resistor('r9', 'R1') }).ok).toBe(false);
    expect(
      run('electrical.part.add', {
        part: {
          ...resistor('r3', 'R3'),
          device: { type: 'resistor', resistanceOhm: -5, powerRatingW: null },
        },
      }).ok,
    ).toBe(false);
    // A part may only be linked to a placed component of its own catalogue definition.
    expect(
      run('electrical.part.add', {
        part: { ...resistor('r4', 'R4'), definitionId: 'resistor-axial', nodeId: 'nope' },
      }).ok,
    ).toBe(false);
    expect(state()).toBe(before);
  });

  it('refuses a device change that would leave wires on pins that no longer exist', () => {
    const { run } = makeEngine();
    run('electrical.circuit.create', {});
    const gate = (inputs: number): ElectricalPart => ({
      ...resistor('g1', 'X1'),
      device: { type: 'logic-gate', op: 'and', inputs, delayNs: 10, logicV: 5 },
    });
    run('electrical.part.add', { part: gate(3) });
    run('electrical.part.add', { part: resistor('r1', 'R1') });
    run('electrical.wire.add', {
      wire: {
        id: 'w1',
        a: { partId: 'g1', pin: 'in3' },
        b: { partId: 'r1', pin: 'p1' },
        route: [],
        color: null,
      },
    });
    const r = run('electrical.part.update', { partId: 'g1', patch: { device: gate(2).device } });
    expect(r.ok).toBe(false);
    expect(run('electrical.part.update', { partId: 'g1', patch: { device: gate(4).device } }).ok).toBe(true);
  });

  it('firmware revisions increment and survive save/reload (schema v6); v5 files load without a circuit', () => {
    const { engine, run } = makeEngine();
    run('electrical.circuit.create', {});
    run('electrical.firmware.set', {
      firmware: {
        id: 'fw',
        name: 'Sketch',
        language: 'arduino-subset',
        source: 'void setup(){}\nvoid loop(){}',
      },
    });
    run('electrical.firmware.set', {
      firmware: {
        id: 'fw',
        name: 'Sketch',
        language: 'arduino-subset',
        source: 'void setup(){}\nvoid loop(){ }',
      },
    });
    expect(circuit(engine)!.firmware[0]!.revision).toBe(2);
    const text = serializeProject(engine.getProject());
    const back = parseProjectFile(text);
    if (!back.ok) throw new Error(back.error.message);
    const root = back.project.scene.nodes[back.project.scene.rootId]!;
    expect(root.kind === 'root' && root.electrical?.firmware[0]?.source).toContain('loop(){ }');
    const v5 = JSON.parse(text);
    v5.schemaVersion = 5;
    delete v5.scene.nodes[v5.scene.rootId].electrical;
    expect(parseProjectFile(JSON.stringify(v5))).toMatchObject({ ok: true, migratedFrom: 5 });
    // A corrupt circuit is rejected as a whole.
    const bad = JSON.parse(text);
    bad.scene.nodes[bad.scene.rootId].electrical.firmware[0].language = 'python';
    expect(parseProjectFile(JSON.stringify(bad)).ok).toBe(false);
  });

  it('import keeps 3D links only when they resolve in this project', () => {
    const { engine, run } = makeEngine();
    const def = defaultElectricalDefinition('Imported');
    def.parts.push({ ...resistor('r1', 'R1'), definitionId: 'resistor-axial', nodeId: 'not-here' });
    expect(run('electrical.circuit.import', { definition: def }).ok).toBe(true);
    expect(circuit(engine)!.parts[0]!.nodeId).toBeNull();
  });

  it('device pin tables: UNO GND pins share one terminal; gate pins follow the input count', () => {
    const uno = devicePins({ type: 'mcu' });
    expect(uno.filter((p) => p.terminal === 'GND').map((p) => p.id)).toEqual(['GND.1', 'GND.2', 'GND.3']);
    expect(uno.filter((p) => p.role === 'pwm').map((p) => p.id)).toEqual([
      'D3',
      'D5',
      'D6',
      'D9',
      'D10',
      'D11',
    ]);
    expect(devicePins({ type: 'logic-gate', inputs: 3 }).map((p) => p.id)).toEqual([
      'in1',
      'in2',
      'in3',
      'out',
    ]);
  });
});
