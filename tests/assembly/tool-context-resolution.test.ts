/**
 * @module Tests.Assembly
 * ToolContext resolution at assembly time (phase 1337 sub-2 / phase 807)
 */

import { describe, it, expect } from 'vitest';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import type { ToolPermissions } from '../../src/foundation/tools/types.js';

describe('ToolContext assembly resolution', () => {

  it('ExecContextImpl constructor does NOT accept callerLabel', () => {
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      syncDir: '/tmp/test/sync',
      profile: 'subagent',
      fs: {} as import('../../src/foundation/fs/types.js').FileSystem,
      maxSteps: 10,
    });
    expect(ctx.clawId).toBe('test-claw');
    // @ts-expect-error callerLabel was removed in phase 807
    expect(ctx.callerLabel).toBeUndefined();
  });

  it('ToolPermissions no longer contains callerLabel', () => {
    const perm: ToolPermissions = { profile: 'full' };
    expect(perm).not.toHaveProperty('callerLabel');
  });
});
