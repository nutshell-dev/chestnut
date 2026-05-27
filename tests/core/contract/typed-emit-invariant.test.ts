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

describe('phase 1235 r132 B.3: typed emit empty contractId invariant', () => {
  it('reverse 1: emit fn with valid contractId → no invariant violation + cols emit', () => {
    const { audit, writes } = makeFakeAudit();
    emitContractVerifierPassed(audit, { contractId: 'cid-valid-123', agentId: 'aid' });
    expect(writes).toHaveLength(1);
    expect(writes[0].event).toBe(CONTRACT_AUDIT_EVENTS.VERIFIER_PASSED);
    expect(writes[0].cols[0]).toBe('contractId=cid-valid-123');
    expect(writes[0].cols[1]).toBe('agentId=aid');
  });

  it('reverse 2: emit fn with empty contractId → invariant emit + 0 cols emit + early return', () => {
    const { audit, writes } = makeFakeAudit();
    emitContractVerifierPassed(audit, { contractId: '', agentId: 'verifier-cid-abc-sub1' });
    expect(writes).toHaveLength(1);
    expect(writes[0].event).toBe(CONTRACT_AUDIT_EVENTS.TYPED_EMIT_INVARIANT_VIOLATION);
    expect(writes[0].cols).toContain('field=contractId');
    expect(writes[0].cols).toContain('event=emitContractVerifierPassed');
    expect(writes[0].cols).toContain('reason=empty_string');
  });

  it('reverse 3: 5 verifier emit fn 各 verify invariant 触发统一', () => {
    const checks: Array<{ name: string; emit: (audit: any) => void; expectedFnName: string }> = [
      {
        name: 'failed',
        emit: (a) => emitContractVerifierFailed(a, { contractId: '', agentId: 'aid', clawId: 'claw1', kind: 'k', reason: 'r' }),
        expectedFnName: 'emitContractVerifierFailed',
      },
      {
        name: 'skipped',
        emit: (a) => emitContractVerifierSkipped(a, { contractId: '', agentId: 'aid', reason: 'r' }),
        expectedFnName: 'emitContractVerifierSkipped',
      },
      {
        name: 'started',
        emit: (a) => emitContractVerifierStarted(a, { contractId: '', agentId: 'aid', clawId: 'c1' }),
        expectedFnName: 'emitContractVerifierStarted',
      },
      {
        name: 'passed',
        emit: (a) => emitContractVerifierPassed(a, { contractId: '', agentId: 'aid' }),
        expectedFnName: 'emitContractVerifierPassed',
      },
      {
        name: 'result_parse_failed',
        emit: (a) => emitContractVerifierResultParseFailed(a, { contractId: '', agentId: 'aid', clawId: 'c1', stage: 's', reason: 'r' }),
        expectedFnName: 'emitContractVerifierResultParseFailed',
      },
    ];

    for (const c of checks) {
      const { audit, writes } = makeFakeAudit();
      c.emit(audit);
      expect(writes, c.name).toHaveLength(1);
      expect(writes[0].event, c.name).toBe(CONTRACT_AUDIT_EVENTS.TYPED_EMIT_INVARIANT_VIOLATION);
      expect(writes[0].cols, c.name).toContain('field=contractId');
      expect(writes[0].cols, c.name).toContain(`event=${c.expectedFnName}`);
      expect(writes[0].cols, c.name).toContain('reason=empty_string');
    }
  });
});
