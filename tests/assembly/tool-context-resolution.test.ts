/**
 * @module Tests.Assembly
 * ToolContext resolution from callerType at assembly time (phase 1337 sub-2)
 */

import { describe, it, expect } from 'vitest';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';

describe('ToolContext assembly resolution', () => {

  it('ExecContextImpl constructor accepts callerLabel', () => {
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      syncDir: '/tmp/test/sync',
      profile: 'subagent',
      fs: {} as import('../../src/foundation/fs/types.js').FileSystem,
      maxSteps: 10,
      callerLabel: 'subagent',
    });
    expect(ctx.callerLabel).toBe('subagent');
  });
});
