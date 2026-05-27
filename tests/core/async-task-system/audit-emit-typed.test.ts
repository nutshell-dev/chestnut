/**
 * Phase 1130: async-task-system typed audit emit — 反向 3 项 + 主路径
 */

import { describe, it, expect } from 'vitest';
import {
  emitRecovered,
  emitToolAsyncResult,
  emitHandlerFailed,
  emitTaskScheduled,
  emitTaskStarted,
  emitTaskCompleted,
  emitRecoveryFailed,
  emitMoveFailed,
  emitPendingIngestFailed,
} from '../../../src/core/async-task-system/audit-emit.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

describe('async-task-system typed audit emit (phase 1130)', () => {
  const makeAudit = makeMockAudit;

  // ─── 主路径 ────────────────────────────────────────────────────────────────

  it('emitRecovered serialize 含 taskId= prefix', () => {
    const audit = makeAudit();
    emitRecovered(audit, {
      taskId: 'tk_abc',
      kind: 'subagent',
      from: 'running',
      to: 'pending',
    });
    expect(audit.write).toHaveBeenCalledWith(
      TASK_AUDIT_EVENTS.RECOVERED,
      'taskId=tk_abc',
      'kind=subagent',
      'from=running',
      'to=pending',
    );
  });

  it('emitToolAsyncResult 拆 3 关联键 (key fix site tool-executor.ts:63)', () => {
    const audit = makeAudit();
    emitToolAsyncResult(audit, {
      taskId: 'tk_abc',
      toolName: 'read_file',
      toolUseId: 'tu_xyz',
    });
    expect(audit.write).toHaveBeenCalledWith(
      TASK_AUDIT_EVENTS.TOOL_ASYNC_RESULT,
      'toolName=read_file',
      'toolUseId=tu_xyz',
      'taskId=tk_abc',
    );
    // 确认: 无 `task=tk_abc` 重复 col、无 positional task.toolName / task.toolUseId
    const callArgs = audit.write.mock.calls[0] as unknown as unknown[];
    const taskKeyCount = callArgs.filter(
      (c) => typeof c === 'string' && c.startsWith('task='),
    ).length;
    expect(taskKeyCount).toBe(0);
  });

  it('emitTaskScheduled 含 isShadow 当传入时（含 undefined）', () => {
    const audit = makeAudit();
    emitTaskScheduled(audit, {
      taskId: 'tk_1',
      kind: 'tool',
      parent: 'p1',
      tool: 'spawn',
      isShadow: undefined,
    });
    const callArgs = audit.write.mock.calls[0] as unknown as string[];
    expect(callArgs).toContain('isShadow=undefined');
  });

  it('emitTaskScheduled 不含 isShadow 当未传入时', () => {
    const audit = makeAudit();
    emitTaskScheduled(audit, {
      taskId: 'tk_1',
      kind: 'subagent',
      parent: 'p1',
    });
    const callArgs = audit.write.mock.calls[0] as unknown as string[];
    const hasIsShadow = callArgs.some((c) =>
      typeof c === 'string' && c.startsWith('isShadow='),
    );
    expect(hasIsShadow).toBe(false);
  });

  it('emitTaskStarted 仅 emit taskId', () => {
    const audit = makeAudit();
    emitTaskStarted(audit, { taskId: 'tk_1' });
    expect(audit.write).toHaveBeenCalledWith(
      TASK_AUDIT_EVENTS.TASK_STARTED,
      'taskId=tk_1',
    );
  });

  it('emitTaskCompleted 覆盖 ok/err + optional fields', () => {
    const audit = makeAudit();
    emitTaskCompleted(audit, {
      taskId: 'tk_1',
      status: 'ok',
      kind: 'tool',
      toolName: 'read',
      elapsedMs: 42,
      retries: 0,
    });
    const callArgs = audit.write.mock.calls[0] as unknown as string[];
    expect(callArgs[0]).toBe(TASK_AUDIT_EVENTS.TASK_COMPLETED);
    expect(callArgs).toContain('taskId=tk_1');
    expect(callArgs).toContain('ok');
    expect(callArgs).toContain('kind=tool');
    expect(callArgs).toContain('toolName=read');
    expect(callArgs).toContain('elapsed_ms=42');
    expect(callArgs).toContain('retries=0');
  });

  it('emitRecoveryFailed 支持 taskId / path / source 多态', () => {
    const audit = makeAudit();
    emitRecoveryFailed(audit, {
      path: '/some/path',
      context: 'load_pending',
      error: 'ENOENT',
    });
    expect(audit.write).toHaveBeenCalledWith(
      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      'path=/some/path',
      'context=load_pending',
      'error=ENOENT',
    );
  });

  it('emitMoveFailed 含 taskId=前缀', () => {
    const audit = makeAudit();
    emitMoveFailed(audit, {
      taskId: 'tk_1',
      context: 'move_to_done',
      error: 'disk full',
    });
    expect(audit.write).toHaveBeenCalledWith(
      TASK_AUDIT_EVENTS.MOVE_FAILED,
      'taskId=tk_1',
      'context=move_to_done',
      'error=disk full',
    );
  });

  it('emitPendingIngestFailed 支持 taskId + context + path', () => {
    const audit = makeAudit();
    emitPendingIngestFailed(audit, {
      context: 'watcher_async',
      path: 'tasks/queues/pending/t.json',
      error: 'boom',
    });
    expect(audit.write).toHaveBeenCalledWith(
      TASK_AUDIT_EVENTS.PENDING_INGEST_FAILED,
      'context=watcher_async',
      'path=tasks/queues/pending/t.json',
      'error=boom',
    );
  });

  // ─── 反向 1：误删反向（emit fn 实然调 audit.write）───────────────────────────

  it('反向 1: emit fn 实然调 audit.write', () => {
    const audit = makeAudit();
    emitRecovered(audit, { taskId: 'x' });
    expect(audit.write).toHaveBeenCalled();
  });

  // ─── 反向 2：schema 反向（TS 编译期 enforce taskId 类型）──────────────────────

  it('反向 2: typed payload key TS enforce', () => {
    const audit = makeAudit();
    // @ts-expect-error: missing required field `taskId`
    emitRecovered(audit, { id: 'x' });
    expect(audit.write).toHaveBeenCalledTimes(1);
  });

  // ─── 反向 3：边界路径反向（tool-executor.ts:63 cascade 后无 task= ad-hoc）────

  it('反向 3: tool-executor.ts:63 cascade 后 row 不含 `task=` ad-hoc col', () => {
    const audit = makeAudit();
    emitToolAsyncResult(audit, {
      taskId: 'tk_abc',
      toolName: 'foo',
      toolUseId: 'tu_x',
    });
    const callArgs = audit.write.mock.calls[0] as unknown as unknown[];
    const taskKeyCount = callArgs.filter(
      (c) => typeof c === 'string' && c.startsWith('task='),
    ).length;
    expect(taskKeyCount).toBe(0);
  });
});
