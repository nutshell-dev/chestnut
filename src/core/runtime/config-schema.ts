/**
 * Runtime motion config schema / phase 10 decentralize
 * Owner: runtime（motion daemon 运行参数 yaml schema 业主）
 * Composed by: src/assembly/compose-config.ts (yaml `motion.*` field)
 */
import { z } from 'zod';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import { DEFAULT_MAX_CONCURRENT_TASKS } from '../async-task-system/index.js';

export const runtimeMotionConfigSchema = z.object({
  // phase 1870: heartbeat_interval_ms 声明迁 Heartbeat owner
  // （src/core/heartbeat/config-schema.ts），由 Assembly 组合回 motion 段。
  max_steps: z.number().min(1).max(1000).optional(),
  subagent_max_steps: z.number().min(1).max(200).optional(),
  max_concurrent_tasks: z.number().min(1).max(20).default(DEFAULT_MAX_CONCURRENT_TASKS),
  llm_idle_timeout_ms: z.number().min(0).max(600000).default(DEFAULT_LLM_IDLE_TIMEOUT_MS),
});
