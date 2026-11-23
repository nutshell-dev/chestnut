/**
 * @module L4.LLMConfiguration.Selection
 *
 * 主配置覆盖、备用顺序与有效配置解析的唯一解释入口。
 */
import type { z } from 'zod';
import { llmOrchestratorConfigSchema } from './config-schema.js';
import type { CredentialFact, CredentialSource } from './legacy-credentials/index.js';
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
const { toProviderInput } = llmProviderConfigContract;
type LLMProviderConfig = llmProviderConfigContract.LLMProviderConfig;
type ProviderInput = llmProviderConfigContract.ProviderInput;

export type SharedLLMInput = z.input<typeof llmOrchestratorConfigSchema>;
export type SharedLLM = z.output<typeof llmOrchestratorConfigSchema>;
export type LLMProviderSlot =
  | { readonly role: 'primary' }
  | { readonly role: 'fallback'; readonly index: number };

export interface LLMRawConfigView {
  llm: SharedLLMInput;
  revision: { readonly id: string; readonly revision: number };
  workspaceRoot?: string;
}

export interface LLMGlobalConfigView {
  llm: SharedLLM;
  /** 同次读取的 raw 声明；保留 `${REF}`，仅供 scope/auth 投影，不进入运行配置。 */
  raw?: SharedLLMInput;
  /** document-store 的读取事实；draft/旧调用方缺省时由 snapshot 显式标记。 */
  revision?: { readonly id: string; readonly revision: number };
  workspaceRoot?: string;
  /** expandEnvVars 同次 credentials.resolve 观察到的非 secret 来源。 */
  credentialSources?: Readonly<Record<string, CredentialSource>>;
  /** 同次解析的不可逆 credential revision；只参与 operational identity。 */
  credentialFacts?: Readonly<Record<string, CredentialFact>>;
}

export interface LLMClawConfigView {
  llm?: { primary?: LLMProviderConfig };
  /** 同次读取的 claw raw primary；保留 credential reference。 */
  raw?: { primary?: SharedLLMInput['primary'] };
  credentialSources?: Readonly<Record<string, CredentialSource>>;
  credentialFacts?: Readonly<Record<string, CredentialFact>>;
}

export interface LLMConfigInput {
  llm: SharedLLMInput;
}

export interface LLMResolvedConfiguration {
  readonly primary: ProviderInput;
  readonly fallbacks: readonly ProviderInput[];
  readonly retry: Readonly<{
    maxAttempts: number;
    delayMs: number;
  }>;
  /** 旧 breaker 段仅作为兼容诊断事实，不表达当前 L2 策略。 */
  readonly legacyCircuitBreaker?: Readonly<{
    failureThreshold: number;
    resetTimeoutMs: number;
  }>;
}

/** 将 global 与可选 claw 的 LLM 视图转换为无运行时依赖的输入快照。 */
export function resolveLLMConfig(
  globalConfig: LLMGlobalConfigView,
  clawConfig?: LLMClawConfigView,
): LLMResolvedConfiguration {
  const llm = globalConfig.llm;
  const cb = llm.circuit_breaker;
  return {
    primary: toProviderInput(clawConfig?.llm?.primary ?? llm.primary),
    fallbacks: (llm.fallbacks ?? []).map(toProviderInput),
    retry: {
      maxAttempts: llm.retry_attempts,
      delayMs: llm.retry_delay_ms,
    },
    ...(cb ? {
      legacyCircuitBreaker: {
        failureThreshold: cb.failure_threshold,
        resetTimeoutMs: cb.reset_timeout_ms,
      },
    } : {}),
  };
}
