/** shadow tool name constant */
export const SHADOW_TOOL_NAME = 'shadow' as const;

/** tasks/sync/shadow — shadow 工具自身 sync 路径 */
export const TASKS_SYNC_SHADOW_DIR = 'tasks/sync/shadow';

/**
 * phase 61: L2 ctx.callerLabel value indicating shadow execution origin.
 * L2 carrier opaque、L4 reader 业务读（spawn/summon/shadow tool guard）。
 * per phase 1337 callerType 治理同型 pattern + phase 1459 α-5 callerLabel 业务读 ratify。
 */
export const SHADOW_CALLER_LABEL = 'shadow';

/**
 * Shadow tool default timeoutMs (subagent execution).
 * Agent 不传 timeoutMs 时使用此默认值；超时后 SubAgent SIGTERM。
 * 与 SPAWN_DEFAULT_TIMEOUT_MS 独立可变（shadow 持 motion 完整上下文、典型耗时更长）。
 * phase 105 const 化（修 phase 1xx pre-existing 5 处 cross-file hardcoded、ML#3）
 */
export const SHADOW_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Shadow task intentPreview field cap.
 * spawn-shadow-subagent 创建 ShadowTask 时、opts.task 截断到此长度作为 intentPreview 字段值；audit / 不进 LLM。
 * 与 async-task-system TASK_INTENT_PREVIEW_CHARS 独立可变（同值 60）。
 */
export const SHADOW_INTENT_PREVIEW_CHARS = 60;
