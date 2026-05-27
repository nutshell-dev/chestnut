/**
 * Config schema defaults aggregation point.
 *
 * Owns the cross-module config default values that schema.parse uses
 * for missing user-config fields. Aggregated here (L6 assembly) instead
 * of L2 foundation/config so L2 Config schemas module 0 L3/L4/L5/L6 const import.
 *
 * 应然 anchor:
 * - A.7 应然原意「Assembly 聚合 + L2 不内化字面量」同模式 mirror phase 936 snapshot patterns
 * - ML#5 模块依赖单向（L2 0 cross-layer import）
 * - ML#9 不可消除耦合显式表达，优先编译期 check（ConfigDefaults interface contract）
 *
 * phase 942 r115+/r116+ Cluster 3 site #2 ε-inject 落地
 */
import { DEFAULT_MAX_STEPS } from '../core/agent-executor/index.js';
import { REACT_DEFAULT_MAX_TOKENS } from '../core/step-executor/constants.js';
import { CRON_TICK_INTERVAL_MS } from '../core/cron/constants.js';
import { DEFAULT_MAX_CONCURRENT_TASKS } from '../core/async-task-system/constants.js';
import {
  WATCHDOG_INTERVAL_MS,
  DEFAULT_DISK_WARNING_MB,
  CLAW_INACTIVITY_TIMEOUT_MS,
} from '../watchdog/constants.js';
import type { ConfigDefaults } from '../foundation/config/schemas.js';

/** Config-level tool timeout default (60s). Independent of executor safety-net fallback in foundation/tools/constants.ts. */
const CONFIG_DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export const CONFIG_DEFAULTS: ConfigDefaults = {
  maxSteps: DEFAULT_MAX_STEPS,
  toolTimeoutMs: CONFIG_DEFAULT_TOOL_TIMEOUT_MS,
  cronTickIntervalMs: CRON_TICK_INTERVAL_MS,
  reactDefaultMaxTokens: REACT_DEFAULT_MAX_TOKENS,
  defaultMaxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
  watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
  defaultDiskWarningMb: DEFAULT_DISK_WARNING_MB,
  clawInactivityTimeoutMs: CLAW_INACTIVITY_TIMEOUT_MS,
};
