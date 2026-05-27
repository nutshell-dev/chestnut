import { describe, it, expect } from 'vitest';
import type { ClawId } from '../../../src/foundation/identity/types.js';
import { makeClawId } from '../../../src/foundation/identity/types.js';
import type { ContractId } from '../../../src/core/contract/types.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import type { TaskId } from '../../../src/foundation/identity/index.js';
import { makeTaskId } from '../../../src/foundation/identity/index.js';
import type { ToolUseId } from '../../../src/foundation/tool-protocol/index.js';
import { makeToolUseId } from '../../../src/foundation/tool-protocol/index.js';
import type { SubtaskId } from '../../../src/core/contract/types.js';
import { makeSubtaskId } from '../../../src/core/contract/types.js';

describe('ID brand cross-mixup forbidden (20 combinations)', () => {
  const clawId: ClawId = makeClawId('claw');
  const contractId: ContractId = makeContractId('contract');
  const taskId: TaskId = makeTaskId('task');
  const toolUseId: ToolUseId = makeToolUseId('tool');
  const subtaskId: SubtaskId = makeSubtaskId('subtask');

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

  it('ClawId ↔ SubtaskId', () => {
    function takeClaw(_: ClawId): void {}
    function takeSubtask(_: SubtaskId): void {}
    // @ts-expect-error TS2345
    takeClaw(subtaskId);
    // @ts-expect-error TS2345
    takeSubtask(clawId);
    expect(true).toBe(true);
  });

  it('ContractId ↔ SubtaskId', () => {
    function takeContract(_: ContractId): void {}
    function takeSubtask(_: SubtaskId): void {}
    // @ts-expect-error TS2345
    takeContract(subtaskId);
    // @ts-expect-error TS2345
    takeSubtask(contractId);
    expect(true).toBe(true);
  });

  it('TaskId ↔ SubtaskId', () => {
    function takeTask(_: TaskId): void {}
    function takeSubtask(_: SubtaskId): void {}
    // @ts-expect-error TS2345
    takeTask(subtaskId);
    // @ts-expect-error TS2345
    takeSubtask(taskId);
    expect(true).toBe(true);
  });

  it('ToolUseId ↔ SubtaskId', () => {
    function takeTool(_: ToolUseId): void {}
    function takeSubtask(_: SubtaskId): void {}
    // @ts-expect-error TS2345
    takeTool(subtaskId);
    // @ts-expect-error TS2345
    takeSubtask(toolUseId);
    expect(true).toBe(true);
  });

  it('positive control: same-ID assignments pass', () => {
    function takeClaw(_: ClawId): void {}
    function takeContract(_: ContractId): void {}
    function takeTask(_: TaskId): void {}
    function takeTool(_: ToolUseId): void {}
    function takeSubtask(_: SubtaskId): void {}
    takeClaw(clawId);
    takeContract(contractId);
    takeTask(taskId);
    takeTool(toolUseId);
    takeSubtask(subtaskId);
    expect(true).toBe(true);
  });
});
