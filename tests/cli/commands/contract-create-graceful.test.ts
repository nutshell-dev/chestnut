/**
 * CLI contract create graceful format tests (phase 67 Step D)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatContractValidationError } from '../../../src/cli/commands/contract-helpers.js';
import { handleCliError } from '../../../src/cli/errors.js';
import { ContractValidationError, ContractCapacityError } from '../../../src/core/contract/errors.js';

describe('contract create graceful format (phase 67)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formatContractValidationError outputs multi-line user-friendly format', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new ContractValidationError('id', 'empty', 'contract id must not be empty', { contractId: 'c1' });

    formatContractValidationError(err);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('yaml validation failed'));
    expect(stderrSpy).toHaveBeenCalledWith('  field:    id');
    expect(stderrSpy).toHaveBeenCalledWith('  kind:     empty');
    expect(stderrSpy).toHaveBeenCalledWith('  message:  contract id must not be empty');
    expect(stderrSpy).toHaveBeenCalledWith('  context:');
    expect(stderrSpy).toHaveBeenCalledWith('    contractId: c1');

    stderrSpy.mockRestore();
  });

  it('handleCliError for ContractValidationError returns 1 and formats output', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new ContractValidationError('verification', 'duplicate', 'duplicate subtask', { subtaskId: 's1' });

    const code = handleCliError(err);

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('yaml validation failed'));
    expect(stderrSpy).toHaveBeenCalledWith('  field:    verification');
    expect(stderrSpy).toHaveBeenCalledWith('  kind:     duplicate');
    expect(stderrSpy).toHaveBeenCalledWith('    subtaskId: s1');
    // no stack trace
    const stderrCalls = stderrSpy.mock.calls.map(c => c[0] as string);
    const hasStack = stderrCalls.some(s => s.includes('at ') || s.includes('ContractValidationError'));
    expect(hasStack).toBe(false);

    stderrSpy.mockRestore();
  });

  it('handleCliError for non-ContractValidationError still works', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = handleCliError(new Error('generic error'));
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith('Error:', 'generic error');
    stderrSpy.mockRestore();
  });

  it('handleCliError for ContractCapacityError returns 1 with actionable guidance', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new ContractCapacityError('new-id', ['existing-id']);

    const code = handleCliError(err);

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith('[contract create] active capacity is full:');
    expect(stderrSpy).toHaveBeenCalledWith('  requested: new-id');
    expect(stderrSpy).toHaveBeenCalledWith('  active:    existing-id');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fix: wait for the active contract to complete'),
    );

    const stderrCalls = stderrSpy.mock.calls.map(c => c[0] as string);
    const hasStack = stderrCalls.some(s => s.includes('at ') || s.includes('ContractCapacityError'));
    expect(hasStack).toBe(false);

    stderrSpy.mockRestore();
  });
});
