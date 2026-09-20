/**
 * phase 1863 (AT-D10)：AsyncTaskSystem barrel 公共面锁。
 *
 * 公共面 = owner API 四族（schedule / cancel / query / lifecycle）+ 装配接线必要面 +
 * 跨模块读路径常量（登记于保留项）；机制面（result-store 实现、envelope 文件名等）内化。
 * 锁语义：白名单 == 实际导出（增删导出必须同步本表并附理由）。
 * 禁止：wildcard re-export、导出别名回流。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');
const BARREL = 'src/core/async-task-system/index.ts';

/**
 * phase 1863 (AT-D10) 白名单（四族 + 接线/能力面；分组注记裁决依据）：
 * - schedule：AsyncTaskSystem/createAsyncTaskSystem + 调度 capability 类型族 + PostProcessor 注册面
 * - cancel：CancelOutcome/AbortRequestOutcome/TaskLifecycleOutcome + AsyncTaskRuntimeLifecycle
 * - query：listMigratedExecTasks 族 + readTaskQueueCounts(1758 最小只读能力) + RunningTaskView + TaskIdResolver
 * - lifecycle/执行交付面：TaskExecutor/DeliverySink 族 + ExecutorPayload* + ProcessedTaskResult + classifyTaskError
 * - id 契约：make/read/adopt/derive 工厂族 + taskShortId + brand 类型
 * - 装配接线：PersistentShortIdIndex/validateTaskShape/createStandardDeliverySink/emitHandlerFailed/常量
 * - 跨模块读路径：TASKS_QUEUES_* + TASK_SNAPSHOT_IGNORE（装配布局/权限/CLI；收窄候选，未收窄前锁内登记）
 * - 审计/事件注册面：TASK_AUDIT_EVENTS、STREAM_TASK_EVENTS（AT-D10 §5 明确不动）
 * - legacy 契约：LegacySummonDecisionV1（summon-verify-policy 消费；SummonDecisionMetadata 已内化）
 */
const ALLOWED_EXPORTS: readonly string[] = [
  // constants（装配/CLI 接线）
  'ASYNC_EXEC_SOFT_TIMEOUT_MS',
  'DEFAULT_MAX_CONCURRENT_TASKS',
  // schedule / owner class
  'AsyncTaskSystem',
  'createAsyncTaskSystem',
  'PostProcessor',
  'PreparedSubagentSchedule',
  'PreparedSubAgentTaskScheduler',
  'SubAgentTask',
  'SubAgentTaskScheduler',
  // cancel / lifecycle outcomes
  'AbortRequestOutcome',
  'AsyncTaskRuntimeLifecycle',
  'CancelOutcome',
  'TaskLifecycleOutcome',
  // query
  'MigratedExecTaskInfo',
  'RunningTaskView',
  'TaskQueueCounts',
  'TaskReadError',
  'TaskIdResolver',
  'listMigratedExecTasks',
  'readTaskQueueCounts',
  // phase 1872 Step D: 单条 task 只读查询（assembly-async-task-storage-bypass 收口）
  'loadSubAgentTask',
  // lifecycle / 执行交付面
  'DeliverySink',
  'ExecutorPayloadAdapter',
  'ExecutorPayloadInterpretation',
  'ProcessedTaskResult',
  'TaskDeliveryRuntime',
  'TaskExecutionOutcome',
  'TaskExecutionRuntime',
  'TaskExecutor',
  'classifyTaskError',
  // id 契约
  'FullTaskId',
  'ShortIdIndex',
  'ShortTaskId',
  'TaskId',
  'adoptLegacyFullTaskId',
  'adoptLegacyShortTaskId',
  'deriveShortIdFromTaskId',
  'makeFullTaskId',
  'makeShortTaskId',
  'makeTaskId',
  'readFullTaskId',
  'readShortTaskId',
  'taskShortId',
  // 装配接线 / 恢复校验面
  'PersistentShortIdIndex',
  'emitHandlerFailed',
  'createStandardDeliverySink',
  'validateTaskShape',
  'ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES',
  // 跨模块读路径常量（收窄候选、未收窄前保留）
  'TASKS_QUEUES_DONE_DIR',
  'TASKS_QUEUES_FAILED_DIR',
  'TASKS_QUEUES_PENDING_DIR',
  'TASKS_QUEUES_RESULTS_DIR',
  'TASKS_QUEUES_RUNNING_DIR',
  'TASK_SNAPSHOT_IGNORE',
  // 审计/事件注册面
  'TASK_AUDIT_EVENTS',
  'STREAM_TASK_EVENTS',
  // legacy 契约
  'LegacySummonDecisionV1',
].sort();

function collectBarrelExports(source: string): { names: string[]; wildcard: boolean; aliases: string[] } {
  const names = new Set<string>();
  const aliases: string[] = [];
  // 去注释后再解析（export 块内允许行内注释，如 `TASK_SNAPSHOT_IGNORE,  // phase 693 Step B`）
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const m of stripped.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.includes(' as ')) aliases.push(trimmed);
      names.add(trimmed.split(' as ').pop()!.trim());
    }
  }
  for (const m of stripped.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  const wildcard = /export\s+(?:type\s+)?\*\s+from/.test(stripped);
  return { names: [...names].sort(), wildcard, aliases };
}

describe('phase 1863 (AT-D10): AsyncTaskSystem barrel surface lock', () => {
  it('白名单 == 实际导出（增删导出必须同步白名单）', () => {
    const { names } = collectBarrelExports(read(BARREL));
    expect(names).toEqual([...ALLOWED_EXPORTS]);
  });

  it('无 wildcard re-export、无导出别名', () => {
    const { wildcard, aliases } = collectBarrelExports(read(BARREL));
    expect(wildcard).toBe(false);
    expect(aliases).toEqual([]);
  });

  it('机制面已内化（result-store / envelope 文件名不在 barrel）', () => {
    const source = read(BARREL);
    for (const internalized of [
      'createProcessedResultStore',
      'ProcessedResultStore',
      'ProcessedTaskResultSchema',
      'ProcessedResultReadError',
      'ProcessedResultCorruptError',
      'ProcessedResultUnsupportedVersionError',
      'POST_PROCESS_INPUT_FILE',
      'RESULT_META_FILE',
      'RESULT_ENVELOPE_FILE',
      'SummonDecisionMetadata',
    ]) {
      expect(source).not.toMatch(new RegExp(`export[^\\n]*\\b${internalized}\\b`));
    }
  });
});
