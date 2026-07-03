import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { createNotifyClawTool } from '../../src/core/claw-topology/tools/notify-claw.js';
import { formatClawStatusHint } from '../../src/cli/commands/claw-shared.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { routeNotifyClaw } from '../../src/core/claw-topology/index.js';

describe('motion callerType assemble fix (phase 1160 P0-1 / phase 807 DI)', () => {
  let tempDir: string;
  let chestnutDir: string;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `motion-callerType-${randomUUID()}`);
    chestnutDir = path.join(tempDir, '.chestnut');
    fsNative.mkdirSync(chestnutDir, { recursive: true });
    audit = makeAudit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fsNative.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeDeps(fs: NodeFileSystem) {
    return {
      isClawAlive: () => true,
      formatClawStatusHint,
      clawExists: () => true,
      hasActiveContract: () => false,
      defaultSource: 'motion',
      fs,
      notifyClaw: (targetClawId: string, message: any) =>
        routeNotifyClaw(fs, chestnutDir, 'motion', targetClawId, message, audit.audit),
      audit: audit.audit,
    };
  }

  // 反向 1: authorized DI flag=true → notify-claw guard passes (end-to-end)
  it('反向 1: authorized=true → notify-claw guard passes', async () => {
    const fs = new NodeFileSystem({ baseDir: chestnutDir });
    await fs.ensureDir('claws/target-claw');

    const tool = createNotifyClawTool({ ...makeDeps(fs), authorized: true });

    const result = await tool.execute(
      { to: 'target-claw', body: 'hello' },
      { clawId: 'motion' } as any,
    );

    expect(result.success).toBe(true);
    const sentRows = audit.events.filter(
      r => r[0] === 'notify_claw_sent',
    );
    expect(sentRows.length).toBe(1);
  });

  // 反向 2: restricted instance authorized=false → notify-claw guard rejects (regression)
  it('反向 2: restricted instance authorized=false → notify-claw guard rejects', async () => {
    const fs = new NodeFileSystem({ baseDir: chestnutDir });
    await fs.ensureDir('claws/target-claw');

    const mainTool = createNotifyClawTool({ ...makeDeps(fs), authorized: true });
    const restrictedTool = { ...mainTool, authorized: false };

    const result = await restrictedTool.execute(
      { to: 'target-claw', body: 'hello' },
      { clawId: 'motion' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.content).toBe('notify_claw is motion-only');
  });
});
