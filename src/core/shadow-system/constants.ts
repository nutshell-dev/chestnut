/** shadow tool name constant */
export const SHADOW_TOOL_NAME = 'shadow' as const;

/** tasks/sync/shadow — shadow 工具自身 sync 路径 */
export const TASKS_SYNC_SHADOW_DIR = 'tasks/sync/shadow';

/**
 * phase 1865 (SH-D4)：shadow 执行恒为异步 detached——不继承 caller abort signal
 * （caller abort 不级联 shadow）。契约字段 `payload.detached` 的取值来源；
 * 若 future abort 需求 N≥1 → 扩为 shadowSignal parameter + propagate。
 */
export const SHADOW_DETACHED = true as const;

/**
 * Shadow tool default timeoutMs (subagent execution).
 * Agent 不传 timeoutMs 时使用此默认值；超时后 SubAgent SIGTERM。
 * 与 SPAWN_DEFAULT_TIMEOUT_MS 独立可变（shadow 持 motion 完整上下文、典型耗时更长）。
 * phase 105 const 化（修 phase 1xx pre-existing 5 处 cross-file hardcoded、M#3）
 */
export const SHADOW_DEFAULT_TIMEOUT_MS = 300_000;


