/**
 * @module L4.LLMConfiguration.Identity
 *
 * LLM 配置快照与稳定身份摘要；secret 仅以 sha256 摘要参与身份。
 */
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import { llmOrchestratorConfigSchema } from '../../foundation/llm-orchestrator/index.js';
import type { ProviderConfig } from '../../foundation/llm-provider/index.js';
import { sha256Hex } from '../../foundation/node-utils/index.js';
import {
  resolveLLMConfig,
  type LLMClawConfigView,
  type LLMConfigInput,
  type LLMGlobalConfigView,
} from './selection.js';

/** 不可变配置快照：probe 与消费方只认 identity 相等的事实。 */
export interface LLMConfigSnapshot {
  config: LLMOrchestratorConfig;
  /** sha256 hex；不含明文 secret，可入 audit/env（日志建议截短展示）。 */
  identity: string;
}

/** 递归排序键的稳定序列化（函数成员丢弃——装配注入物不参与身份）。 */
function stableIdentityStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableIdentityStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableIdentityStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** ProviderConfig → 身份投影（apiKey 摘要化；auditLog 注入物除外）。 */
function providerIdentityProjection(p: ProviderConfig): Record<string, unknown> {
  const { apiKey, auditLog: _auditLog, ...rest } = p;
  return { ...rest, apiKey: apiKey ? sha256Hex(apiKey) : undefined };
}

/** resolved LLM 配置的稳定身份摘要。 */
export function llmConfigIdentity(config: LLMOrchestratorConfig): string {
  return sha256Hex(stableIdentityStringify({
    primary: providerIdentityProjection(config.primary),
    fallbacks: (config.fallbacks ?? []).map(providerIdentityProjection),
    maxAttempts: config.maxAttempts,
    retryDelayMs: config.retryDelayMs,
    circuitBreaker: config.circuitBreaker,
  }));
}

/** 读取即快照：resolve 与 identity 同源派生，调用方不得再自行拼身份。 */
export function snapshotLLMConfig(
  globalConfig: LLMGlobalConfigView,
  clawConfig?: LLMClawConfigView,
): LLMConfigSnapshot {
  const config = resolveLLMConfig(globalConfig, clawConfig);
  return { config, identity: llmConfigIdentity(config) };
}

/** 未落盘 draft 先经 owner schema 默认填充，再按磁盘同形配置派生身份。 */
export function snapshotLLMConfigInput(input: LLMConfigInput): LLMConfigSnapshot {
  return snapshotLLMConfig({ llm: llmOrchestratorConfigSchema.parse(input.llm) });
}

/** typed invalidation：验证身份与消费时身份不一致（fail-closed 证据）。 */
export class LLMConfigIdentityMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      `LLM config identity mismatch: verified config is no longer current ` +
      `(expected=${expected.slice(0, 12)}…, actual=${actual.slice(0, 12)}…)`,
    );
    this.name = 'LLMConfigIdentityMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}
