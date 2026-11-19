import { describe, expect, it } from 'vitest';
import { AVAILABLE_COMMANDS, COMMAND_CONTRACTS } from './index';

describe('Vey command contracts (Phase 0)', () => {
  it('documents the ten proposed operations, all marked proposed', () => {
    expect(COMMAND_CONTRACTS.map((c) => c.name)).toEqual([
      'project.create',
      'project.open',
      'project.save',
      'scene.inspect',
      'component.search',
      'component.conjure',
      'component.transform',
      'assembly.create',
      'simulation.run',
      'experiment.results',
    ]);
    expect(COMMAND_CONTRACTS.every((c) => c.implementationStatus === 'proposed')).toBe(true);
  });

  it('exposes no callable commands in Phase 0', () => {
    expect(AVAILABLE_COMMANDS).toHaveLength(0);
  });

  it('requires confirmation for every destructive or compute operation', () => {
    for (const c of COMMAND_CONTRACTS) {
      if (c.permission === 'destructive' || c.permission === 'compute')
        expect(c.requiresConfirmation, c.name).toBe(true);
    }
  });
});
