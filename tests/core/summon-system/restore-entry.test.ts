/**
 * phase 1866 Step H（SU-D8）：Summon 恢复事实单一入口专测。
 *
 * - 报告汇总两面（pending-retrospective 待办 / claim 核对）；
 * - 面级故障进 issues（不静默、不 throw）；
 * - 子面行为不变（ack/列举语义不动）；
 * - 消费收敛：装配点经唯一入口。
 *
 * phase 1890 Step E：legacy summon-state/ 扫描子面随存量废弃删除，
 * `legacyState` 报告字段与 audit 透传随删。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { restoreSummonFacts } from '../../../src/core/summon-system/restore.js';
import { createSummonCreationClaimStore } from '../../../src/core/summon-system/creation-claim-store.js';
import { CLAWSPACE_DIR } from '../../../src/foundation/claw-identity/index.js';

const repoRoot = process.cwd();
let tempDir: string | undefined;

async function makeFsPair(): Promise<{ clawFs: NodeFileSystem; chestnutFs: NodeFileSystem; dir: string }> {
  const dir = await createTempDir();
  tempDir = dir;
  return { clawFs: new NodeFileSystem({ baseDir: dir }), chestnutFs: new NodeFileSystem({ baseDir: dir }), dir };
}

afterEach(async () => {
  if (tempDir) {
    await cleanupTempDir(tempDir);
    tempDir = undefined;
  }
});

describe('phase 1866 Step H: single summon restore entry', () => {
  it('两面汇总：pending retrospective + claim 核对', async () => {
    const { clawFs, chestnutFs } = await makeFsPair();

    await clawFs.ensureDir(`${CLAWSPACE_DIR}/pending-retrospective/by-contract`);
    await clawFs.writeAtomic(
      `${CLAWSPACE_DIR}/pending-retrospective/by-contract/contract-1.json`,
      JSON.stringify({ contractId: 'contract-1', targetClaw: 'claw-a' }),
    );

    const claimStore = createSummonCreationClaimStore({ fs: chestnutFs });
    await claimStore.claim({ summonId: 'summon-1', targetExecutorId: 'claw-a', contractId: 'contract-1' });
    // 损坏 claim（authority 面异常项）
    await chestnutFs.ensureDir('summons/summon-broken');
    await chestnutFs.writeAtomic('summons/summon-broken/creation-claim.json', 'not-json');

    const report = await restoreSummonFacts({ fs: clawFs, claimStore });

    expect(report.pendingRetrospectives.map(r => r.contractId)).toEqual(['contract-1']);
    expect(report.claimIssues.map(i => i.summonId)).toEqual(['summon-broken']);
    expect(report.issues).toEqual([]);
  });

  it('面级故障进 issues、不 throw（pending-retrospective 列举失败）', async () => {
    const { clawFs, chestnutFs } = await makeFsPair();
    const claimStore = createSummonCreationClaimStore({ fs: chestnutFs });

    clawFs.existsSync = () => true;
    clawFs.listSync = () => { throw new Error('list boom'); };
    const report = await restoreSummonFacts({ fs: clawFs, claimStore });

    expect(report.issues.map(i => i.face)).toContain('pending_retrospectives');
    expect(report.claimIssues).toEqual([]);
  });

  it('claim store 不可读 → claims 面 issue（恢复事实缺失不静默）', async () => {
    const { clawFs, chestnutFs } = await makeFsPair();
    const claimStore = createSummonCreationClaimStore({ fs: chestnutFs });
    claimStore.list = async () => ({ readable: false, claims: [], unreadable: [] });

    const report = await restoreSummonFacts({ fs: clawFs, claimStore });
    expect(report.issues).toEqual([{ face: 'claims', detail: 'creation claim directory unreadable' }]);
  });

  it('消费收敛：装配点经恢复事实唯一入口', () => {
    const assemblyFiles = [path.join(repoRoot, 'src/assembly/core-infrastructure.ts')];
    for (const f of assemblyFiles) {
      const src = fsSync.readFileSync(f, 'utf8');
      expect(src).not.toContain('checkLegacySummonStateFiles');
      expect(src).toContain('restoreSummonFacts');
    }
  });
});
