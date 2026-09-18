/**
 * phase 1864 Step D（CT-D4）：DaemonDir brand 构造归 ProcessManager。
 */
import { describe, it, expect } from 'vitest';
import { makeDaemonDirFromLocation, type DaemonDir } from '../../../src/foundation/process-manager/index.js';

describe('makeDaemonDirFromLocation (phase 1864 Step D / CT-D4)', () => {
  it('consumes a resolved local location and returns the branded dir', () => {
    const location = { kind: 'local', clawDir: '/data/chestnut/claws/claw-a' } as const;
    const daemonDir: DaemonDir = makeDaemonDirFromLocation(location);
    expect(daemonDir).toBe('/data/chestnut/claws/claw-a');
  });

  it('motion-style location (chestnutRoot/motion) is not special-cased by PM', () => {
    expect(makeDaemonDirFromLocation({ kind: 'local', clawDir: '/data/chestnut/motion' }))
      .toBe('/data/chestnut/motion');
  });
});
