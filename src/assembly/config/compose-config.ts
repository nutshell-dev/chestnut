/**
 * Phase 10 Step B: root config composer (decentralize 落地点)
 *
 * 拼 14 owner module 各自 configSchema 成 root global + claw schema。
 * 不持任何字段含义（业务归各 owner）、不持 ConfigDefaults interface（defaults 内联各 owner）。
 *
 * Refs: coding plan/phase10/Phase 10 总览.md + Step A.md + Step B.md
 */
import { z } from 'zod';
import { llmOrchestratorConfigSchema } from '../../foundation/llm-orchestrator/index.js';
import { runtimeMotionConfigSchema, clawConfigSchema } from '../../core/runtime/index.js';
import { toolsConfigSchema } from '../../foundation/tools/index.js';
import { cronConfigSchema } from '../../foundation/cron/index.js';
import { viewportConfigSchema } from '../../cli-protocol/index.js';
// Phase 1288 Step B: audit 段移出 root schema — retention SoT 归 AuditLog 自家
// config store（.chestnut/audit/config.yaml）；legacy 段读取/移除见 config-load.ts。
// Phase 1289 Step D: Watchdog 段移出 root schema — 配置 SoT 归 Watchdog 自家
// config store；legacy 段读取/移除见 config-load.ts。
import { streamConfigSchema } from '../../foundation/stream/index.js';
import { agentExecutorConfigSchema } from '../../core/agent-executor/index.js';
import { messagingConfigSchema } from '../../foundation/messaging/index.js';

export function createGlobalConfigSchema() {
  return z.object({
    version: z.string().default('1'),
    default_max_steps: agentExecutorConfigSchema,
    llm: llmOrchestratorConfigSchema,
    motion: runtimeMotionConfigSchema.default({}),
    tool_timeout_ms: toolsConfigSchema,
    cron: cronConfigSchema.default({}),
    viewport: viewportConfigSchema.default({}),
    stream: streamConfigSchema.default({}),
    messaging: messagingConfigSchema.default({}),
    // Future cross-field validation hook (currently 0 cross-field constraint):
    //   .refine((cfg) => <constraint>, { message: '...' })
  });
}

export function getClawConfigSchema() {
  return clawConfigSchema;
}

export type ClawGlobalConfig = z.infer<ReturnType<typeof createGlobalConfigSchema>>;
// phase 12: input shape (defaults optional)，给 init / patch 等 caller 写 YAML 用。
// 与 ClawGlobalConfig (output / 所有 default-fill 后的 fields 必填) 区分。
export type ClawGlobalConfigInput = z.input<ReturnType<typeof createGlobalConfigSchema>>;
export type ClawConfig = z.infer<typeof clawConfigSchema>;
