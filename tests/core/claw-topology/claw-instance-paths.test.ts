import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { routeNotifyClaw, routeNotifyClawAsync } from '../../../src/core/claw-topology/claw-instance-paths.js';

describe('claw-instance-paths', () => {
  let tempDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  const message = {
    type: 'message' as const,
    source: 'motion',
    priority: 'normal' as const,
    body: 'hello',
  };

  it('routeNotifyClaw rejects invalid targetClawId before path derivation', () => {
    const { audit, events } = makeAudit();
    expect(() => routeNotifyClaw(fs, tempDir, 'motion', '../foo', message, audit)).toThrow();
    // phase 944: validation fails before any disk write or audit emit
    expect(events).toHaveLength(0);
  });

  it('routeNotifyClawAsync rejects invalid targetClawId before path derivation', async () => {
    const { audit, events } = makeAudit();
    await expect(routeNotifyClawAsync(fs, tempDir, 'motion', '../foo', message, audit)).rejects.toThrow();
    // phase 944: validation fails before any disk write or audit emit
    expect(events).toHaveLength(0);
  });
});
