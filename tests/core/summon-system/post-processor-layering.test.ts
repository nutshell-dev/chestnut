/**
 * phase 1866 Step D（SU-D3）：post-processor 职责纯化专测。
 *
 * - 任务域 cross-check 是纯函数（claim authority + evidence 仅交叉验证）；
 * - 契约域 query 只在 claim 成立后发生（无 claim → 不触达契约系统）；
 * - 流序：claim（authority）→ cross-check（任务域）→ query（契约域）→ typed result；
 *   claim authority 不因 evidence 改变。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { createSummonCreationClaimStore } from '../../../src/core/summon-system/creation-claim-store.js';
import {
  createSummonContractExtractPostProcessor,
  evaluateEvidenceCrossCheck,
  type ContractCreatedEvidence,
} from '../../../src/core/summon-system/post-processors/contract-extract.js';

describe('phase 1866 Step D: post-processor domain layering', () => {
  describe('evaluateEvidenceCrossCheck（任务域纯函数）', () => {
    const claim = { contractId: 'c1', targetExecutorId: 'claw-a' };
    const ev = (contractId: string, targetClaw = 'claw-a'): ContractCreatedEvidence => ({ contractId, targetClaw });

    it.each([
      ['claim 在 + 无 evidence', claim, [], false, []],
      ['claim 在 + evidence 一致', claim, [ev('c1')], false, ['c1']],
      ['claim 在 + evidence contractId 不同', claim, [ev('c2')], true, ['c2']],
      ['claim 在 + evidence target 不同', claim, [ev('c1', 'claw-b')], true, ['c1']],
      ['claim 在 + 第二种 evidence', claim, [ev('c1'), ev('c2')], true, ['c1', 'c2']],
      ['claim 缺 + evidence 在', undefined, [ev('c3')], true, ['c3']],
      ['claim 缺 + 无 evidence', undefined, [], false, []],
    ])('%s', (_label, claimArg, evidence, mismatch, ids) => {
      const result = evaluateEvidenceCrossCheck(claimArg, evidence);
      expect(result.mismatch).toBe(mismatch);
      expect(result.distinctEvidenceIds).toEqual(ids);
    });
  });

  describe('flow 序与 authority（claim 先行、evidence 不改判定）', () => {
    let tempDir: string;
    let fs: NodeFileSystem;

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('claim 读 → cross-check 读 → query（query 最后；evidence 不参与判定）', async () => {
      const claimStore = createSummonCreationClaimStore({ fs });
      await claimStore.claim({ summonId: 'task-order', targetExecutorId: 'claw-a', contractId: 'c-order' });

      const order: string[] = [];
      const claimRead = vi.spyOn(claimStore, 'read').mockImplementation(async (id: string) => {
        order.push('claim');
        return { schema_version: 1, summonId: id, targetExecutorId: 'claw-a', contractId: 'c-order', claimedAt: 'x' };
      });
      const fsRead = vi.spyOn(fs, 'read').mockImplementation(async (p: string) => {
        order.push('evidence');
        return '2026-01-01T00:00:00.000Z\t1\ttool_exec\texec\tok\telapsed_ms=1\tsummary=Contract created: c-other for claw claw-x\n';
      });
      const existsSpy = vi.fn(async () => { order.push('query'); return true; });

      const { audit, events } = makeAudit();
      const postProcessor = createSummonContractExtractPostProcessor({
        claimStore,
        contractQuery: { exists: existsSpy },
      });
      const result = await postProcessor(
        { content: 'Done.', sourceIsError: false },
        { id: 'task-order' } as never,
        fs,
        audit,
      );

      expect(order).toEqual(['claim', 'evidence', 'query']);
      // authority 不变：第二份 evidence 只产生 mismatch 审计，结果仍为 claim 的 contractId
      expect(result.content).toBe('Contract created: c-order');
      expect(events).toContainEqual([
        'summon_creation_evidence_mismatch',
        'taskId=task-order',
        'claimContractId=c-order',
        'evidenceContractIds=c-other',
      ]);

      claimRead.mockRestore();
      fsRead.mockRestore();
    });

    it('无 claim → 契约域 query 不发生（fail 于任务域）', async () => {
      const claimStore = createSummonCreationClaimStore({ fs });
      const existsSpy = vi.fn(async () => true);
      const { audit, events } = makeAudit();
      const postProcessor = createSummonContractExtractPostProcessor({
        claimStore,
        contractQuery: { exists: existsSpy },
      });
      const result = await postProcessor(
        { content: 'Done.', sourceIsError: false },
        { id: 'task-no-claim' } as never,
        fs,
        audit,
      );

      expect(existsSpy).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(events).toContainEqual(['summon_no_contract_created', 'taskId=task-no-claim']);
    });
  });
});
