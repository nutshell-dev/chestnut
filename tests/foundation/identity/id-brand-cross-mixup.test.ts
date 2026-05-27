import { describe, it, expect } from 'vitest';
import type { ClawId } from '../../../src/foundation/identity/types.js';
import { makeClawId } from '../../../src/foundation/identity/types.js';
import type { ContractId } from '../../../src/core/contract/types.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import type { TaskId } from '../../../src/core/async-task-system/types.js';
import { makeTaskId } from '../../../src/core/async-task-system/types.js';
import type { ToolUseId } from '../../../src/foundation/tool-protocol/index.js';
import { makeToolUseId } from '../../../src/foundation/tool-protocol/index.js';

describe('ID brand cross-mixup forbidden (12 combinations)', () => {
  const clawId: ClawId = makeClawId('claw');
  const contractId: ContractId = makeContractId('contract');
  const taskId: TaskId = makeTaskId('task');
  const toolUseId: ToolUseId = makeToolUseId('tool');

  it('ClawId ↔ ContractId', () => {
    function takeClaw(_: ClawId): void {}
    function takeContract(_: ContractId): void {}
    // @ts-expect-error TS2345
    takeClaw(contractId);
    // @ts-expect-error TS2345
    takeContract(clawId);
    expect(true).toBe(true);
  });

  it('ClawId ↔ TaskId', () => {
    function takeClaw(_: ClawId): void {}
    function takeTask(_: TaskId): void {}
    // @ts-expect-error TS2345
    takeClaw(taskId);
    // @ts-expect-error TS2345
    takeTask(clawId);
    expect(true).toBe(true);
  });

  it('ClawId ↔ ToolUseId', () => {
    function takeClaw(_: ClawId): void {}
    function takeTool(_: ToolUseId): void {}
    // @ts-expect-error TS2345
    takeClaw(toolUseId);
    // @ts-expect-error TS2345
    takeTool(clawId);
    expect(true).toBe(true);
  });

  it('ContractId ↔ TaskId', () => {
    function takeContract(_: ContractId): void {}
    function takeTask(_: TaskId): void {}
    // @ts-expect-error TS2345
    takeContract(taskId);
    // @ts-expect-error TS2345
    takeTask(contractId);
    expect(true).toBe(true);
  });

  it('ContractId ↔ ToolUseId', () => {
    function takeContract(_: ContractId): void {}
    function takeTool(_: ToolUseId): void {}
    // @ts-expect-error TS2345
    takeContract(toolUseId);
    // @ts-expect-error TS2345
    takeTool(contractId);
    expect(true).toBe(true);
  });

  it('TaskId ↔ ToolUseId', () => {
    function takeTask(_: TaskId): void {}
    function takeTool(_: ToolUseId): void {}
    // @ts-expect-error TS2345
    takeTask(toolUseId);
    // @ts-expect-error TS2345
    takeTool(taskId);
    expect(true).toBe(true);
  });

  it('positive control: same-ID assignments pass', () => {
    function takeClaw(_: ClawId): void {}
    function takeContract(_: ContractId): void {}
    function takeTask(_: TaskId): void {}
    function takeTool(_: ToolUseId): void {}
    takeClaw(clawId);
    takeContract(contractId);
    takeTask(taskId);
    takeTool(toolUseId);
    expect(true).toBe(true);
  });
});
