import { describe, it, expect } from 'vitest';
import {
  emitContractVerifierFailed,
  emitContractVerifierSkipped,
  emitContractVerifierStarted,
  emitContractVerifierPassed,
  emitContractVerifierResultParseFailed,
} from '../../../src/core/contract/audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

function makeFakeAudit() {
  const writes: Array<{ event: string; cols: string[] }> = [];
  return {
    audit: { write: (event: string, ...cols: string[]) => { writes.push({ event, cols }); } } as any,
    writes,
  };
}

describe('phase 1151 r127 F fork Step B: verifier emit contractId col', () => {
  it('reverse 1: emit fn opts 强约束 contractId field (ts 编译期 enforce)', () => {
    // 此 test 仅占位、ts 编译报错才是真断言
    const { audit, writes } = makeFakeAudit();
    // @ts-expect-error: contractId required
    emitContractVerifierPassed(audit, { agentId: 'a' });
    expect(writes).toHaveLength(1);
  });

  it('reverse 2: emit 传空字符串 contractId 不掩盖 / cols 含 literal "contractId="', () => {
    const { audit, writes } = makeFakeAudit();
    emitContractVerifierPassed(audit, { contractId: '', agentId: 'verifier-cid-abc-sub1' });
    expect(writes).toHaveLength(1);
    expect(writes[0].event).toBe(CONTRACT_AUDIT_EVENTS.VERIFIER_PASSED);
    expect(writes[0].cols[0]).toBe('contractId=');  // 空字符串不掩盖
    expect(writes[0].cols[1]).toBe('agentId=verifier-cid-abc-sub1');
  });

  it('reverse 3: emit 传正常 contractId / 5 fn cols 全含 contractId= 首位', () => {
    const checks: Array<{ name: string; emit: (audit: any) => void; expectedEvent: string; expectedFirstCol: string }> = [
      {
        name: 'failed',
        emit: (a) => emitContractVerifierFailed(a, { contractId: 'cid-abc-123', agentId: 'aid', clawId: 'claw1', kind: 'k', reason: 'r' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'skipped',
        emit: (a) => emitContractVerifierSkipped(a, { contractId: 'cid-abc-123', agentId: 'aid', reason: 'r' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'started',
        emit: (a) => emitContractVerifierStarted(a, { contractId: 'cid-abc-123', agentId: 'aid', clawId: 'c1' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_STARTED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'passed',
        emit: (a) => emitContractVerifierPassed(a, { contractId: 'cid-abc-123', agentId: 'aid' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_PASSED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'result_parse_failed',
        emit: (a) => emitContractVerifierResultParseFailed(a, { contractId: 'cid-abc-123', agentId: 'aid', clawId: 'c1', stage: 's', reason: 'r' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_RESULT_PARSE_FAILED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
    ];

    for (const c of checks) {
      const { audit, writes } = makeFakeAudit();
      c.emit(audit);
      expect(writes, c.name).toHaveLength(1);
      expect(writes[0].event, c.name).toBe(c.expectedEvent);
      expect(writes[0].cols[0], c.name).toBe(c.expectedFirstCol);  // contractId= 首位、紧跟 agentId
    }
  });
});
