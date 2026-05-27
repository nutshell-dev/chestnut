/**
 * notify_claw production drift regression test (phase 1021)
 *
 * 触发：phase 1004 round 4 audit §F-P0-1 / production motion → claw push 100% fail
 * scope：装配-level fs.baseDir 与 clawforumRoot drift detection
 *
 * 既有 notify-claw.test.ts 12+ case 全 clawforumRoot: tempDir + fs.baseDir = tempDir 对齐 → drift 0 cover。
 * 本 test 显式 mock baseDir ≠ clawforumRoot 场景、防 phase 1021 hotfix 之后 regression。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { createNotifyClawTool } from '../../../src/foundation/messaging/tools/notify-claw.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('notify_claw production drift regression (phase 1021)', () => {
  let tempDir: string;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    audit = makeAudit();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // 反向 1: 模拟 phase 1021 修复前的 production 配线 (systemFs baseDir = motion dir、clawforumRoot = workspaceRoot)
  // 期望：existsSync(targetClawRoot) throw PermissionError、execute escape、NOTIFY_CLAW_FAILED 0 emit
  it('production drift detection: fs.baseDir = motion dir ≠ clawforumRoot → existsSync throws + audit 0 emit', async () => {
    // 模拟 production layout: workspaceRoot/.clawforum/motion
    const workspaceRoot = tempDir;
    const clawforumDir = path.join(workspaceRoot, '.clawforum');
    const motionDir = path.join(clawforumDir, 'motion');
    await new NodeFileSystem({ baseDir: workspaceRoot }).ensureDir('.clawforum/motion');
    await new NodeFileSystem({ baseDir: workspaceRoot }).ensureDir('.clawforum/claws/worker-1');

    // production 配线 drift: fs.baseDir = motionDir、clawforumRoot = workspaceRoot (错位 #1)
    const driftFs = new NodeFileSystem({ baseDir: motionDir });
    const driftClawforumRoot = workspaceRoot;  // ← 错位 (应为 clawforumDir)

    const tool = createNotifyClawTool({ fs: driftFs, clawforumRoot: driftClawforumRoot, audit: audit.audit });

    // targetClawRoot = workspaceRoot/claws/worker-1 = absolute path、outside motionDir baseDir
    // existsSync → resolveAndCheck throw PermissionError、escape execute()
    await expect(
      tool.execute({ to: 'worker-1', body: 'hello' }, { callerLabel: 'motion' } as any)
    ).rejects.toThrow(/absolute, must be relative to baseDir/);

    // NOTIFY_CLAW_FAILED audit 0 emit (throw 在 try 之外)
    const failedRows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
    expect(failedRows.length).toBe(0);
    const sentRows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);
    expect(sentRows.length).toBe(0);
  });

  // 反向 2: phase 1021 修复后 production 配线 (parentFs baseDir = clawforumRoot)
  // 期望：existsSync return true、happy path NOTIFY_CLAW_SENT emit
  it('phase 1021 hotfix: fs.baseDir = clawforumRoot → existsSync resolves + happy path emit', async () => {
    const workspaceRoot = tempDir;
    const clawforumDir = path.join(workspaceRoot, '.clawforum');
    const correctFs = new NodeFileSystem({ baseDir: clawforumDir });
    await correctFs.ensureDir('claws/worker-1');

    const tool = createNotifyClawTool({ fs: correctFs, clawforumRoot: clawforumDir, audit: audit.audit });
    const result = await tool.execute({ to: 'worker-1', body: 'hello' }, { callerLabel: 'motion' } as any);

    expect(result.success).toBe(true);
    const sentRows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT);
    expect(sentRows.length).toBe(1);
  });

  // 反向 3: phase 1021 修复后 claw_not_found 路径 (target claw 真不存在、existsSync 不 throw)
  // 期望：NOTIFY_CLAW_FAILED reason=claw_not_found emit (走正常 if 分支、不走 throw)
  it('phase 1021 hotfix: claw_not_found graceful failure emits NOTIFY_CLAW_FAILED (not throw)', async () => {
    const workspaceRoot = tempDir;
    const clawforumDir = path.join(workspaceRoot, '.clawforum');
    const correctFs = new NodeFileSystem({ baseDir: clawforumDir });
    await correctFs.ensureDir('claws');  // claws dir exists but no worker-1 subdir

    const tool = createNotifyClawTool({ fs: correctFs, clawforumRoot: clawforumDir, audit: audit.audit });
    const result = await tool.execute({ to: 'worker-1', body: 'hello' }, { callerLabel: 'motion' } as any);

    expect(result.success).toBe(false);
    expect(result.content).toMatch(/claw not found/);
    const failedRows = audit.events.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED);
    expect(failedRows.length).toBe(1);
    expect(failedRows[0]).toContain('reason=claw_not_found');
  });
});
