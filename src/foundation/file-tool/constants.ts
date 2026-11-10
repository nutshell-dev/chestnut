/**
 * Default line cap when caller passes no `limit` (phase 1430).
 * `limit` is the only signal that disables this cap; `offset` alone still applies it (from offset).
 */
export const READ_DEFAULT_LINES = 200;

/**
 * Per-call output byte ceiling (phase 1430).
 * Above this, response is truncated (head/tail) and full content persists to `tasks/sync/read/<id>.md`.
 * Applies regardless of how the range was specified — resource/context safety, not a decision cap.
 */
export const READ_OUTPUT_HARD_CAP_BYTES = 100 * 1024;

/** Maximum entries to list in ls tool */
export const LS_MAX_ENTRIES = 100;

/** FileTool own sync scratch subdir（turn-scoped / Snapshot whitelist 清理）*/
export const TASKS_SYNC_WRITE_DIR = 'tasks/sync/write';

/** read overflow scratch subdir (phase 1430、turn-scoped / Snapshot whitelist 清理) */
export const TASKS_SYNC_READ_DIR = 'tasks/sync/read';

/** search overflow scratch subdir（phase 1422 / Snapshot whitelist 清理）*/
export const TASKS_SYNC_SEARCH_DIR = 'tasks/sync/search';

/**
 * search 预览条数阈值（phase 1422 Q6 ratify / phase 2086 C 改为并列条件之一）：
 * 命中数 ≤ 此值、且每行 ≤ SEARCH_PREVIEW_LINE_MAX_BYTES、且整份响应 ≤ SEARCH_OUTPUT_MAX_BYTES
 * 时才全返不落盘；任一条件超出即落盘一次完整结果并返回有界预览。
 */
export const SEARCH_PREVIEW_LIMIT = 20;

/** search 单条渲染行的 UTF-8 字节上限（phase 2086 Step C；超出即显式标记截短）*/
export const SEARCH_PREVIEW_LINE_MAX_BYTES = 2 * 1024;

/** 一份正常 search 响应（含标题、换行、截断标记、Skipped、artifact 路径与取回命令）的总字节上限（phase 2086 Step C）*/
export const SEARCH_OUTPUT_MAX_BYTES = 16 * 1024;

/** search binary detect：前 N 字节含 NUL 视为 binary（phase 1422 Q3+Q4 ratify）*/
export const SEARCH_BINARY_DETECT_BYTES = 8192;

/** search size cutoff：超过即 skip 入 `size_limit` 类（phase 1422 Q3 ratify）*/
export const SEARCH_MAX_FILE_SIZE = 10 * 1024 * 1024;

/** search 默认 exclude 目录前缀（phase 1422 Q4 ratify、agent 显式 path 越过）*/
export const SEARCH_DEFAULT_EXCLUDE: ReadonlyArray<string> = Object.freeze([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.chestnut',
]);

/** Skip 段单条 path 显示上限：超出聚合为 `+N more`（phase 1422）*/
export const SEARCH_SKIP_DISPLAY_LIMIT = 5;
