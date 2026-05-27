/**
 * spawn-tool description accuracy — reverse test for phase 883 B2
 *
 * spawnTool.parameters.maxSteps.description must mention DEFAULT_MAX_STEPS
 * and must NOT contain the stale "default: 100" claim.
 */

import { describe, it, expect } from 'vitest';
import { spawnTool } from '../../../src/core/spawn-system/index.js';

describe('spawn-tool maxSteps description (phase 883 B2)', () => {
  it('description mentions DEFAULT_MAX_STEPS = 1000', () => {
    const desc = (spawnTool.schema.properties as any).maxSteps.description;
    expect(desc).toContain('DEFAULT_MAX_STEPS = 1000');
  });

  it('description does NOT contain stale "default: 100" claim', () => {
    const desc = (spawnTool.schema.properties as any).maxSteps.description;
    expect(desc).not.toContain('default: 100');
  });
});
