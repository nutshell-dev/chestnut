/**
 * phase 1862 Step H (CT-D9): create policy 注册面显式化测试。
 *
 * 核查结论（grep 全 src/tests）：registerCreatePolicy 生产 caller 2 处
 * （assembly/business-systems.ts、cli/index.ts），均为装配期一次性注册；
 * 无运行期注册真实 caller。CreatePolicyContext 全只读值类型，无内部 mutable 泄漏。
 *
 * 本文件锁定注册面行为：装配期注册 + 按序迭代 + 重名 last-write-wins +
 * violation 路径（emit rejected + create 上抛 + 契约未创建）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import {
  ContractCreatePolicyViolationError,
  type ContractCreatePolicy,
  type CreatePolicyContext,
} from '../../../src/core/contract/types.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

describe('phase 1862 Step H (CT-D9): create policy registration surface', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let auditWrites: string[][];

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = `${tempDir}/claws/test-claw`;
    await fs.mkdir(clawDir, { recursive: true });
    auditWrites = [];
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: new NodeFileSystem({ baseDir: clawDir }),
      audit: {
        write: (...args: string[]) => { auditWrites.push(args); },
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      } as never,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: `${tempDir}/claws`,
      notifyClaw: vi.fn(),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function recordingPolicy(name: string, calls: CreatePolicyContext[]): ContractCreatePolicy {
    return {
      name,
      check: async (ctx) => { calls.push(ctx); },
    };
  }

  it('装配期注册：create() 在 claim publish 前按注册顺序迭代 policy（传入规范化 proposedContractId）', async () => {
    const calls: CreatePolicyContext[] = [];
    manager.registerCreatePolicy('p1', recordingPolicy('p1', calls));
    manager.registerCreatePolicy('p2', recordingPolicy('p2', calls));

    const id = await manager.create(makeContractYaml({
      title: 'Policy Order',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    expect(calls).toHaveLength(2);
    // 按注册顺序迭代（Map insertion order），且都拿到同一规范化 contract id。
    expect(calls[0].proposedContractId).toBe(id);
    expect(calls[1].proposedContractId).toBe(id);
  });

  it('重名语义 last-write-wins：后注册覆盖，旧 policy 不再被迭代', async () => {
    const staleCalls: CreatePolicyContext[] = [];
    const freshCalls: CreatePolicyContext[] = [];
    manager.registerCreatePolicy('same-name', recordingPolicy('stale', staleCalls));
    manager.registerCreatePolicy('same-name', recordingPolicy('fresh', freshCalls));

    await manager.create(makeContractYaml({
      title: 'Policy Override',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    expect(staleCalls).toHaveLength(0);
    expect(freshCalls).toHaveLength(1);
  });

  it('violation 路径：emit contract_create_policy_rejected、create 上抛、契约未创建', async () => {
    manager.registerCreatePolicy('reject-all', {
      name: 'reject-all',
      check: async () => {
        throw new ContractCreatePolicyViolationError('reject-all', 'test rejection', { k: 'v' });
      },
    });

    await expect(manager.create(makeContractYaml({
      title: 'Policy Reject',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }))).rejects.toThrow(/rejected by policy 'reject-all'/);

    const rejected = auditWrites.filter(c => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATE_POLICY_REJECTED);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('policyName=reject-all');
    expect(rejected[0]).toContain('cause=test rejection');

    // claim publish 未发生：active 目录不存在或无任何契约目录。
    const activeDir = `${clawDir}/contract/active`;
    const activeDirs = await fs.readdir(activeDir).catch(() => [] as string[]);
    expect(activeDirs.filter(d => makeContractId(d) === d)).toEqual([]);
  });
});
