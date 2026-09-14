/**
 * Phase 63 Step G: event-collector formatContractEvent status 分支测试
 */

import { describe, it, expect } from 'vitest';
import { scanArchivedContracts } from '../../../../src/core/contract/jobs/event-collector.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';
import { makeAudit } from '../../../helpers/audit.js';

function makeFs(files: Record<string, string>, dirs: Record<string, string[]>): FileSystem {
  const fileMap = new Map(Object.entries(files));
  const dirMap = new Map(
    Object.entries(dirs).map(([d, names]) => [d, names.map(name => ({ name, isDirectory: true, size: 0 }))]),
  );
  return {
    listSync: (p: string) => dirMap.get(p) ?? [],
    readSync: (p: string) => {
      if (fileMap.has(p)) return fileMap.get(p)!;
      throw new Error('ENOENT');
    },
    existsSync: () => true,
  } as unknown as FileSystem;
}

function makeFsForStatus(status: string, checkpoint?: string): FileSystem {
  return makeFs({
    '/tmp/claw/contract/archive/c1/progress.json': JSON.stringify({ schema_version: 1,
      contract_id: 'c1',
      status,
      checkpoint: checkpoint ?? null,
      subtasks: {},
    }),
  }, { '/tmp/claw/contract/archive': ['c1'] });
}

describe('phase 63: formatContractEvent status 分支', () => {
  it('completed（legacy flat）→ phase 1832 新正文：终态+对象/执行者 + status 字段', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('completed');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe('契约流程已完成｜c1\n执行者：clawA');
    expect(entries[0].status).toBe('completed');
    expect(entries[0].hasFailure).toBe(false);
  });

  it('completed（current archive/completed 容器）→ 同一新正文语义', async () => {
    const { audit } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/completed/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1',
        status: 'completed',
        subtasks: { 'st-1': { status: 'completed', completed_at: '2026-09-01T00:00:00Z', evidence: 'done' } },
      }),
      '/tmp/claw/contract/archive/completed/c1/contract.yaml': 'title: T1\ngoal: G1\n',
    }, {
      '/tmp/claw/contract/archive': ['completed'],
      '/tmp/claw/contract/archive/completed': ['c1'],
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约流程已完成｜T1（c1）\n'
      + '执行者：clawA\n'
      + '原目标：G1\n'
      + '已完成子任务：\n'
      + '  [st-1] 执行者提交材料：done',
    );
    expect(entries[0].status).toBe('completed');
  });

  it('先失败后通过：历史反馈原文保留并明示为历史记录，不称当前失败', async () => {
    const { audit } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/completed/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1',
        status: 'completed',
        subtasks: { 'st-1': {
          status: 'completed',
          completed_at: '2026-09-01T00:00:00Z',
          evidence: 'final.ts',
          last_failed_feedback: { feedback: '曾缺测试' },
        } },
      }),
    }, {
      '/tmp/claw/contract/archive': ['completed'],
      '/tmp/claw/contract/archive/completed': ['c1'],
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('  [st-1] 执行者提交材料：final.ts');
    expect(entries[0].body).toContain('历史验收反馈（该子任务保留的历史记录，不对应最终验收结论）：曾缺测试');
    expect(entries[0].body).not.toContain('last_failure');
    // 历史反馈存在 → hasFailure 语义不变（guidance refs 选择依据）
    expect(entries[0].hasFailure).toBe(true);
  });

  it('放行与材料缺失：force_accepted 中性注记 + 未记录提交材料明示', async () => {
    const { audit } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/completed/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1',
        status: 'completed',
        subtasks: {
          'st-1': { status: 'completed', completed_at: '2026-09-01T00:00:00Z', force_accepted: true },
          'st-2': { status: 'completed', completed_at: '2026-09-01T01:00:00Z', evidence: 'ok.ts' },
        },
      }),
    }, {
      '/tmp/claw/contract/archive': ['completed'],
      '/tmp/claw/contract/archive/completed': ['c1'],
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约流程已完成｜c1\n'
      + '执行者：clawA\n'
      + '已完成子任务：\n'
      + '  [st-1] 执行者提交材料：未记录提交材料\n'
      + '    完成方式：按流程放行记为完成；该标记不表示验收通过\n'
      + '  [st-2] 执行者提交材料：ok.ts',
    );
    // 放行标记不反推验收通过，也不计入历史失败
    expect(entries[0].hasFailure).toBe(false);
  });

  it('cancelled → [contract_cancelled] + reason + status 字段', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('cancelled', 'cancelled: user manual');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/^\[contract_cancelled\]/);
    expect(entries[0].body).toContain('reason: user manual');
    expect(entries[0].status).toBe('cancelled');
    expect(entries[0].reason).toBe('user manual');
  });

  it('crashed (legacy) → [contract_crashed] body + cause + status 字段（observer 侧只 audit、不投 motion）', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('crashed', 'crashed: system: maxstepsexceedederror');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/^\[contract_crashed\]/);
    expect(entries[0].body).toContain('cause: system: maxstepsexceedederror');
    expect(entries[0].status).toBe('crashed');
    expect(entries[0].cause).toBe('system: maxstepsexceedederror');
  });

  it('Step F: archive_pending_recovery legacy flat entry is skipped (no event)', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('archive_pending_recovery');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(0);
  });

  it('Step F: archive_corrupted legacy flat entry maps to corrupted archive state', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('archive_corrupted');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/^\[contract_archive_corrupted\]/);
    expect(entries[0].status).toBe('corrupted');
    expect(entries[0].hasFailure).toBe(true);
  });
});
