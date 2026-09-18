/**
 * phase 1866 Step G（SU-D7）：对外文本净化专测。
 *
 * 规则：content（人读面）不含内部 kind/原因码与实现词；metadata（程序面）保留
 * 内部 kind/cause/reason 供分支；error 字段保留内部 code（程序分支，既有先例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { createSummonCreationClaimStore } from '../../../src/core/summon-system/creation-claim-store.js';
import { createSummonContractExtractPostProcessor } from '../../../src/core/summon-system/post-processors/contract-extract.js';

/** 内部实现词 / 内部码（不得出现在人读 content）。 */
const INTERNAL_IN_CONTENT = /claw|shadow|subagent|子代理|分身|mining|orphan|ExecContext|Assembly|creation_rejected|execution_failed|no_contract_created|contract_not_committed|summon_contract_creation_failed/i;

describe('phase 1866 Step G: summon outward text', () => {
  let tempDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeClaimStore() {
    return createSummonCreationClaimStore({ fs });
  }

  function makeProcessor(claimStore: ReturnType<typeof makeClaimStore>, exists: boolean) {
    const { audit } = makeAudit();
    return {
      audit,
      postProcessor: createSummonContractExtractPostProcessor({
        claimStore,
        contractQuery: { exists: vi.fn(async () => exists) },
      }),
    };
  }

  it('creation_rejected 失败文本 human 化（内部码只在 metadata）', async () => {
    const claimStore = makeClaimStore();
    const { postProcessor, audit } = makeProcessor(claimStore, true);

    const result = await postProcessor(
      { content: 'Done.', sourceIsError: false },
      { id: 'task-text-a' } as never,
      fs,
      audit,
    );

    expect(result.content).toBe('Summon failed: no contract was created.');
    expect(result.content).not.toMatch(INTERNAL_IN_CONTENT);
    expect(result.metadata?.kind).toBe('creation_rejected');
  });

  it('execution_failed 失败文本 human 化（内部码只在 metadata）', async () => {
    const claimStore = makeClaimStore();
    await claimStore.claim({ summonId: 'task-text-b', targetExecutorId: 'claw-a', contractId: 'c-b' });
    const { postProcessor, audit } = makeProcessor(claimStore, false);

    const result = await postProcessor(
      { content: 'Done.', sourceIsError: false },
      { id: 'task-text-b' } as never,
      fs,
      audit,
    );

    expect(result.content).toBe('Summon failed: the contract creation did not complete.');
    expect(result.content).not.toMatch(INTERNAL_IN_CONTENT);
    expect(result.metadata?.kind).toBe('execution_failed');
  });

  it('工具 description / 拒绝文案 / accepted 文案无实现词（含 metadata 之外的面向面）', async () => {
    const tool = new SummonTool();
    expect(tool.description).not.toMatch(INTERNAL_IN_CONTENT);

    const rejected = await new SummonTool({ allowFromShadow: false }).execute(
      { goal: 'g' },
      { auditWriter: null, currentToolUseId: 'tu_x' } as never,
    );
    expect(rejected.content).not.toMatch(INTERNAL_IN_CONTENT);
    // error 字段保留内部 code（程序分支；与 content 人读面分离）
    expect(rejected.error).toBe('summon_unavailable');
  });
});
