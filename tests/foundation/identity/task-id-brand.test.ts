import { describe, it, expect } from 'vitest';
import type { TaskId } from '../../../src/foundation/identity/index.js';
import { makeTaskId } from '../../../src/foundation/identity/index.js';
import type { ContractId } from '../../../src/core/contract/types.js';
import { makeContractId } from '../../../src/core/contract/types.js';

describe('TaskId brand compile-time enforce', () => {
  it('prevents assigning ContractId to TaskId', () => {
    function processTask(_t: TaskId): string {
      return 'ok';
    }
    const contractId: ContractId = makeContractId('contract-1');
    // @ts-expect-error TS2345: ContractId cannot be assigned to TaskId
    processTask(contractId);
    expect(true).toBe(true);
  });

  it('prevents raw string literal assignment to TaskId', () => {
    // @ts-expect-error TS2322: raw string cannot be assigned to TaskId
    const t: TaskId = 'raw-task';
    expect(t).toBeDefined();
  });

  it('allows properly constructed TaskId', () => {
    function processTask(_t: TaskId): string {
      return 'ok';
    }
    const t = makeTaskId('valid-task');
    expect(processTask(t)).toBe('ok');
  });
});
