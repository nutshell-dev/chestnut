/**
 * Task 单条只读查询 capability（phase 1872 Step D，assembly-async-task-storage-bypass 收口）。
 *
 * callers（Summon verify 等）需要「按 taskId 读 task 事实」——此前 Assembly 自行
 * 枚举 `tasks/queues/*` 四目录 + 直调 validateTaskShape（直读 owner 私有布局与
 * schema）。本查询把目录布局与 shape 校验收口回 owner（形态同 listMigratedExecTasks
 * 的 0-instance-dep 直读）；owner 布局演进只影响本文件。
 *
 * 语义（与迁移前 Assembly 内联实现逐语义等价）：
 * - 按 owner 目录顺序（pending → running → done → failed）读取首个命中；
 * - 单目录读取 ENOENT → 尝试下一目录；全部未命中 → undefined；
 * - 非 ENOENT 读取错误原样抛出；JSON.parse 失败原样抛出（读取未知 ≠ 不存在）；
 * - shape 无效或 kind !== 'subagent' → 跳过继续（该文件不构成命中）。
 * 只读：不 init / 不 dispatch / 无写副作用。
 */
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
} from './dirs.js';
import { validateTaskShape } from './task-corrupt-helpers.js';
import type { SubAgentTask, TaskId } from './types.js';

/** owner 目录读取顺序（单条 task 事实首次命中即返回）。 */
const TASK_QUERY_DIRS = [
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
] as const;

/** 按 taskId 读取 subagent task 事实（首个命中；缺失 undefined；未知原样抛）。 */
export async function loadSubAgentTask(
  fs: Pick<FileSystem, 'read'>,
  taskId: TaskId,
): Promise<SubAgentTask | undefined> {
  for (const dir of TASK_QUERY_DIRS) {
    let content: string;
    try {
      content = await fs.read(`${dir}/${taskId}.json`);
    } catch (err) {
      if (isFileNotFound(err)) continue;
      throw err;
    }
    const parsed = JSON.parse(content) as unknown;
    if (validateTaskShape(parsed) && (parsed as SubAgentTask).kind === 'subagent') {
      return parsed as SubAgentTask;
    }
  }
  return undefined;
}
