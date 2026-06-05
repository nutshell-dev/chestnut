import { describe, it, expect } from 'vitest';
import type { ContractId } from '../../../src/core/contract/types.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import type { ClawId } from '../../../src/foundation/identity/types.js';
import { makeClawId } from '../../../src/foundation/identity/types.js';

describe('ContractId brand compile-time enforce', () => {
  it('prevents assigning ClawId to ContractId', () => {
    function processContract(_c: ContractId): string {
      return 'ok';
    }
    const clawId: ClawId = makeClawId('motion');
    // @ts-expect-error TS2345: ClawId cannot be assigned to ContractId
    processContract(clawId);
    expect(true).toBe(true);
  });

  it('prevents raw string literal assignment to ContractId', () => {
    // @ts-expect-error TS2322: raw string cannot be assigned to ContractId
    const c: ContractId = 'rawStr';
    expect(c).toBeDefined();
  });

  it('allows properly constructed ContractId', () => {
    function processContract(_c: ContractId): string {
      return 'ok';
    }
    const c = makeContractId('valid-contract');
    expect(processContract(c)).toBe('ok');
  });
});
