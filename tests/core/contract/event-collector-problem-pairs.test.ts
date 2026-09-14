/**
 * phase 1487: event-collector 返 problemPairs + 去 [force-accepted] prefix 验证.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { collectContractEvents } from '../../../src/core/contract/jobs/event-collector.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function makeAudit() {
  return { write: () => {} };
}

function makeProgress(opts: {
  contractId: string;
  subtasks: Record<string, { status: string; evidence?: string; force_accepted?: boolean; last_failed_feedback?: { feedback: string }; completed_at?: string }>;
}) {
  return JSON.stringify({ schema_version: 1,
    contract_id: opts.contractId,
    status: 'completed',
    subtasks: opts.subtasks,
  });
}

describe('phase 1487: collectContractEvents result shape', () => {
  let chestnutRoot: string;
  let fs: NodeFileSystem;
  const sinceTs = new Date('2026-01-01').getTime();

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    chestnutRoot = path.join(tmpdir(), `event-collector-${randomUUID()}`);
    await fsAsync.mkdir(chestnutRoot, { recursive: true });
    fs = new NodeFileSystem({ baseDir: chestnutRoot });
  });

  afterEach(async () => {
    await fsAsync.rm(chestnutRoot, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  async function makeContract(clawSub: string, contractDirName: string, progressJson: string, contractYaml = '') {
    const archiveDir = path.join(chestnutRoot, clawSub, 'contract/archive', contractDirName);
    await fsAsync.mkdir(archiveDir, { recursive: true });
    await fsAsync.writeFile(path.join(archiveDir, 'progress.json'), progressJson);
    if (contractYaml) {
      await fsAsync.writeFile(path.join(archiveDir, 'contract.yaml'), contractYaml);
    }
  }

  it('clean contract → events present, problemPairs empty', async () => {
    await makeContract('claws/worker-1', '1780-abcd', makeProgress({
      contractId: '1780-abcd',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'src/login.ts', completed_at: '2026-05-31T00:00:00Z' },
      },
    }));
    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const result = await collectContractEvents(fs, clawDir, 'worker-1', sinceTs, makeAudit());
    expect(result.events.length).toBe(1);
    expect(result.problemPairs).toEqual([]);
    expect(result.events[0]).toContain('契约流程已完成｜1780-abcd');
    expect(result.events[0]).toContain('执行者：worker-1');
    expect(result.events[0]).toContain('[st-1] 执行者提交材料：src/login.ts');
  });

  it('contract with last_failure → problemPairs contains pair', async () => {
    await makeContract('claws/worker-1', '1780-cdef', makeProgress({
      contractId: '1780-cdef',
      subtasks: {
        'st-1': {
          status: 'completed',
          evidence: 'src/login.ts',
          completed_at: '2026-05-31T00:00:00Z',
          last_failed_feedback: { feedback: 'Failed test isolation' },
        },
      },
    }));
    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const result = await collectContractEvents(fs, clawDir, 'worker-1', sinceTs, makeAudit());
    expect(result.events.length).toBe(1);
    // phase 1832: 历史反馈 refs 语义不变（有 last_failed_feedback 才进 problemPairs）
    expect(result.problemPairs).toEqual(['worker-1:1780-cdef']);
    expect(result.events[0]).toContain('历史验收反馈（该子任务保留的最近一次未通过反馈，不能仅凭此记录判断最终验收结论）：Failed test isolation');
  });

  it('force_accepted=true subtask → 中性放行注记、无 [force-accepted] prefix（phase 1832）', async () => {
    await makeContract('claws/worker-1', '1780-eeee', makeProgress({
      contractId: '1780-eeee',
      subtasks: {
        'st-1': {
          status: 'completed',
          evidence: 'src/auth.ts',
          completed_at: '2026-05-31T00:00:00Z',
          force_accepted: true,  // 正文仅中性注记，不表示验收通过
        },
      },
    }));
    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const result = await collectContractEvents(fs, clawDir, 'worker-1', sinceTs, makeAudit());
    expect(result.events[0]).not.toContain('[force-accepted]');
    expect(result.events[0]).toContain('[st-1] 执行者提交材料：src/auth.ts');
    expect(result.events[0]).toContain('完成方式：按流程放行记为完成；该标记不表示验收通过');
    // 放行不算历史失败，不进 problemPairs
    expect(result.problemPairs).toEqual([]);
  });

  it('multiple subtasks, some with failure → problem_pairs includes only failure entries', async () => {
    await makeContract('claws/worker-1', '1780-ffff', makeProgress({
      contractId: '1780-ffff',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'src/a.ts', completed_at: '2026-05-31T00:00:00Z' },
        'st-2': {
          status: 'completed',
          evidence: 'src/b.ts',
          completed_at: '2026-05-31T00:00:00Z',
          last_failed_feedback: { feedback: 'b broken' },
        },
      },
    }));
    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const result = await collectContractEvents(fs, clawDir, 'worker-1', sinceTs, makeAudit());
    expect(result.problemPairs).toEqual(['worker-1:1780-ffff']);  // 单 contract / 1 pair (即便多 subtask)
  });

  it('contract before sinceTs → not included', async () => {
    await makeContract('claws/worker-1', '1780-old', makeProgress({
      contractId: '1780-old',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'old.ts', completed_at: '2025-12-01T00:00:00Z' },
      },
    }));
    const clawDir = path.join(chestnutRoot, 'claws/worker-1');
    const result = await collectContractEvents(fs, clawDir, 'worker-1', sinceTs, makeAudit());
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
  });
});
