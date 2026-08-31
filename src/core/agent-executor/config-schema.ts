/**
 * AgentExecutor config schema / phase 10 decentralize
 * Owner: agent-executor（react 循环参数 yaml schema 业主）
 * Composed by: src/assembly/compose-config.ts (yaml `default_max_steps` top-level field)
 *
 * Note: phase 1485 后 `default_max_steps` 是 optional / user config 不设置时由 runReact 内部 fallback
 */
import { z } from 'zod';

export const agentExecutorConfigSchema = z.number().min(1).max(1000).optional();
