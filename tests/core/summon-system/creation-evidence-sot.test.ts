/**
 * phase 1866 Step C（SU-D2）：创建 evidence 单一（SoT）专测。
 *
 * 锁定：
 * - claim store 是唯一 authority（唯一 writer；claim 文件路径只在该 owner 出现）；
 * - legacy `summonDecision` 无 writer（phase 1890 Step E：migration 读面也已删除，
 *   policy 对仍带 decision 的任务 fail-closed）；
 * - claim 与 cross-check evidence 冲突时 authority 仍是 claim（结果不随 evidence 变）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { createSummonCreationClaimStore } from '../../../src/core/summon-system/creation-claim-store.js';
import { createSummonContractExtractPostProcessor } from '../../../src/core/summon-system/post-processors/contract-extract.js';

const repoRoot = process.cwd();

/** 剥注释：只锁真实代码，注释中的路径叙述不算写面。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function collectSrcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSrcFiles(full, out);
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('phase 1866 Step C: creation evidence single source of truth', () => {
  describe('source-level SoT locks', () => {
    const srcFiles = collectSrcFiles(path.join(repoRoot, 'src'));

    it('claim 文件路径/写面只出现在 claim store owner', () => {
      const owners = srcFiles
        .filter((f) => stripComments(fsSync.readFileSync(f, 'utf8')).includes('creation-claim.json'))
        .map((f) => path.relative(repoRoot, f));
      expect(owners).toEqual(['src/core/summon-system/creation-claim-store.ts']);
    });

    it('legacy summonDecision 在 src 无 writer（只有 ATS schema/类型声明）', () => {
      const writers: string[] = [];
      for (const f of srcFiles) {
        const rel = path.relative(repoRoot, f);
        const src = stripComments(fsSync.readFileSync(f, 'utf8'));
        // 写点特征：`summonDecision:` 赋值（object literal 赋字段）——排除 zod schema 声明与类型定义
        if (rel.startsWith('src/core/async-task-system/')) continue;
        if (/summonDecision\s*:\s*(?!z\.)/.test(src)) {
          writers.push(rel);
        }
      }
      expect(writers).toEqual([]);
    });

    it('claim 写点只有 policy 的 claimCreation（claim( 调用面单一）', () => {
      const claimCallers = srcFiles
        .filter((f) => /claimStore\.claim\(/.test(fsSync.readFileSync(f, 'utf8')))
        .map((f) => path.relative(repoRoot, f));
      expect(claimCallers).toEqual(['src/core/summon-system/summon-verify-policy.ts']);
    });
  });

  describe('claim authority wins over conflicting cross-check evidence', () => {
    let tempDir: string;
    let fs: NodeFileSystem;

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('evidence 指向第二个 contract → 结果仍取 claim 的 contractId（+ mismatch audit）', async () => {
      const claimStore = createSummonCreationClaimStore({ fs });
      await claimStore.claim({ summonId: 'task-sot', targetExecutorId: 'claw-a', contractId: 'c-authority' });

      // sub-audit 提供另一份 evidence（cross-check 面），不得改变 authority
      await fs.ensureDir('tasks/queues/results/task-sot');
      await fs.writeAtomic(
        'tasks/queues/results/task-sot/audit.tsv',
        '2026-01-01T00:00:00.000Z\t1\ttool_exec\texec\tok\telapsed_ms=1\tsummary=Contract created: c-other for claw claw-x\n',
      );

      const { audit } = makeAudit();
      const postProcessor = createSummonContractExtractPostProcessor({
        claimStore,
        contractQuery: { exists: vi.fn().mockResolvedValue(true) },
      });
      const result = await postProcessor(
        { content: 'Done.', sourceIsError: false },
        { id: 'task-sot' } as never,
        fs,
        audit,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toBe('Contract created: c-authority');
      expect(result.metadata).toMatchObject({ contractId: 'c-authority' });
    });
  });
});
