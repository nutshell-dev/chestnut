/**
 * Contract capacity failure protocol tests
 *
 * Phase 1130 Step C: typed error + audit payload.
 */
import { describe, it, expect, vi } from 'vitest';
import { ContractCapacityError } from '../../../src/core/contract/errors.js';
import {
  CONTRACT_AUDIT_EVENTS,
} from '../../../src/core/contract/audit-events.js';
import { emitContractCapacityExhausted } from '../../../src/core/contract/audit-emit.js';

describe('ContractCapacityError', () => {
  it('carries requested id and active ids', () => {
    const err = new ContractCapacityError('req-1', ['active-1']);
    expect(err.name).toBe('ContractCapacityError');
    expect(err.requestedContractId).toBe('req-1');
    expect(err.activeContractIds).toEqual(['active-1']);
    expect(err.message).toBe('Cannot create contract "req-1": active capacity is full');
  });

  it('sorts active ids for stable output', () => {
    const err = new ContractCapacityError('req-1', ['z-2', 'a-1', 'm-3']);
    expect(err.activeContractIds).toEqual(['a-1', 'm-3', 'z-2']);
  });
});

describe('emitContractCapacityExhausted', () => {
  it('writes requested_contract_id, active_contract_ids and capacity columns', () => {
    const audit = { write: vi.fn() };
    emitContractCapacityExhausted(audit as any, {
      requestedContractId: 'req-1',
      activeContractIds: ['active-1'],
    });

    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.CAPACITY_EXHAUSTED,
      'requested_contract_id=req-1',
      'active_contract_ids=active-1',
      'capacity=1',
    );
  });

  it('emits stable sorted active ids', () => {
    const audit = { write: vi.fn() };
    emitContractCapacityExhausted(audit as any, {
      requestedContractId: 'req-1',
      activeContractIds: ['c-3', 'a-1', 'b-2'],
    });

    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.CAPACITY_EXHAUSTED,
      'requested_contract_id=req-1',
      'active_contract_ids=a-1,b-2,c-3',
      'capacity=1',
    );
  });
});
