/**
 * Shared path constants
 * 
 * These are used across CLI and Core modules to ensure consistency.
 */

/**
 * Claw directory structure - shared between createCommand and runtime.ensureDirectories
 * Modifying this requires updating all consumers.
 */
/** tasks/pending 目录相对路径 */
export const TASKS_PENDING_DIR = 'tasks/pending';
/** tasks/running 目录相对路径 */
export const TASKS_RUNNING_DIR = 'tasks/running';
/** tasks/done 目录相对路径 */
export const TASKS_DONE_DIR = 'tasks/done';
/** tasks/results 目录相对路径 */
export const TASKS_RESULTS_DIR = 'tasks/results';

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
  'dialog',
  DIALOG_ARCHIVE_DIR,
  INBOX_PENDING_DIR,
  INBOX_DONE_DIR,
  INBOX_FAILED_DIR,
  OUTBOX_PENDING_DIR,
  'outbox/done',
  'outbox/failed',
  TASKS_PENDING_DIR,
  TASKS_RUNNING_DIR,
  TASKS_DONE_DIR,
  TASKS_RESULTS_DIR,
  'memory',
  'contract',
  'skills',
  'clawspace',
  'logs',
  'status',  // 用于 PID 文件
] as const;
