/** Maximum lines to read in read tool */
export const READ_MAX_LINES = 200;

/** Maximum characters to read in read tool */
export const READ_MAX_CHARS = 8000;

/** Maximum entries to list in ls tool */
export const LS_MAX_ENTRIES = 100;

/** FileTool own sync scratch subdir（turn-scoped / Snapshot whitelist 清理）*/
export const TASKS_SYNC_WRITE_DIR = 'tasks/sync/write';

/** search overflow scratch subdir（phase 1422 / Snapshot whitelist 清理）*/
export const TASKS_SYNC_SEARCH_DIR = 'tasks/sync/search';

/** search 预览阈值：命中数 ≤ 此值时全返不落盘、> 时落盘 + 返预览（phase 1422 Q6 ratify）*/
export const SEARCH_PREVIEW_LIMIT = 20;

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
  '.clawforum',
]);

/** Skip 段单条 path 显示上限：超出聚合为 `+N more`（phase 1422）*/
export const SEARCH_SKIP_DISPLAY_LIMIT = 5;
