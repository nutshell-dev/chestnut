/**
 * phase 1863 (AT-D5)：AsyncTaskSystem 最小执行/交付面锁——
 * 通用调度核心只持 TaskExecutor/DeliverySink 接口；业务装配（LLM/registry/runSubagent/
 * payload 解释/delivery 实现）不得回流进核心 deps。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1863 (AT-D5): AsyncTaskSystem minimal execution/delivery surface', () => {
  it('types.ts 定义 TaskExecutor/DeliverySink 最小面并作为 AsyncTaskSystemOptions 注入项', () => {
    const types = read('src/core/async-task-system/types.ts');
    expect(types).toMatch(/export interface TaskExecutor \{[\s\S]*?execute\(task: SubAgentTask, signal: AbortSignal, runtime: TaskExecutionRuntime\): Promise<TaskExecutionOutcome>[\s\S]*?\n\}/);
    expect(types).toMatch(/export interface DeliverySink \{[\s\S]*?deliver\(task: SubAgentTask, envelope: ProcessedTaskResult, runtime: TaskDeliveryRuntime\): Promise<void>[\s\S]*?\n\}/);
    expect(types).toMatch(/taskExecutor: TaskExecutor;/);
    expect(types).toMatch(/deliverySink: DeliverySink;/);
  });

  it('AsyncTaskSystemOptions 不含执行业务装配面（llm/executorPayloadAdapter/toolTimeoutMs/permissionChecker）', () => {
    const types = read('src/core/async-task-system/types.ts');
    const optionsBlock = types.match(/export interface AsyncTaskSystemOptions \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(optionsBlock).not.toContain('llm');
    expect(optionsBlock).not.toContain('executorPayloadAdapter');
    expect(optionsBlock).not.toContain('toolTimeoutMs');
    expect(optionsBlock).not.toContain('permissionChecker');
  });

  it('executor deps 收窄为最小面：taskExecutor/deliverySink 在场，执行装配字段不在场', () => {
    const executor = read('src/core/async-task-system/subagent-executor.ts');
    const depsBlock = executor.match(/interface ExecuteSubAgentTaskDeps \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(depsBlock).toContain('taskExecutor: TaskExecutor');
    expect(depsBlock).toContain('deliverySink: DeliverySink');
    for (const banned of ['llm:', 'registry:', 'runSubagent', 'sendResult', 'toolTimeoutMs', 'permissionChecker', 'mainDialogStore']) {
      expect(depsBlock).not.toContain(banned);
    }
  });

  it('执行装配（runSubagent 接线）落在 assembly adapter，不在通用核心', () => {
    const executor = read('src/core/async-task-system/subagent-executor.ts');
    expect(executor).not.toContain('runSubagent(');
    expect(executor).not.toContain('createPerTaskRegistry');
    const adapter = read('src/assembly/subagent-task-executor.ts');
    expect(adapter).toContain('export function createSubagentTaskExecutor');
    expect(adapter).toContain('runSubagent');
  });
});
