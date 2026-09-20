/**
 * Phase 1878 Step D（watchdog-contract-sink-overassembly）：createExecutionFailureSink
 * 窄 capability 测试。
 *
 * 语义与 ContractSystem.failActiveForExecutor 1:1（同一实现源
 * failActiveContractsForExecutor）：三态 ack / executor mismatch 拒绝 /
 * deterministic 枚举 / 稳定 requestId / intent-rename winner 协议——但
 * 不构造完整 ContractSystem 实例。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { createExecutionFailureSink } from '../../../src/core/contract/execution-failure.js';
import type { ContractNotification } from '../../../src/core/contract/notification.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

const EXECUTOR_ID = 'test-claw';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('Phase 1878 Step D: createExecutionFailureSink（窄 capability，0-full-instance）', () => {
  let tempDir: string;
  let clawDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;
  let notifies: ContractNotification[];
  let sink: ReturnType<typeof createExecutionFailureSink>;

  /** 借 manager.create 造 active contract fixture（sink 本身不依赖 manager）。 */
  let manager: ContractSystem;

  beforeEach(async () => {
    tempDir = await createTempDir('phase1878-sink-');
    clawDir = path.join(tempDir, 'claws', EXECUTOR_ID);
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
    const audit = { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any;
    notifies = [];
    sink = createExecutionFailureSink({
      fs: new NodeFileSystem({ baseDir: clawDir }),
      audit,
      clawDir,
      clawId: EXECUTOR_ID,
      onNotify: (event) => notifies.push(event),
    });
    manager = new ContractSystem({
      clawDir,
      clawId: EXECUTOR_ID,
      fs: new NodeFileSystem({ baseDir: clawDir }),
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      notifyClaw: () => Promise.resolve(),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  const INPUT = {
    executorId: EXECUTOR_ID,
    producer: 'watchdog',
    reason: 'daemon_unavailable',
    evidenceRef: 'watchdog/executor-recovery/test-claw.json',
  };

  async function createActive(title: string): Promise<string> {
    return manager.create(makeContractYaml({
      title,
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
  }

  it('无 active contract → committed', async () => {
    await expect(sink.report(INPUT)).resolves.toEqual({ kind: 'committed' });
  });

  it('active contract → committed：archive/failed + contract_failed audit + notify', async () => {
    const contractId = await createActive('SinkTarget');

    await expect(sink.report(INPUT)).resolves.toEqual({ kind: 'committed' });

    expect(await fileExists(path.join(clawDir, 'contract', 'archive', 'failed', contractId))).toBe(true);
    expect(await fileExists(path.join(clawDir, 'contract', 'active', contractId))).toBe(false);
    const failed = auditWrite.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.FAILED);
    expect(failed).toHaveLength(1);
    expect(notifies.filter(n => n.type === 'contract_failed')).toHaveLength(1);
    expect(notifies[0]).toMatchObject({
      contractId,
      reason: INPUT.reason,
      evidenceRef: INPUT.evidenceRef,
      producer: INPUT.producer,
    });
  });

  it('executor mismatch → rejected + FAIL_EXECUTOR_MISMATCH audit（永久拒绝）', async () => {
    const outcome = await sink.report({ ...INPUT, executorId: 'other-claw' });
    expect(outcome.kind).toBe('rejected');
    expect((outcome as { reason: string }).reason).toContain('other-claw');
    const mismatch = auditWrite.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.FAIL_EXECUTOR_MISMATCH,
    );
    expect(mismatch).toHaveLength(1);
  });

  it('稳定 requestId：同一失败事实重报复用同一 intent（at-least-once 幂等）', async () => {
    const contractId = await createActive('Stable');
    await expect(sink.report(INPUT)).resolves.toEqual({ kind: 'committed' });
    // 重试：contract 已归档、不再枚举 → 不产生新 intent / 不重复副作用。
    await expect(sink.report(INPUT)).resolves.toEqual({ kind: 'committed' });
    const intentDir = path.join(clawDir, 'contract', 'lifecycle-intents', contractId);
    expect((await fs.readdir(intentDir)).filter(n => n.endsWith('.json'))).toHaveLength(1);
    expect(auditWrite.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.FAILED)).toHaveLength(1);
  });

  it('rename retryable → retryable{error}；恢复后重试经同一 intent 闭合 committed', async () => {
    const failMoves = { current: true };
    class FlakyMoveFs extends NodeFileSystem {
      override async moveDir(fromPath: string, toPath: string): Promise<void> {
        if (failMoves.current && fromPath.includes(`active${path.sep}`)) {
          throw new Error('mock move failure');
        }
        return super.moveDir(fromPath, toPath);
      }
    }
    const audit = { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any;
    const flakySink = createExecutionFailureSink({
      fs: new FlakyMoveFs({ baseDir: clawDir }),
      audit,
      clawDir,
      clawId: EXECUTOR_ID,
    });
    const contractId = await createActive('Retryable');

    const retryable = await flakySink.report(INPUT);
    expect(retryable.kind).toBe('retryable');
    expect((retryable as { error: string }).error).toContain('mock move failure');
    expect(await fileExists(path.join(clawDir, 'contract', 'active', contractId))).toBe(true);

    failMoves.current = false;
    await expect(flakySink.report(INPUT)).resolves.toEqual({ kind: 'committed' });
    expect(await fileExists(path.join(clawDir, 'contract', 'archive', 'failed', contractId))).toBe(true);
  });
});
