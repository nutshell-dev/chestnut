/**
 * Phase 63 Step G: event-collector formatContractEvent status 分支测试
 */

import { describe, it, expect } from 'vitest';
import { scanArchivedContracts } from '../../../../src/core/contract/jobs/event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';
import { makeAudit } from '../../../helpers/audit.js';

interface MakeFsOpts {
  /** 注入异常：这些目录的 async list 抛错（模拟 intent 列表失败） */
  failListDirs?: readonly string[];
  /** 意图目录条目（async list 用，name 不带 isDirectory 语义差异） */
  intentFiles?: Record<string, string>;
}

function makeFs(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
  opts?: MakeFsOpts,
): FileSystem {
  const fileMap = new Map(Object.entries(files));
  const dirMap = new Map(
    Object.entries(dirs).map(([d, names]) => [d, names.map(name => ({ name, isDirectory: true, size: 0 }))]),
  );
  const intentDirMap = new Map(
    Object.entries(opts?.intentFiles ?? {}).map(([d, names]) => [d, names.map(name => ({ name, isDirectory: false, size: 0 }))]),
  );
  const failList = new Set(opts?.failListDirs ?? []);
  return {
    listSync: (p: string) => dirMap.get(p) ?? [],
    readSync: (p: string) => {
      if (fileMap.has(p)) return fileMap.get(p)!;
      throw new Error('ENOENT');
    },
    existsSync: () => true,
    exists: async (p: string) => dirMap.has(p) || fileMap.has(p) || intentDirMap.has(p),
    list: async (p: string) => {
      if (failList.has(p)) throw new Error('EIO: simulated list failure');
      return dirMap.get(p) ?? intentDirMap.get(p) ?? [];
    },
    read: async (p: string) => {
      if (fileMap.has(p)) return fileMap.get(p)!;
      throw new Error('ENOENT');
    },
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
    expect(entries[0].body).toContain('历史验收反馈（该子任务保留的最近一次未通过反馈，不能仅凭此记录判断最终验收结论）：曾缺测试');
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

  it('cancelled（legacy flat + cancelled: checkpoint）→ phase 1833 新正文：历史检查点来源 + status/reason 字段', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('cancelled', 'cancelled: user manual');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约已取消｜c1\n'
      + '执行者：clawA\n'
      + '历史检查点记录的取消原因：user manual',
    );
    expect(entries[0].status).toBe('cancelled');
    // ArchivedContractEntry.reason 保持既有兼容串值（独立于新中文正文）
    expect(entries[0].reason).toBe('user manual');
  });

  it('cancelled（current 容器 + 单个取消请求 intent）→ 记录中的取消请求原因', async () => {
    const { audit } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/cancelled/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1',
        status: 'cancelled',
        subtasks: {},
      }),
      '/tmp/claw/contract/archive/cancelled/c1/contract.yaml': 'title: T1\ngoal: G1\n',
      '/tmp/claw/contract/lifecycle-intents/c1/req-1.json': JSON.stringify({
        schema_version: 1,
        request_id: 'req-1',
        contract_id: 'c1',
        requested_state: 'cancelled',
        requested_at: '2026-09-13T00:00:00.000Z',
        reason: '需求变了',
      }),
    }, {
      '/tmp/claw/contract/archive': ['cancelled'],
      '/tmp/claw/contract/archive/cancelled': ['c1'],
    }, {
      intentFiles: { '/tmp/claw/contract/lifecycle-intents/c1': ['req-1.json'] },
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约已取消｜T1（c1）\n'
      + '执行者：clawA\n'
      + '原目标：G1\n'
      + '记录中的取消请求原因：\n'
      + '  - 需求变了',
    );
    expect(entries[0].reason).toBe('需求变了');
  });

  it('cancelled 多请求不同原因（含相同内容）→ 逐条完整保留不去重、不择一冒称最终原因', async () => {
    const { audit } = makeAudit();
    const intent = (id: string, at: string, reason: string) => JSON.stringify({
      schema_version: 1, request_id: id, contract_id: 'c1',
      requested_state: 'cancelled', requested_at: at, reason,
    });
    const fs = makeFs({
      '/tmp/claw/contract/archive/cancelled/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1', status: 'cancelled', subtasks: {},
      }),
      '/tmp/claw/contract/lifecycle-intents/c1/req-1.json': intent('req-1', '2026-09-13T00:00:00.000Z', '原因甲'),
      '/tmp/claw/contract/lifecycle-intents/c1/req-2.json': intent('req-2', '2026-09-13T01:00:00.000Z', '原因乙'),
      '/tmp/claw/contract/lifecycle-intents/c1/req-3.json': intent('req-3', '2026-09-13T02:00:00.000Z', '原因甲'),
    }, {
      '/tmp/claw/contract/archive': ['cancelled'],
      '/tmp/claw/contract/archive/cancelled': ['c1'],
    }, {
      intentFiles: { '/tmp/claw/contract/lifecycle-intents/c1': ['req-1.json', 'req-2.json', 'req-3.json'] },
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain(
      '记录中的取消请求原因：\n  - 原因甲\n  - 原因乙\n  - 原因甲',
    );
    expect(entries[0].reason).toBe('requests: 原因甲; 原因乙; 原因甲');
  });

  it('cancelled 请求原因为空白 → 明示该条未填写', async () => {
    const { audit } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/cancelled/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1', status: 'cancelled', subtasks: {},
      }),
      '/tmp/claw/contract/lifecycle-intents/c1/req-1.json': JSON.stringify({
        schema_version: 1, request_id: 'req-1', contract_id: 'c1',
        requested_state: 'cancelled', requested_at: '2026-09-13T00:00:00.000Z', reason: ' ',
      }),
    }, {
      '/tmp/claw/contract/archive': ['cancelled'],
      '/tmp/claw/contract/archive/cancelled': ['c1'],
    }, {
      intentFiles: { '/tmp/claw/contract/lifecycle-intents/c1': ['req-1.json'] },
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries[0].body).toContain('  - （该条未填写原因）');
  });

  it('cancelled 单文件坏（非法 JSON）→ 已读取部分保留 + 部分读取失败注记 + 真实审计', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/cancelled/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1', status: 'cancelled', subtasks: {},
      }),
      '/tmp/claw/contract/lifecycle-intents/c1/req-1.json': JSON.stringify({
        schema_version: 1, request_id: 'req-1', contract_id: 'c1',
        requested_state: 'cancelled', requested_at: '2026-09-13T00:00:00.000Z', reason: '已读到的理由',
      }),
      '/tmp/claw/contract/lifecycle-intents/c1/req-2.json': '{not-json',
    }, {
      '/tmp/claw/contract/archive': ['cancelled'],
      '/tmp/claw/contract/archive/cancelled': ['c1'],
    }, {
      intentFiles: { '/tmp/claw/contract/lifecycle-intents/c1': ['req-1.json', 'req-2.json'] },
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('  - 已读到的理由');
    expect(entries[0].body).toContain('部分原因记录读取失败，以上为已读取部分');
    expect(entries[0].body).not.toContain('req-2');
    // 读取异常经真实审计链暴露（不再是空审计器静默吞）
    const issue = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE);
    expect(issue).toBeDefined();
    expect(issue).toContain('requestId=req-2');
    expect(issue).toContain('reason=parse_failed');
  });

  it('cancelled intent 列表失败 → 不制造「无原因」假结论，统一「未取得」措辞 + 审计 list_failed', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/cancelled/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1', status: 'cancelled', subtasks: {},
      }),
    }, {
      '/tmp/claw/contract/archive': ['cancelled'],
      '/tmp/claw/contract/archive/cancelled': ['c1'],
    }, {
      intentFiles: { '/tmp/claw/contract/lifecycle-intents/c1': ['req-1.json'] },
      failListDirs: ['/tmp/claw/contract/lifecycle-intents/c1'],
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约已取消｜c1\n执行者：clawA\n本次未取得取消原因记录',
    );
    const issue = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE);
    expect(issue).toBeDefined();
    expect(issue).toContain('reason=list_failed');
  });

  it('cancelled（无请求、无 checkpoint）→ 本次未取得取消原因记录，不断言无原因', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('cancelled');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约已取消｜c1\n执行者：clawA\n本次未取得取消原因记录',
    );
    expect(entries[0].reason).toBe('(no reason given)');
  });

  it('cancelled（非取消 checkpoint）→ 不当原因，单列历史检查点记录完整保留', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('cancelled', 'paused: waiting for review');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约已取消｜c1\n'
      + '执行者：clawA\n'
      + '本次未取得取消原因记录\n'
      + '历史检查点记录：paused: waiting for review',
    );
    // 兼容串值保持原样（phase 1833 前行为：非取消 checkpoint 原值）
    expect(entries[0].reason).toBe('paused: waiting for review');
  });

  it('cancelled（cancelled: 前缀后为空）→ 说明未取得原因', async () => {
    const { audit } = makeAudit();
    const fs = makeFsForStatus('cancelled', 'cancelled: ');
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('历史检查点有取消标记，本次未取得取消原因记录');
    expect(entries[0].reason).toBe('(no reason given)');
  });

  it('cancelled（取消前部分完成）→ 取消前已完成子任务 ID，不称其余未开始', async () => {
    const { audit } = makeAudit();
    const fs = makeFs({
      '/tmp/claw/contract/archive/c1/progress.json': JSON.stringify({ schema_version: 1,
        contract_id: 'c1',
        status: 'cancelled',
        checkpoint: 'cancelled: 用户中止',
        subtasks: {
          'st-1': { status: 'completed', completed_at: '2026-09-01T00:00:00Z' },
          'st-2': { status: 'todo' },
        },
      }),
    }, {
      '/tmp/claw/contract/archive': ['c1'],
    });
    const { entries } = await scanArchivedContracts(fs, '/tmp/claw', 'clawA', audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe(
      '契约已取消｜c1\n'
      + '执行者：clawA\n'
      + '历史检查点记录的取消原因：用户中止\n'
      + '取消前已完成子任务：\n'
      + '  [st-1]',
    );
    expect(entries[0].body).not.toContain('st-2');
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
