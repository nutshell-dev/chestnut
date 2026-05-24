import { describe, it, expect, vi } from 'vitest';
import {
  emitContractPassed,
  emitContractSubtaskCompleted,
  emitContractAcceptanceStarted,
} from '../../../src/core/contract/audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

describe('contract typed audit emit (phase 1141)', () => {
  const makeAudit = () => ({ write: vi.fn() as ReturnType<typeof vi.fn> });

  // 主路径
  it('emitContractPassed split contractId + subtaskId 2 cols (key fix site acceptance.ts:202)', () => {
    const audit = makeAudit();
    emitContractPassed(audit, { contractId: 'c_abc', subtaskId: 'st_xyz' });
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.PASSED,
      'contractId=c_abc',
      'subtaskId=st_xyz',
    );
    // 确认: 无 single `c_abc/st_xyz` 复合 col
  });

  it('emitContractSubtaskCompleted 4 typed fields serialize', () => {
    const audit = makeAudit();
    emitContractSubtaskCompleted(audit, {
      contractId: 'c_abc', subtaskId: 'st_xyz', progress: '2/5', claw: 'motion',
    });
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED,
      'contractId=c_abc',
      'subtaskId=st_xyz',
      'progress=2/5',
      'claw=motion',
    );
  });

  it('emitContractAcceptanceStarted serializes contractId + subtaskId', () => {
    const audit = makeAudit();
    emitContractAcceptanceStarted(audit, { contractId: 'c_abc', subtaskId: 'st_xyz' });
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.ACCEPTANCE_STARTED,
      'contractId=c_abc',
      'subtaskId=st_xyz',
    );
  });

  // 反向 1: 删 emit fn audit.write 调用
  it('反向 1: emit fn 实然调 audit.write', () => {
    const audit = makeAudit();
    emitContractPassed(audit, { contractId: 'x', subtaskId: 'y' });
    expect(audit.write).toHaveBeenCalled();
  });

  // 反向 2: TS 编译期 enforce contractId/subtaskId 类型
  it('反向 2: typed payload key TS enforce', () => {
    const audit = makeAudit();
    // @ts-expect-error 故意 typo 验证 TS 编译期 enforce
    emitContractPassed(audit, { contract: 'x', subtask: 'y' });
    expect(audit.write).toHaveBeenCalledTimes(1);
  });

  // 反向 3: 不含 `${contractId}/${subtaskId}` 复合 col
  it('反向 3: cascade 后 row 不含 `/` separator 复合 col', () => {
    const audit = makeAudit();
    emitContractPassed(audit, { contractId: 'c_abc', subtaskId: 'st_xyz' });
    const callArgs = audit.write.mock.calls[0] as unknown as unknown[];
    // 确认 cols 都用 typed `<key>=<val>` 形态、无 `c_abc/st_xyz` 复合 col
    const compositeCount = callArgs.filter((c) =>
      typeof c === 'string' && c.includes('/') && !c.startsWith('progress=') && !c.includes('=')
    ).length;
    expect(compositeCount).toBe(0);
  });
});
