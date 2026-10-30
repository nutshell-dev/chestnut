/**
 * @module L2b.LLMOrchestrator.ProviderIdentity
 * @layer L2b LLM 语义基础设施
 *
 * provider 故障身份与 adapter cache 指纹的唯一计算点。凭据只参与短哈希，
 * 不进入返回值的明文；行为参数只影响 cache，不改变故障身份。
 */

import type { ProviderConfig } from '../llm-provider/index.js';
import { sha256ShortHex } from '../node-utils/index.js';

function legacyIdentityParts(config: ProviderConfig): string[] {
  const apiKeyHash = config.apiKey ? sha256ShortHex(config.apiKey, 8) : 'noapikey';
  return [
    config.name ?? 'unknown',
    config.apiFormat ?? 'unknown',
    config.model ?? 'unknown',
    config.baseUrl ?? 'default',
    apiKeyHash,
  ];
}

/** Phase 2027 之前的身份算法，仅用于既有恢复事实兼容。 */
export function legacyProviderIdentity(config: ProviderConfig): string {
  return sha256ShortHex(legacyIdentityParts(config).join(':'), 12);
}

/**
 * 当前 provider 故障身份。无扩展语义的配置保持旧 ID；auth/catalog 扩展
 * 参与身份，temperature/timeout 等 adapter 行为参数不参与。
 */
export function providerIdentity(config: ProviderConfig): string {
  const hasExtendedIdentity = config.piAiProvider !== undefined
    || config.catalogProvider !== undefined
    || config.catalogModel !== undefined
    || (config.authProfile !== undefined && config.authProfile !== 'api_key');
  if (!hasExtendedIdentity) return legacyProviderIdentity(config);

  return sha256ShortHex([
    ...legacyIdentityParts(config),
    config.authProfile ?? 'api_key',
    config.piAiProvider ?? 'default',
    config.catalogProvider ?? 'default',
    config.catalogModel ?? 'default',
  ].join(':'), 12);
}

/** provider 身份 + adapter 行为/audit 指纹；同一完整配置才复用 adapter。 */
export function providerCacheKey(config: ProviderConfig, auditLogId: string): string {
  const behaviorFingerprint = sha256ShortHex(JSON.stringify({
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    thinking: config.thinking,
    thinkingBudgetTokens: config.thinkingBudgetTokens,
    thinkingMode: config.thinkingMode,
    thinkingEffort: config.thinkingEffort,
    reasoningEffort: config.reasoningEffort,
    dropThinkingBlocks: config.dropThinkingBlocks,
    extraHeaders: config.extraHeaders,
    auditLogId,
  }), 8);
  return `${providerIdentity(config)}:${behaviorFingerprint}`;
}
