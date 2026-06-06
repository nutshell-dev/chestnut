import { describe, it, expect, vi } from 'vitest';
import { createSummonContractCreateGate } from '../../../src/core/summon-system/contract-create-gate.js';
import { CliError } from '../../../src/cli/errors.js';
import type { SummonStateStore } from '../../../src/core/summon-system/index.js';

function makeStore(decision?: { verify: boolean; targetClaw?: string; mode: 'shadow' | 'mining'; dispatchedAt: string }): SummonStateStore {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockImplementation(async (taskId: string) => {
      if (!decision) return undefined;
      return { taskId, ...decision };
    }),
  };
}

function makeContract(verification?: Array<Record<string, unknown>>) {
  return {
    schema_version: 1,
    title: 'test',
    goal: 'test',
    subtasks: [{ id: 'a', description: 'do it' }],
    verification,
  };
}

describe('SummonContractCreateGate', () => {
  it('subagentTaskId undefined → no-op pass', async () => {
    const gate = createSummonContractCreateGate(makeStore());
    await expect(gate.check(undefined, makeContract([{ subtask_id: 'a', type: 'llm' }]))).resolves.toBeUndefined();
  });

  it('store file missing → audit warn + pass', async () => {
    const audit = { write: vi.fn() };
    const gate = createSummonContractCreateGate(makeStore(), audit as any);
    await expect(gate.check('task-1', makeContract([{ subtask_id: 'a', type: 'llm' }]))).resolves.toBeUndefined();
    expect(audit.write).toHaveBeenCalledWith('summon_gate_no_decision', expect.stringContaining('task-1'), 'reason=likely_non_summon_subagent');
  });

  it('verify=true + verification non-empty → pass', async () => {
    const gate = createSummonContractCreateGate(makeStore({ verify: true, mode: 'shadow', dispatchedAt: '2024-01-01T00:00:00.000Z' }));
    await expect(gate.check('task-1', makeContract([{ subtask_id: 'a', type: 'llm' }]))).resolves.toBeUndefined();
  });

  it('verify=false + verification empty → pass', async () => {
    const gate = createSummonContractCreateGate(makeStore({ verify: false, mode: 'shadow', dispatchedAt: '2024-01-01T00:00:00.000Z' }));
    await expect(gate.check('task-1', makeContract([]))).resolves.toBeUndefined();
  });

  it('verify=false + verification missing → pass', async () => {
    const gate = createSummonContractCreateGate(makeStore({ verify: false, mode: 'shadow', dispatchedAt: '2024-01-01T00:00:00.000Z' }));
    await expect(gate.check('task-1', makeContract())).resolves.toBeUndefined();
  });

  it('verify=false + verification non-empty → throw CliError', async () => {
    const audit = { write: vi.fn() };
    const gate = createSummonContractCreateGate(makeStore({ verify: false, targetClaw: 'foo', mode: 'shadow', dispatchedAt: '2024-01-01T00:00:00.000Z' }), audit as any);
    await expect(gate.check('task-1', makeContract([{ subtask_id: 'a', type: 'llm' }]))).rejects.toThrow(CliError);
    await expect(gate.check('task-1', makeContract([{ subtask_id: 'a', type: 'llm' }]))).rejects.toThrow(/SUMMON_VERIFY_FALSE_VIOLATION/);
    expect(audit.write).toHaveBeenCalledWith('summon_verify_false_violation', expect.stringContaining('task-1'), 'targetClaw=foo', 'verificationCount=1');
  });
});
