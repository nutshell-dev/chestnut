/**
 * @module L6.Assembly.LLMOrchestratorConfig
 *
 * L4 resolved configuration 到 L2 runtime config 的唯一结构映射。
 */
import type { LLMResolvedConfiguration } from '../core/llm-configuration/index.js';
import type {
  LLMEventSink,
  LLMInstanceLifecycle,
  LLMOrchestratorConfig,
} from '../foundation/llm-orchestrator/index.js';
import type { llmProviderCall } from '../foundation/llm-provider/index.js';
type ProviderFactory = llmProviderCall.ProviderFactory;

export interface OrchestratorAssemblyDeps {
  readonly events: LLMEventSink;
  readonly providerFactory: ProviderFactory;
  readonly lifecycle: LLMInstanceLifecycle;
}

export function toOrchestratorConfig(
  resolved: LLMResolvedConfiguration,
  deps: OrchestratorAssemblyDeps,
): LLMOrchestratorConfig & { lifecycle: LLMInstanceLifecycle } {
  return {
    primary: resolved.primary,
    fallbacks: [...resolved.fallbacks],
    maxAttempts: resolved.retry.maxAttempts,
    retryDelayMs: resolved.retry.delayMs,
    ...(resolved.legacyCircuitBreaker !== undefined ? {
      circuitBreaker: { ...resolved.legacyCircuitBreaker },
    } : {}),
    events: deps.events,
    providerFactory: deps.providerFactory,
    lifecycle: deps.lifecycle,
  };
}
