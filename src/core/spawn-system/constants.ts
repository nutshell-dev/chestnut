/** tasks/sync/spawn — spawn 工具自身 sync 路径 */
export const TASKS_SYNC_SPAWN_DIR = 'tasks/sync/spawn';

/**
 * Spawn tool default timeoutMs (sync subagent execution).
 * Agent 不传 timeoutMs 时使用此默认值；超时后 SubAgent SIGTERM。
 * phase 105 const 化（修 phase 1xx pre-existing 3 处 cross-file hardcoded、ML#3 + 编码规范"同一概念同一名字"）
 */
export const SPAWN_DEFAULT_TIMEOUT_MS = 60_000;
