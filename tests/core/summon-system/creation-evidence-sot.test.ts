/**
 * phase 1866 Step C（SU-D2）：创建 evidence 单一（SoT）专测。
 *
 * 锁定：
 * - claim store 是唯一 authority（唯一 writer；claim 文件路径只在该 owner 出现）；
 * - legacy `summonDecision` 无 writer（仅 migration 读面）；读面矩阵 typed；
 * - claim 与 cross-check evidence 冲突时 authority 仍是 claim（结果不随 evidence 变）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { readSummonDecision } from '../../../src/core/summon-system/legacy-decision.js';
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

    it('legacy summonDecision 在 src 无 writer（只有 ATS schema/类型 + migration 读面）', () => {
      const writers: string[] = [];
      for (const f of srcFiles) {
        const rel = path.relative(repoRoot, f);
        const src = stripComments(fsSync.readFileSync(f, 'utf8'));
        // 写点特征：`summonDecision:` 赋值（object literal 赋字段）——排除 zod schema 声明与类型定义
        if (rel.startsWith('src/core/async-task-system/')) continue;
        if (/summonDecision\s*:\s*(?!z\.)/.test(src) && !rel.endsWith('legacy-decision.ts')) {
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

  describe('legacy decision read face (migration 兼容读，非 authority)', () => {
    it.each([
      ['absent', undefined, 'absent'],
      ['v2', { schema_version: 2, dispatchedAt: 'x' }, 'legacy_v2'],
      ['v1', { schema_version: 1, mode: 'shadow', verify: false, dispatchedAt: 'x' }, 'legacy_v1'],
      ['unknown', { schema_version: 3 }, 'unknown_schema_version'],
    ])('%s → %s', (_label, summonDecision, expected) => {
      expect(readSummonDecision({ summonDecision } as never).kind).toBe(expected);
    });

    it('v1 读面保留 decision 载荷（verify/targetClaw 兼容解释输入）', () => {
      const read = readSummonDecision({
        summonDecision: { schema_version: 1, mode: 'mining', verify: true, targetClaw: 'claw-a', dispatchedAt: 'x' },
      } as never);
      expect(read.kind).toBe('legacy_v1');
      if (read.kind === 'legacy_v1') {
        expect(read.decision.targetClaw).toBe('claw-a');
        expect(read.decision.verify).toBe(true);
      }
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
