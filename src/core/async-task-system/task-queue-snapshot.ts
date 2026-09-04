/**
 * Task queue 最小只读 capability（phase 1758）。
 *
 * STATUS-TASK-QUEUE-OWNER-BYPASS 修复：StatusService 不再导入 queue path 常量、
 * 不理解 `tasks/queues/` 目录布局；owner（AsyncTaskSystem）在此封装目录枚举 +
 * ENOENT 语义（队列目录未建 = 空队列）+ 非 ENOENT 错误折叠，跨边界只交付
 * StatusService view 所需的信息（pending/running counts + 失败证据字符串）。
 *
 * 行为与原 StatusService 内联实现完全等价（同一 list 顺序、同一 ENOENT 折叠、
 * 同一 formatErr 证据格式），仅资源归属迁移、无语义变化。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR } from './dirs.js';

export interface TaskQueueCounts {
  pending: number;
  running: number;
  /** 非 ENOENT 读取失败证据（已 formatErr）；ENOENT（队列未建）不记录。 */
  pendingError?: string;
  /** 同 pendingError，作用于 running 队列。 */
  runningError?: string;
}

/**
 * 读取 pending + running 队列的 task 文件计数。
 *
 * - 任一队列目录不存在（ENOENT/FS_NOT_FOUND）→ 该队列计数 0、无错误记录。
 * - 任一队列读取发生其他错误 → 该队列计数 0、错误折进对应 *Error 字段。
 * - 本函数不抛出：全部失败形态折进返回值（view 层兜底语义由调用方决定）。
 */
export async function readTaskQueueCounts(fs: FileSystem): Promise<TaskQueueCounts> {
  let pending = 0;
  let running = 0;
  let pendingError: string | undefined;
  let runningError: string | undefined;

  try {
    pending = (await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false })).length;
  } catch (err) {
    // silent: ENOENT/FS_NOT_FOUND 视作"队列目录尚未建"、非业务错误；其余 error 折进 pendingError 字段由调用方 audit
    if (!isFileNotFound(err)) {
      pendingError = formatErr(err);
    }
  }

  try {
    running = (await fs.list(TASKS_QUEUES_RUNNING_DIR, { includeDirs: false })).length;
  } catch (err) {
    // silent: 同 pending 段、ENOENT 视作未建队列、其余折进 runningError
    if (!isFileNotFound(err)) {
      runningError = formatErr(err);
    }
  }

  return { pending, running, pendingError, runningError };
}
