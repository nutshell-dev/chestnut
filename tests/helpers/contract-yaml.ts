import type { ContractYaml } from '../../src/core/contract/types.js';

/**
 * Test helper: build a ContractYaml literal with sane defaults + overrides.
 *
 * Mirror src/core/contract/types.ts:12 ContractYaml interface.
 * Schema drift → tsc fails here AND in callers (per phase 703 D-3 / ML「编译器检查」).
 *
 * @param overrides Partial fields to override defaults.
 */
export function makeContractYaml(
  overrides: Partial<ContractYaml> = {},
): ContractYaml {
  return {
    schema_version: 1,
    title: 'Test Contract',
    goal: 'Test goal',
    deliverables: ['clawspace/test.txt'],
    subtasks: [
      { id: 'task-1', description: 'Task 1' },
    ],
    verification: [
      { subtask_id: 'task-1', type: 'script', script_file: 'verification/task-1.sh' },
    ],
    auth_level: 'auto',
    ...overrides,
  };
}
