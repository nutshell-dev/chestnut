/**
 * Phase 1808 Step B (MEMORY-CONTRACT-BRIDGE-DISPOSE-FAILURE-SILENT):
 * bridge 缓存 ContractSystem close typed outcome 专测。
 *
 * phase 1807 后 close 所有权上移装配层（motion-addons disposeContractSystems），
 * 本专测锁定新 owner 行为：`closeBridgeContractSystems` 返回 exhaustive
 * `ContractBridgeDisposeResult`（complete | partial_failure{failures}），
 * 每个失败携带 clawId identity 与原始 error 的 formatErr 投影；
 * 单个失败不阻其他 close；失败归因按 cache identity 而非 settle 顺序；
 * 下游 caller（disassemble Step 0）对 partial_failure 写
 * DISASSEMBLE_STEP_FAILED audit（逐条 clawId:error），complete 不写。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  closeBridgeContractSystems,
  type ContractBridgeDisposeResult,
} from '../../src/assembly/contract-bridge-dispose.js';
import { disassemble } from '../../src/assembly/disassemble.js';
import { ASSEMBLY_AUDIT_EVENTS } from '../../src/assembly/audit-events.js';
import type { Runtime } from '../../src/core/runtime/index.js';
import type { StreamWriter } from '../../src/foundation/stream/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

function closeable(close: () => Promise<void>) {
  return { close: vi.fn(close) };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** caller 侧穷尽 reducer：新增 kind 时 never 检查编译失败。 */
function reduceResult(result: ContractBridgeDisposeResult): string {
  switch (result.kind) {
    case 'complete':
      return 'all-closed';
    case 'partial_failure':
      return `failed:${result.failures.map(f => `${f.clawId}=${f.error}`).join(',')}`;
    default: {
      const exhaustive: never = result;
      throw new Error(`unhandled result kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

describe('phase 1808: closeBridgeContractSystems typed outcome', () => {
  it('全部 close 成功 → {kind:complete}，每个条目 close 恰一次', async () => {
    const entries = [
      { clawId: 'claw-a', cs: closeable(async () => {}) },
      { clawId: 'claw-b', cs: closeable(async () => {}) },
    ];
    const result = await closeBridgeContractSystems(entries);
    expect(result).toEqual({ kind: 'complete' });
    expect(entries[0].cs.close).toHaveBeenCalledTimes(1);
    expect(entries[1].cs.close).toHaveBeenCalledTimes(1);
    expect(reduceResult(result)).toBe('all-closed');
  });

  it('单个 close rejected → partial_failure 携带 clawId 与原始 error', async () => {
    const result = await closeBridgeContractSystems([
      { clawId: 'claw-a', cs: closeable(async () => {}) },
      { clawId: 'claw-b', cs: closeable(async () => { throw new Error('disk gone'); }) },
    ]);
    expect(result).toEqual({
      kind: 'partial_failure',
      failures: [{ clawId: 'claw-b', error: 'disk gone' }],
    });
    expect(reduceResult(result)).toBe('failed:claw-b=disk gone');
  });

  it('mixed：一个失败不阻其他 close，failures 只含 rejected 项', async () => {
    const entries = [
      { clawId: 'claw-a', cs: closeable(async () => {}) },
      { clawId: 'claw-b', cs: closeable(async () => { throw new Error('lock busy'); }) },
      { clawId: 'claw-c', cs: closeable(async () => {}) },
    ];
    const result = await closeBridgeContractSystems(entries);
    expect(entries.every(e => e.cs.close.mock.calls.length === 1)).toBe(true);
    expect(result).toEqual({
      kind: 'partial_failure',
      failures: [{ clawId: 'claw-b', error: 'lock busy' }],
    });
  });

  it('原始 error 保留：非 Error rejection 经 formatErr 投影为字符串', async () => {
    const result = await closeBridgeContractSystems([
      { clawId: 'claw-a', cs: closeable(async () => { throw 'raw boom'; }) },
    ]);
    expect(result).toEqual({
      kind: 'partial_failure',
      failures: [{ clawId: 'claw-a', error: 'raw boom' }],
    });
  });

  it('失败归因按 cache identity 而非 Promise settle 顺序', async () => {
    // claw-a 的 close 后 settle（reject），claw-b 先 resolve——
    // 失败必须归因 claw-a，而非先 settle 的 claw-b。
    const slow = deferred();
    const pending = closeBridgeContractSystems([
      { clawId: 'claw-a', cs: closeable(() => slow.promise) },
      { clawId: 'claw-b', cs: closeable(async () => {}) },
    ]);
    slow.reject(new Error('late failure'));
    const result = await pending;
    expect(result).toEqual({
      kind: 'partial_failure',
      failures: [{ clawId: 'claw-a', error: 'late failure' }],
    });
  });

  it('空集合 → complete（无可观察失败）', async () => {
    expect(await closeBridgeContractSystems([])).toEqual({ kind: 'complete' });
  });
});

describe('phase 1808: disassemble Step 0 消费 typed outcome', () => {
  function makeInstances(disposeContractSystems?: () => Promise<ContractBridgeDisposeResult>) {
    return {
      auditWriter: { write: vi.fn() } as unknown as AuditLog,
      runtime: { stop: vi.fn(async () => {}) } as unknown as Runtime,
      streamWriter: { close: vi.fn() } as unknown as StreamWriter,
      disposeContractSystems,
    };
  }

  function step0AuditCalls(auditWriter: AuditLog) {
    return (auditWriter.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      c => c[0] === ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED && c[1] === 'step=dispose_contract_systems',
    );
  }

  it('partial_failure → DISASSEMBLE_STEP_FAILED audit 逐条携带 clawId 与 error', async () => {
    const instances = makeInstances(async () => ({
      kind: 'partial_failure',
      failures: [
        { clawId: 'claw-a', error: 'disk gone' },
        { clawId: 'claw-b', error: 'lock busy' },
      ],
    }));
    await disassemble(instances, 'SIGTERM');
    expect(step0AuditCalls(instances.auditWriter)).toEqual([
      [
        ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED,
        'step=dispose_contract_systems',
        'result=partial_failure',
        'failure=claw-a:disk gone',
        'failure=claw-b:lock busy',
      ],
    ]);
  });

  it('complete → 不写 Step 0 失败 audit，后续步骤照常', async () => {
    const instances = makeInstances(async () => ({ kind: 'complete' }));
    await disassemble(instances, 'SIGTERM');
    expect(step0AuditCalls(instances.auditWriter)).toEqual([]);
    expect(instances.runtime.stop).toHaveBeenCalled();
  });

  it('disposeContractSystems 缺席 → 无 Step 0 audit（claw 身份不装 bridge）', async () => {
    const instances = makeInstances(undefined);
    await disassemble(instances, 'SIGTERM');
    expect(step0AuditCalls(instances.auditWriter)).toEqual([]);
    expect(instances.runtime.stop).toHaveBeenCalled();
  });
});
