import { describe, it, expect } from 'vitest';
import type { ClawId } from '../../../src/foundation/identity/types.js';
import { makeClawId } from '../../../src/foundation/identity/types.js';
import type { ContractId } from '../../../src/foundation/identity/index.js';
import { makeContractId } from '../../../src/foundation/identity/index.js';
import type { TaskId } from '../../../src/core/async-task-system/types.js';
import { makeTaskId } from '../../../src/core/async-task-system/types.js';
import type { ToolUseId } from '../../../src/foundation/tool-protocol/index.js';
import { makeToolUseId } from '../../../src/foundation/tool-protocol/index.js';
import type { SubtaskId, ArchiveDir } from '../../../src/core/contract/types.js';
import { makeSubtaskId, makeArchiveDir } from '../../../src/core/contract/types.js';
import type { ClawDir, ChestnutRoot } from '../../../src/foundation/identity/types.js';
import { makeClawDir, makeChestnutRoot } from '../../../src/foundation/identity/types.js';

describe('ID brand cross-mixup forbidden (32 combinations)', () => {
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

  it('ClawDir ↔ ClawId', () => {
    const clawDir: ClawDir = makeClawDir('/claw');
    function takeClawDir(_: ClawDir): void {}
    function takeClaw(_: ClawId): void {}
    // @ts-expect-error TS2345
    takeClawDir(clawId);
    // @ts-expect-error TS2345
    takeClaw(clawDir);
    expect(true).toBe(true);
  });

  it('ClawDir ↔ ContractId', () => {
    const clawDir: ClawDir = makeClawDir('/claw');
    function takeClawDir(_: ClawDir): void {}
    function takeContract(_: ContractId): void {}
    // @ts-expect-error TS2345
    takeClawDir(contractId);
    // @ts-expect-error TS2345
    takeContract(clawDir);
    expect(true).toBe(true);
  });

  it('ChestnutRoot ↔ TaskId', () => {
    const root: ChestnutRoot = makeChestnutRoot('/root');
    function takeRoot(_: ChestnutRoot): void {}
    function takeTask(_: TaskId): void {}
    // @ts-expect-error TS2345
    takeRoot(taskId);
    // @ts-expect-error TS2345
    takeTask(root);
    expect(true).toBe(true);
  });

  it('ArchiveDir ↔ ToolUseId', () => {
    const archiveDir: ArchiveDir = makeArchiveDir('/archive');
    function takeArchive(_: ArchiveDir): void {}
    function takeTool(_: ToolUseId): void {}
    // @ts-expect-error TS2345
    takeArchive(toolUseId);
    // @ts-expect-error TS2345
    takeTool(archiveDir);
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
