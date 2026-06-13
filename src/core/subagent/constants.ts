/**
 * Default timeout for subagent tasks (ms) - 5 minutes.
 * Derivation: 300000ms = 5 min / 给一般 subagent 任务（多轮 LLM call + tool exec）足够时长 /
 * 比 SUMMON_SUBAGENT_TIMEOUT_MS (1hr) 短 12× 因 summon 全流程复杂 / 配
 * HEARTBEAT_INTERVAL_SEC_DEFAULT (300s = 5min) 即 subagent 内至少 1 次 heartbeat.
 */
export const SUBAGENT_TIMEOUT_MS = 300000;

/** tasks/sync/subagent — 通用 sync L4 直调 L3 SubAgent dir */
export const TASKS_SYNC_SUBAGENT_DIR = 'tasks/sync/subagent';

/** tasks/subagents — subagent 任务存储目录（canonical owner: subagent L3） */
export const TASKS_SUBAGENTS_DIR = 'tasks/subagents';
