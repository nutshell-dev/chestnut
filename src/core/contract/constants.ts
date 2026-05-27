/** Maximum retries for file lock acquisition */
export const LOCK_MAX_RETRIES = 20;

/** Delay between lock retry attempts (ms) */
export const LOCK_RETRY_DELAY_MS = 500;

/** Lock held longer than this is considered stale and force-cleared (ms) */
export const LOCK_STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** 契约脚本验收超时 (ms) */
export const CONTRACT_SCRIPT_TIMEOUT_MS = 60_000;
