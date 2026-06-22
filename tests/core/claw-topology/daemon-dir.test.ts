/**
 * phase 694 Step A: resolveClawDaemonDir 单测
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveClawDaemonDir } from '../../../src/core/claw-topology/daemon-dir.js';
import { MOTION_CLAW_ID } from '../../../src/core/claw-topology/motion-claw-id.js';
import { makeClawId } from '../../../src/foundation/identity/index.js';

describe('resolveClawDaemonDir', () => {
  it('motion clawId → motion subroot', () => {
    const dir = resolveClawDaemonDir(MOTION_CLAW_ID);
    // motion 路径 = <workspaceRoot>/.chestnut/motion
    expect(dir.endsWith(path.join('.chestnut', 'motion'))).toBe(true);
  });

  it('regular clawId → claws/<id>', () => {
    const dir = resolveClawDaemonDir(makeClawId('test-claw'));
    expect(dir.endsWith(path.join('.chestnut', 'claws', 'test-claw'))).toBe(true);
  });

  it('invalid clawId throws (path traversal guard)', () => {
    expect(() => resolveClawDaemonDir(makeClawId('../escape'))).toThrow(/invalid claw id/i);
  });

  it('empty clawId throws', () => {
    expect(() => resolveClawDaemonDir(makeClawId(''))).toThrow(/invalid claw id/i);
  });

  it('clawId with slash throws', () => {
    expect(() => resolveClawDaemonDir(makeClawId('foo/bar'))).toThrow(/invalid claw id/i);
  });
});
