/**
 * @module Tests.Assembly
 * ToolContext resolution from callerType at assembly time (phase 1337 sub-2)
 */

import { describe, it, expect } from 'vitest';
import { CALLER_TYPE_TO_GROUPS } from '../../src/core/caller-types.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import type { ToolGroup } from '../../src/foundation/tools/types.js';

describe('ToolContext assembly resolution', () => {
  it('resolves subagent callerType to correct allowedGroups via CALLER_TYPE_TO_GROUPS', () => {
    const allowedGroups = CALLER_TYPE_TO_GROUPS.subagent;
    expect(allowedGroups).toBeInstanceOf(Set);
    expect(allowedGroups.has('fs-read')).toBe(true);
    expect(allowedGroups.has('spawn')).toBe(false);
  });

  it('resolves miner callerType to correct allowedGroups', () => {
    const allowedGroups = CALLER_TYPE_TO_GROUPS.miner;
    expect(allowedGroups.has('fs-read')).toBe(true);
    expect(allowedGroups.has('fs-write')).toBe(false);
  });

  it('ExecContextImpl constructor accepts allowedGroups + callerLabel', () => {
    const allowedGroups = new Set<ToolGroup>(['fs-read', 'audit']);
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      syncDir: '/tmp/test/sync',
      profile: 'subagent',
      fs: {} as import('../../src/foundation/fs/types.js').FileSystem,
      maxSteps: 10,
      allowedGroups,
      callerLabel: 'subagent',
    });
    expect(ctx.allowedGroups).toBe(allowedGroups);
    expect(ctx.callerLabel).toBe('subagent');
  });
});
