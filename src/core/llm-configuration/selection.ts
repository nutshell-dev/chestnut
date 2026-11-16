/**
 * @module L4.LLMConfiguration.Selection
 *
 * 主配置覆盖、备用顺序与 orchestrator 配置转换的唯一解释入口。
 */
import type { z } from 'zod';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import { llmOrchestratorConfigSchema } from './config-schema.js';
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
const { toProviderConnection } = llmProviderConfigContract;
type LLMProviderConfig = llmProviderConfigContract.LLMProviderConfig;

export type SharedLLMInput = z.input<typeof llmOrchestratorConfigSchema>;
export type SharedLLM = z.output<typeof llmOrchestratorConfigSchema>;

export interface LLMGlobalConfigView {
  llm: SharedLLM;
  /** 同次读取的 raw 声明；保留 `${REF}`，仅供 scope/auth 投影，不进入运行配置。 */
  raw?: SharedLLMInput;
  /** document-store 的读取事实；draft/旧调用方缺省时由 snapshot 显式标记。 */
  revision?: { readonly id: string; readonly revision: number };
  workspaceRoot?: string;
  /** expandEnvVars 同次 credentials.resolve 观察到的非 secret 来源。 */
  credentialSources?: Readonly<Record<string, 'env' | 'file' | 'project-env' | 'user-env'>>;
}

export interface LLMClawConfigView {
  llm?: { primary?: LLMProviderConfig };
  /** 同次读取的 claw raw primary；保留 credential reference。 */
  raw?: { primary?: SharedLLMInput['primary'] };
  credentialSources?: Readonly<Record<string, 'env' | 'file' | 'project-env' | 'user-env'>>;
}

export interface LLMConfigInput {
  llm: SharedLLMInput;
}

export type LLMConnectionSelection = Omit<
  LLMOrchestratorConfig,
  'events' | 'providerFactory' | 'lifecycle'
>;

/** 将 global 与可选 claw 的 LLM 视图转换为无运行时依赖的连接快照。 */
export function resolveLLMConfig(
  globalConfig: LLMGlobalConfigView,
  clawConfig?: LLMClawConfigView,
): LLMConnectionSelection {
  const llm = globalConfig.llm;
  const cb = llm.circuit_breaker;
  return {
    primary: toProviderConnection(clawConfig?.llm?.primary ?? llm.primary),
    fallbacks: (llm.fallbacks ?? []).map(toProviderConnection),
    maxAttempts: llm.retry_attempts,
    retryDelayMs: llm.retry_delay_ms,
    circuitBreaker: cb ? {
      failureThreshold: cb.failure_threshold,
      resetTimeoutMs: cb.reset_timeout_ms,
    } : undefined,
  };
}
