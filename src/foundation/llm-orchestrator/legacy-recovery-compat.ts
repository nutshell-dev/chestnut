/**
 * 旧 recovery.providers 的显式兼容解释。当前恢复安排只读统一 provider states；
 * 本模块不写文件、不调用 provider，也不产生另一份 retryAt 权威。
 */
import type {
  LLMInstanceRecoveryProviderFact,
  LLMInstanceRecoveryState,
} from './instance-state.js';
import type { LLMRecoverySchedule } from './recovery-state.js';

export interface LegacyReleaseInput {
  providerIds: readonly string[];
  configurationChanged: boolean;
  hasFreshIntervention: boolean;
}

export interface LegacyReleaseResult {
  providers: LLMInstanceRecoveryProviderFact[];
  changed: boolean;
}

/** 仅供旧记录迁移/兼容测试解释；生产 schedule 不得传入旧 recovery 对象。 */
export function deriveLegacyRecoverySchedule(
  state: Pick<LLMInstanceRecoveryState, 'providers'>,
  revision: number,
  currentProviderIds: readonly string[] = [],
): LLMRecoverySchedule {
  const blocked = state.providers.filter(fact => fact.blocking);
  const blockedIds = new Set(blocked.map(fact => fact.providerId));
  if (blocked.length === 0 || currentProviderIds.some(providerId => !blockedIds.has(providerId))) {
    return { kind: 'ready', revision };
  }
  let earliest: string | undefined;
  for (const fact of blocked) {
    if (fact.retryAt === undefined) continue;
    if (earliest === undefined || Date.parse(fact.retryAt) < Date.parse(earliest)) earliest = fact.retryAt;
  }
  return earliest === undefined
    ? { kind: 'on_change', revision }
    : { kind: 'at', revision, resumeAt: earliest };
}

/** 在 begin 接受到新事实后转换旧字段；同一输入重放不会重复释放或删除证据。 */
export function applyLegacyRecoveryRelease(
  providers: readonly LLMInstanceRecoveryProviderFact[],
  input: LegacyReleaseInput,
): LegacyReleaseResult {
  let next = [...providers];
  let changed = false;

  if (input.configurationChanged) {
    const currentIds = new Set(input.providerIds);
    const entrySchedule = deriveLegacyRecoverySchedule({ providers: next }, 0, input.providerIds);
    let released = false;
    next = next.flatMap(fact => {
      const providerChanged = fact.identityMigrationPending === true || !currentIds.has(fact.providerId);
      if (!providerChanged) return [fact];
      changed = true;
      if (fact.errorClass === 'permanent') {
        released = true;
        return [];
      }
      if (fact.rateLimitBlocked === true) released = true;
      return [clearIdentityMigrationPending(releaseRateLimitBlocked(fact))];
    });
    const stillBlocked = next.some(fact =>
      fact.blocking && (fact.errorClass === 'permanent' || fact.rateLimitBlocked === true),
    );
    if (released && entrySchedule.kind === 'on_change' && !stillBlocked) {
      next = next.map(fact => ({ ...fact, blocking: false, retryAt: undefined }));
    }
  } else {
    next = next.map(fact => {
      const cleared = clearIdentityMigrationPending(fact);
      if (cleared !== fact) changed = true;
      return cleared;
    });
  }

  if (input.hasFreshIntervention) {
    next = next.map(fact => {
      const released = releaseRateLimitBlocked(fact);
      if (released !== fact) changed = true;
      return released;
    });
  }
  return { providers: next, changed };
}

function clearIdentityMigrationPending(
  fact: LLMInstanceRecoveryProviderFact,
): LLMInstanceRecoveryProviderFact {
  if (fact.identityMigrationPending === undefined) return fact;
  const { identityMigrationPending: _pending, ...rest } = fact;
  return rest;
}

function releaseRateLimitBlocked(
  fact: LLMInstanceRecoveryProviderFact,
): LLMInstanceRecoveryProviderFact {
  if (fact.rateLimitBlocked !== true) return fact;
  const { rateLimitBlocked: _blocked, rateLimitBlockedAt: _blockedAt, ...rest } = fact;
  return { ...rest, rateLimitFailures: 0 };
}
