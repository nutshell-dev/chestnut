/**
 * phase 1866 Step E（SU-D4）：summon 失败分层专测。
 *
 * - creation_rejected（owner: 创建决策面）：无 claim —— 创建未成立（delivered typed 结果）；
 * - execution_failed（owner: 执行面）：claim 在但契约未提交（delivered typed 结果）；
 * - system_fault（owner: 系统面）：读/查询故障 —— typed throw + audit（保 defer/retry）；
 * - 无恢复处方：失败文本不教用户重试/内部模式。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { createSummonCreationClaimStore } from '../../../src/core/summon-system/creation-claim-store.js';
import {
  createSummonContractExtractPostProcessor,
  SummonSystemFaultError,
} from '../../../src/core/summon-system/post-processors/contract-extract.js';

describe('phase 1866 Step E: summon failure layering', () => {
  let tempDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function make(claimStore: ReturnType<typeof createSummonCreationClaimStore>, exists: () => Promise<boolean>) {
    const { audit, events } = makeAudit();
    const postProcessor = createSummonContractExtractPostProcessor({
      claimStore,
      contractQuery: { exists: vi.fn(exists) },
    });
    return { postProcessor, audit, events };
  }

  it('creation_rejected：无 claim → typed 结果 + 无恢复处方', async () => {
    const claimStore = createSummonCreationClaimStore({ fs });
    const { postProcessor, audit } = make(claimStore, async () => true);

    const result = await postProcessor(
      { content: 'Done.', sourceIsError: false },
      { id: 'task-rejected' } as never,
      fs,
      audit,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Summon failed: no contract was created.');
    expect(result.metadata).toEqual({
      kind: 'creation_rejected',
      cause: 'no_contract_created',
      sourceError: 'false',
    });
    expect(result.content).not.toMatch(/retry|重试|重新|mining|resume|恢复/i);
  });

  it('creation_rejected：error envelope 记录 sourceError 证据（判定不变）', async () => {
    const claimStore = createSummonCreationClaimStore({ fs });
    const { postProcessor, audit } = make(claimStore, async () => true);

    const result = await postProcessor(
      { content: 'boom', sourceIsError: true },
      { id: 'task-rejected-err' } as never,
      fs,
      audit,
    );

    expect(result.metadata).toEqual({
      kind: 'creation_rejected',
      cause: 'no_contract_created',
      sourceError: 'true',
    });
    expect(result.content).not.toContain('boom');
  });

  it('execution_failed：claim 在但契约未提交 → typed 结果', async () => {
    const claimStore = createSummonCreationClaimStore({ fs });
    await claimStore.claim({ summonId: 'task-exec', targetExecutorId: 'claw-a', contractId: 'c-x' });
    const { postProcessor, audit } = make(claimStore, async () => false);

    const result = await postProcessor(
      { content: 'Done.', sourceIsError: false },
      { id: 'task-exec' } as never,
      fs,
      audit,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Summon failed: the contract creation did not complete.');
    expect(result.metadata).toEqual({
      kind: 'execution_failed',
      reason: 'contract_not_committed',
      sourceError: 'false',
    });
    expect(result.content).not.toMatch(/retry|重试|重新|mining|resume|恢复/i);
  });

  it('system_fault：claim 读失败 → typed throw + summon_system_fault audit（不 delivered）', async () => {
    const claimStore = createSummonCreationClaimStore({ fs });
    const broken = { ...claimStore, read: vi.fn(async () => { throw new Error('claim io boom'); }) };
    const { postProcessor, audit, events } = make(broken as never, async () => true);

    await expect(
      postProcessor({ content: 'Done.', sourceIsError: false }, { id: 'task-claim-io' } as never, fs, audit),
    ).rejects.toBeInstanceOf(SummonSystemFaultError);
    expect(events).toContainEqual([
      'summon_system_fault',
      'taskId=task-claim-io',
      'stage=claim_read',
      'error=claim io boom',
    ]);
  });

  it('system_fault：contract query 失败 → typed throw（stage=contract_query）', async () => {
    const claimStore = createSummonCreationClaimStore({ fs });
    await claimStore.claim({ summonId: 'task-query-io', targetExecutorId: 'claw-a', contractId: 'c-q' });
    const { postProcessor, audit, events } = make(claimStore, async () => { throw new Error('query io boom'); });

    await expect(
      postProcessor({ content: 'Done.', sourceIsError: false }, { id: 'task-query-io' } as never, fs, audit),
    ).rejects.toBeInstanceOf(SummonSystemFaultError);
    expect(events).toContainEqual([
      'summon_system_fault',
      'taskId=task-query-io',
      'stage=contract_query',
      'error=query io boom',
    ]);
  });
});
