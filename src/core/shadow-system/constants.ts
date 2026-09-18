/** shadow tool name constant */
export const SHADOW_TOOL_NAME = 'shadow' as const;

/**
 * tasks/sync/shadow — shadow 工具 sync 路径（结果产物目录）的命名空间引用。
 *
 * phase 1865 (SH-D6) 归属划界：
 * - 目录位于 ATS 的 `tasks/` 命名空间（`tasks/sync/*` 为同步执行区，由装配方 admitted，
 *   见 assembly/claw-subdirs.ts）——本常量是 shadow 侧对该子空间名的引用；
 * - shadow 只 own 本子空间名与其下 shadowId 产物命名；
 * - 任务持久化（queues/结果投递/任务记录）归 AsyncTaskSystem，不在任务记录面渗 shadow 命名。
 */
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


