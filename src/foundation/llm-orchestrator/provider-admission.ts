import {
  LLM_PROVIDER_SELECTION_TTL_MS,
  LLM_RECOVERY_COOLDOWN_MS,
  LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  LLM_RECOVERY_QUOTA_MAX_DELAY_MS,
  LLM_RECOVERY_RATE_LIMIT_BACKOFF_MS,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
  LLM_RECOVERY_RETRY_MAX_DELAY_MS,
} from './defaults.js';
import type { LLMErrorClass } from './errors.js';
import type { LLMProviderRecoveryState } from './instance-state.js';

export interface ProviderAdmissionInput {
  /** 与运行时 [primary, ...fallbacks] 同序的稳定身份。 */
  providerIds: readonly string[];
  providers: readonly LLMProviderRecoveryState[];
  nowMs: number;
}

export interface ProviderDecision {
  /** primary 没有 waiting 事实；retryAt 到点不会自行清除该事实。 */
  primaryAvailable: boolean;
  /** 最新成功事实为可用且严格未过期 fallback cache 时的 sticky 候选。 */
  stickyProviderId?: string;
  /** stream 的候选顺序；call 使用 stickyProviderId 保留其专门审计路径。 */
  orderedProviderIds: string[];
}

export interface ProviderFailure {
  errorClass: LLMErrorClass;
  message: string;
  occurredAtMs: number;
  retryAfterSec?: number;
  resetAtMs?: number;
  providerLabel?: string;
}

export interface ProviderSuccess {
  nowMs: number;
  /** 独立健康 probe 只清故障，不刷新业务选择 cache。 */
  updateSelection?: boolean;
}

/** provider 选择、恢复下界和健康状态转移的唯一纯策略。 */
export interface ProviderAdmission {
  choose(input: ProviderAdmissionInput): ProviderDecision;
  canProbe(state: LLMProviderRecoveryState, nowMs: number): boolean;
  recordFailure(state: LLMProviderRecoveryState, failure: ProviderFailure): LLMProviderRecoveryState;
  recordSuccess(state: LLMProviderRecoveryState, success: ProviderSuccess): LLMProviderRecoveryState;
}

export class LLMProviderAdmission implements ProviderAdmission {
  choose(input: ProviderAdmissionInput): ProviderDecision {
    const byId = new Map(input.providers.map(provider => [provider.providerId, provider]));
    const primary = input.providerIds[0] === undefined ? undefined : byId.get(input.providerIds[0]);
    const primaryAvailable = primary?.status !== 'waiting';

    let latestSuccess: LLMProviderRecoveryState | undefined;
    for (const provider of input.providers) {
      if (provider.lastSuccessAt === undefined || provider.cacheValidUntil === undefined) continue;
      if (latestSuccess === undefined || provider.lastSuccessAt > latestSuccess.lastSuccessAt!) {
        latestSuccess = provider;
      }
    }
    const primaryId = input.providerIds[0];
    const stickyProviderId = latestSuccess !== undefined
      && latestSuccess.providerId !== primaryId
      && latestSuccess.status === 'available'
      && latestSuccess.cacheValidUntil! > input.nowMs
      && input.providerIds.includes(latestSuccess.providerId)
      ? latestSuccess.providerId
      : undefined;

    const orderedProviderIds = [...input.providerIds];
    if (stickyProviderId !== undefined) {
      const stickyIndex = orderedProviderIds.indexOf(stickyProviderId);
      if (stickyIndex > 0) {
        const [sticky] = orderedProviderIds.splice(stickyIndex, 1);
        orderedProviderIds.unshift(sticky!);
      }
    }
    return {
      primaryAvailable,
      ...(stickyProviderId !== undefined ? { stickyProviderId } : {}),
      orderedProviderIds,
    };
  }

  canProbe(state: LLMProviderRecoveryState, nowMs: number): boolean {
    if (state.status !== 'waiting') return true;
    return state.retryAt !== undefined && state.retryAt <= nowMs;
  }

  recordFailure(state: LLMProviderRecoveryState, failure: ProviderFailure): LLMProviderRecoveryState {
    const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
    return {
      ...state,
      status: 'waiting',
      retryAt: retryAtForFailure(failure, consecutiveFailures),
      consecutiveFailures,
      lastError: {
        class: failure.errorClass,
        at: failure.occurredAtMs,
        message: failure.message,
        ...(failure.providerLabel !== undefined ? { providerLabel: failure.providerLabel } : {}),
        ...(failure.retryAfterSec !== undefined ? { retryAfterSec: failure.retryAfterSec } : {}),
        ...(failure.resetAtMs !== undefined ? { quotaResetAtMs: failure.resetAtMs } : {}),
      },
    };
  }

  recordSuccess(state: LLMProviderRecoveryState, success: ProviderSuccess): LLMProviderRecoveryState {
    const updateSelection = success.updateSelection ?? true;
    return {
      ...state,
      status: 'available',
      retryAt: undefined,
      consecutiveFailures: 0,
      ...(updateSelection ? {
        lastSuccessAt: success.nowMs,
        cacheValidUntil: success.nowMs + LLM_PROVIDER_SELECTION_TTL_MS,
      } : {}),
    };
  }
}

function retryAtForFailure(failure: ProviderFailure, consecutiveFailures: number): number {
  const nowMs = failure.occurredAtMs;
  const retryAfterAtMs = failure.retryAfterSec !== undefined
    ? nowMs + failure.retryAfterSec * 1000
    : 0;
  if (failure.errorClass === 'quota') {
    const delayMs = Math.min(
      LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1),
      LLM_RECOVERY_QUOTA_MAX_DELAY_MS,
    );
    return Math.max(nowMs + delayMs, retryAfterAtMs, failure.resetAtMs ?? 0);
  }
  if (failure.errorClass === 'rate_limit') {
    if (retryAfterAtMs > 0) return retryAfterAtMs;
    const index = Math.min(Math.max(0, consecutiveFailures - 1), LLM_RECOVERY_RATE_LIMIT_BACKOFF_MS.length - 1);
    return nowMs + LLM_RECOVERY_RATE_LIMIT_BACKOFF_MS[index]!;
  }
  if (failure.errorClass === 'permanent') return nowMs + LLM_RECOVERY_COOLDOWN_MS;
  const delayMs = Math.min(
    LLM_RECOVERY_RETRY_INITIAL_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    LLM_RECOVERY_RETRY_MAX_DELAY_MS,
  );
  return nowMs + delayMs;
}
