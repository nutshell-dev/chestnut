import { describe, it, expect } from 'vitest';
import type { SubtaskId } from '../../../src/core/contract/types.js';
import { makeSubtaskId } from '../../../src/core/contract/types.js';
import type { ContractId } from '../../../src/core/contract/types.js';
import { makeContractId } from '../../../src/core/contract/types.js';

describe('SubtaskId brand compile-time enforce', () => {
  it('prevents assigning ContractId to SubtaskId', () => {
    function processSubtask(_s: SubtaskId): string {
      return 'ok';
    }
    const contractId: ContractId = makeContractId('contract-1');
    // @ts-expect-error TS2345: ContractId cannot be assigned to SubtaskId
    processSubtask(contractId);
    expect(true).toBe(true);
  });

  it('prevents raw string literal assignment to SubtaskId', () => {
    // @ts-expect-error TS2322: raw string cannot be assigned to SubtaskId
    const s: SubtaskId = 'rawStr';
    expect(s).toBeDefined();
  });

  it('allows properly constructed SubtaskId', () => {
    function processSubtask(_s: SubtaskId): string {
      return 'ok';
    }
    const s = makeSubtaskId('valid-subtask');
    expect(processSubtask(s)).toBe('ok');
  });
});
