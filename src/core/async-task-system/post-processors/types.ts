import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { SubAgentTask } from '../types.js';

/**
 * PostProcessor — 单次任务结果后处理 standalone function
 *
 * 应然：每 task 独立 / 0 closure / 0 跨 task state / 重启可恢复
 * 装配期：通过 AsyncTaskSystem.addPostProcessor(name, handler) 注册
 * 调用期：subagent-executor 在 sendResult 前按 task.postProcessor 字段 lookup + execute
 */
export type PostProcessor = (
  result: string,
  task: SubAgentTask,
  isError: boolean,
  fs: FileSystem,
  audit: AuditLog,
) => Promise<string>;
