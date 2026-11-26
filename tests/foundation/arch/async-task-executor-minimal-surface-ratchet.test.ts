/**
 * Phase 2248 I: AsyncTaskSystem consumes only owner execution references and
 * delivery capabilities. Assembly binds factories, never task business logic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Phase 2248 I: AsyncTaskSystem minimal execution/delivery surface', () => {
  it('types.ts requires the reference port and keeps the delivery sink', () => {
    const types = read('src/core/async-task-system/types.ts');
    expect(types).toMatch(/export interface TaskExecutionPort \{[\s\S]*?start\(request: TaskExecutionStartRequest\): Promise<TaskExecutionRef>[\s\S]*?\n\}/);
    expect(types).toMatch(/export interface DeliverySink \{[\s\S]*?deliver\(task: SubAgentTask, envelope: ProcessedTaskResult, runtime: TaskDeliveryRuntime\): Promise<DeliveryEvidence>[\s\S]*?\n\}/);
    expect(types).toMatch(/execution: TaskExecutionPort;/);
    expect(types).toMatch(/deliverySink: DeliverySink;/);
    for (const retired of ['TaskExecutor', 'TaskExecutionRuntime', 'ExecutorPayloadAdapter', 'ExecutorPayloadInterpretation']) {
      expect(types).not.toContain(`export interface ${retired}`);
      expect(types).not.toContain(`export type ${retired}`);
    }
  });

  it('AsyncTaskSystemOptions contains no LLM, payload interpreter or per-run tool assembly', () => {
    const types = read('src/core/async-task-system/types.ts');
    const optionsBlock = types.match(/export interface AsyncTaskSystemOptions \{[\s\S]*?\n\}/)?.[0] ?? '';
    for (const banned of ['llm', 'taskExecutor', 'executorPayloadAdapter', 'toolTimeoutMs', 'permissionChecker']) {
      expect(optionsBlock).not.toContain(banned);
    }
  });

  it('subagent execution deps contain only the reference port, input store and ATS-owned processing', () => {
    const executor = read('src/core/async-task-system/subagent-executor.ts');
    const depsBlock = executor.match(/interface ExecuteSubAgentTaskDeps \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(depsBlock).toContain('execution: TaskExecutionPort');
    expect(depsBlock).toContain('inputStore: OwnedExecutionInputStore');
    expect(depsBlock).toContain('deliverySink: DeliverySink');
    for (const banned of ['taskExecutor', 'llm:', 'registry:', 'runSubagent', 'sendResult', 'toolTimeoutMs', 'permissionChecker', 'mainDialogStore']) {
      expect(depsBlock).not.toContain(banned);
    }
  });

  it('the retired Assembly executor is gone and production performs a structural owner handoff', () => {
    expect(fs.existsSync(path.join(root, 'src/assembly/subagent-task-executor.ts'))).toBe(false);
    const executor = read('src/core/async-task-system/subagent-executor.ts');
    expect(executor).not.toContain('runSubagent(');
    expect(executor).not.toContain('createPerTaskRegistry');
    const business = read('src/assembly/business-systems.ts');
    expect(business).toContain('createDefaultSubagentExecutionRunner({');
    expect(business).toContain('const execution: TaskExecutionPort = subagentRunner;');
    expect(business).not.toContain('createSubagentTaskExecutor');
    expect(business).not.toContain('runSubagent');
  });
});
