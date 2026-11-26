import { describe, expect, it } from 'vitest';
import { AVAILABLE_COMMANDS, COMMAND_CONTRACTS } from './index';

describe('Vey command contracts (Phase 0)', () => {
  it('documents the proposed operations (ten from Phase 0, six from Phase 8), all marked proposed', () => {
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
      'interop.capabilities',
      'interop.assets',
      'interop.import',
      'interop.export',
      'twin.state',
      'twin.recordings',
    ]);
    expect(COMMAND_CONTRACTS.every((c) => c.implementationStatus === 'proposed')).toBe(true);
  });

  it('offers no contract that could actuate hardware', () => {
    expect(COMMAND_CONTRACTS.some((c) => /actuat|device\.(command|write)|servo/i.test(c.name))).toBe(false);
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
