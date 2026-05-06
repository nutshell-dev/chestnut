
/**
 * Shared path constants
 * 
 * These are used across CLI and Core modules to ensure consistency.
 */

// 单 token clawspace subdir 名 const（phase380 / Path β / B.p376-1）
// 命名规范：
// - `_DIR`：clawspace 直接 subdir（单一概念 / 高 ROI / 抽 const）
// - `_SUBDIR`：含多语义混叠的字面量 / 仅 subdir 域抽 const / 命名空间与其他域区隔
// - `_TOOL_NAME` / cli cmd 字面量：不入此节 / 显式不混
// - `BUNDLED_*`：源码树 bundled 资源目录（非运行期 agent subdir）
export const LOGS_DIR = 'logs' as const;
export const CONTRACT_DIR = 'contract' as const;
export const DIALOG_DIR = 'dialog' as const;
export const CLAWSPACE_DIR = 'clawspace' as const;
export const STATUS_SUBDIR = 'status' as const; // 仅 subdir 域 / 与 STATUS_TOOL_NAME / cli cmd 'status' / git arg 'status' 命名区隔

/**
 * Claw directory structure - shared between createCommand and runtime.ensureDirectories
 * Modifying this requires updating all consumers.
 */
/** tasks/queues/pending — async task 队列 state（phase 510 加 queues/ 层）*/
export const TASKS_QUEUES_PENDING_DIR = 'tasks/queues/pending';
/** tasks/queues/running */
export const TASKS_QUEUES_RUNNING_DIR = 'tasks/queues/running';
/** tasks/queues/done */
export const TASKS_QUEUES_DONE_DIR = 'tasks/queues/done';
/** tasks/queues/failed (NEW const / 原硬编码 'tasks/failed') */
export const TASKS_QUEUES_FAILED_DIR = 'tasks/queues/failed';
/** tasks/queues/results — async subagent lifecycle dir / 子代理不可见 */
export const TASKS_QUEUES_RESULTS_DIR = 'tasks/queues/results';

/** tasks/sync/exec — exec_overflow scratch（CommandTool own subdir / phase 511 加）*/
export const TASKS_SYNC_EXEC_DIR = 'tasks/sync/exec';
/** tasks/sync/write — file_backup scratch（FileTool own subdir / phase 511 加）*/
export const TASKS_SYNC_WRITE_DIR = 'tasks/sync/write';
/** tasks/sync/spawn — sync subagent lifecycle（sync caller own subdir / phase 511 加）*/
export const TASKS_SYNC_SPAWN_DIR = 'tasks/sync/spawn';

/** tasks/subagents — 子代理临时工作区集合（per-subagent dir / phase 512 加）*/
export const TASKS_SUBAGENTS_DIR = 'tasks/subagents';

/** inbox/pending 目录相对路径 */
export const INBOX_PENDING_DIR = 'inbox/pending';
/** inbox/done 目录相对路径 */
export const INBOX_DONE_DIR = 'inbox/done';
/** inbox/failed 目录相对路径 */
export const INBOX_FAILED_DIR = 'inbox/failed';

/** outbox/pending 目录相对路径 */
export const OUTBOX_PENDING_DIR = 'outbox/pending';

/** dialog/archive 目录相对路径 */
export const DIALOG_ARCHIVE_DIR = 'dialog/archive';

export const CLAW_SUBDIRS = [
  DIALOG_DIR,                  // 旧 'dialog'
  DIALOG_ARCHIVE_DIR,
  INBOX_PENDING_DIR,
  INBOX_DONE_DIR,
  INBOX_FAILED_DIR,
  OUTBOX_PENDING_DIR,
  'outbox/done',
  'outbox/failed',
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SYNC_EXEC_DIR,
  TASKS_SYNC_WRITE_DIR,
  TASKS_SYNC_SPAWN_DIR,
  TASKS_SUBAGENTS_DIR,
  'memory',                    // 不抽 const / 字面量保留 / B.p380-1 信号登记
  CONTRACT_DIR,                // 旧 'contract'
  'skills',                    // phase370 已立 / 非 NEW（SKILLS_DIR_DEFAULT 字面量 / 避免循环依赖 skill-paths.ts → paths.ts）
  CLAWSPACE_DIR,               // 旧 'clawspace'
  LOGS_DIR,                    // 旧 'logs'
  STATUS_SUBDIR,               // 旧 'status'
] as const;
