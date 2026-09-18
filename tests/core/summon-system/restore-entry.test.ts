/**
 * phase 1866 Step H（SU-D8）：Summon 恢复事实单一入口专测。
 *
 * - 报告汇总三面（legacy 扫描 / pending-retrospective 待办 / claim 核对）；
 * - 面级故障进 issues（不静默、不 throw）；
 * - 子面行为不变（legacy 扫描 audit 行逐字不变；ack/列举语义不动）；
 * - 消费收敛：装配点经唯一入口（源码断言 `checkLegacySummonStateFiles` 不再被外部直接消费）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
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
  it('三面汇总：legacy 残留 + pending retrospective + claim 核对', async () => {
    const { clawFs, chestnutFs } = await makeFsPair();
    const { audit, events } = makeAudit();

    await clawFs.ensureDir('summon-state');
    await clawFs.writeAtomic('summon-state/legacy-1.json', '{}');
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

    const report = await restoreSummonFacts({ fs: clawFs, audit, claimStore });

    expect(report.legacyState).toEqual({ scanned: true, leftover: 1 });
    expect(report.pendingRetrospectives.map(r => r.contractId)).toEqual(['contract-1']);
    expect(report.claimIssues.map(i => i.summonId)).toEqual(['summon-broken']);
    expect(report.issues).toEqual([]);
    // 子面 audit 行不变（legacy 扫描既有 emit）
    expect(events).toContainEqual([
      'summon_legacy_state_file_detected',
      'count=1',
      'dir=summon-state',
      'action=manual_cleanup_required',
    ]);
  });

  it('面级故障进 issues、不 throw（pending-retrospective 列举失败）', async () => {
    const { clawFs, chestnutFs } = await makeFsPair();
    const { audit } = makeAudit();
    const claimStore = createSummonCreationClaimStore({ fs: chestnutFs });

    clawFs.existsSync = () => true;
    clawFs.listSync = () => { throw new Error('list boom'); };
    const report = await restoreSummonFacts({ fs: clawFs, audit, claimStore });

    expect(report.issues.map(i => i.face)).toContain('pending_retrospectives');
    expect(report.claimIssues).toEqual([]);
  });

  it('claim store 不可读 → claims 面 issue（恢复事实缺失不静默）', async () => {
    const { clawFs, chestnutFs } = await makeFsPair();
    const { audit } = makeAudit();
    const claimStore = createSummonCreationClaimStore({ fs: chestnutFs });
    claimStore.list = async () => ({ readable: false, claims: [], unreadable: [] });

    const report = await restoreSummonFacts({ fs: clawFs, audit, claimStore });
    expect(report.issues).toEqual([{ face: 'claims', detail: 'creation claim directory unreadable' }]);
  });

  it('消费收敛：装配点不再直接消费 legacy 子面（经唯一入口）', () => {
    const assemblyFiles = [path.join(repoRoot, 'src/assembly/core-infrastructure.ts')];
    for (const f of assemblyFiles) {
      const src = fsSync.readFileSync(f, 'utf8');
      expect(src).not.toContain('checkLegacySummonStateFiles');
      expect(src).toContain('restoreSummonFacts');
    }
  });
});
