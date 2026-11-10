import { describe, expect, it } from 'vitest';
import {
  applyLegacyRecoveryRelease,
  deriveLegacyRecoverySchedule,
} from '../../../src/foundation/llm-orchestrator/legacy-recovery-compat.js';
import type { LLMInstanceRecoveryProviderFact } from '../../../src/foundation/llm-orchestrator/instance-state.js';

function fact(
  providerId: string,
  extra: Partial<LLMInstanceRecoveryProviderFact> = {},
): LLMInstanceRecoveryProviderFact {
  return {
    providerId,
    errorClass: 'transient',
    at: '2026-11-10T00:00:00.000Z',
    consecutiveFailures: 2,
    detail: 'offline',
    blocking: true,
    ...extra,
  };
}

describe('legacy recovery schedule interpretation', () => {
  it('derives ready, at and on_change only inside the compatibility adapter', () => {
    expect(deriveLegacyRecoverySchedule({ providers: [] }, 3, ['current']))
      .toEqual({ kind: 'ready', revision: 3 });
    expect(deriveLegacyRecoverySchedule({
      providers: [
        fact('current', { retryAt: '2026-11-10T00:02:00.000Z' }),
        fact('other', { retryAt: '2026-11-10T00:01:00.000Z' }),
      ],
    }, 4, ['current', 'other'])).toEqual({
      kind: 'at', revision: 4, resumeAt: '2026-11-10T00:01:00.000Z',
    });
    expect(deriveLegacyRecoverySchedule({ providers: [fact('current')] }, 5, ['current']))
      .toEqual({ kind: 'on_change', revision: 5 });
  });
});

describe('legacy recovery release adapter', () => {
  it('isolates configuration release, preserves unrelated evidence and is idempotent', () => {
    const providers = [
      fact('old', { errorClass: 'permanent', consecutiveFailures: 7 }),
      fact('current', {
        identityMigrationPending: true,
        rateLimitBlocked: true,
        rateLimitBlockedAt: '2026-11-10T00:00:00.000Z',
        rateLimitFailures: 10,
      }),
    ];
    const input = {
      providerIds: ['current'], configurationChanged: true, hasFreshIntervention: false,
      entryScheduleKind: 'on_change' as const,
    };
    const released = applyLegacyRecoveryRelease(providers, input);

    expect(released.changed).toBe(true);
    expect(released.providers).toEqual([expect.objectContaining({
      providerId: 'current', consecutiveFailures: 2, detail: 'offline',
      rateLimitFailures: 0,
    })]);
    expect(released.providers[0]).not.toHaveProperty('identityMigrationPending');
    expect(released.providers[0]).not.toHaveProperty('rateLimitBlocked');
    expect(providers[0]).toHaveProperty('providerId', 'old');

    const replay = applyLegacyRecoveryRelease(released.providers, input);
    expect(replay.providers).toEqual(released.providers);
    expect(replay.changed).toBe(false);
  });

  it.each(['ready', 'at'] as const)(
    'does not release remaining facts from the legacy schedule when current entry is %s',
    entryScheduleKind => {
      const retryAt = '2026-11-10T00:05:00.000Z';
      const providers = [
        fact('retired', { errorClass: 'permanent' }),
        fact('current', { retryAt }),
      ];
      const before = structuredClone(providers);

      const result = applyLegacyRecoveryRelease(providers, {
        providerIds: ['current'], configurationChanged: true, hasFreshIntervention: false,
        entryScheduleKind,
      });

      expect(result.providers).toEqual([expect.objectContaining({
        providerId: 'current', blocking: true, retryAt,
      })]);
      expect(providers).toEqual(before);
    },
  );

  it('uses a current on_change entry to clear remaining blocking and retryAt after release', () => {
    const result = applyLegacyRecoveryRelease([
      fact('retired', { errorClass: 'permanent', retryAt: '2026-11-10T00:01:00.000Z' }),
      fact('current', { retryAt: '2026-11-10T00:05:00.000Z' }),
    ], {
      providerIds: ['current'], configurationChanged: true, hasFreshIntervention: false,
      entryScheduleKind: 'on_change',
    });

    expect(result.providers).toEqual([expect.objectContaining({
      providerId: 'current', blocking: false, retryAt: undefined,
    })]);
  });

  it('does not release all facts without a release or while a permanent fact remains', () => {
    const unchanged = applyLegacyRecoveryRelease([fact('current')], {
      providerIds: ['current'], configurationChanged: true, hasFreshIntervention: false,
      entryScheduleKind: 'on_change',
    });
    expect(unchanged.providers[0]).toMatchObject({ blocking: true });

    const stillBlocked = applyLegacyRecoveryRelease([
      fact('retired', { errorClass: 'permanent' }),
      fact('current', { errorClass: 'permanent', retryAt: '2026-11-10T00:05:00.000Z' }),
    ], {
      providerIds: ['current'], configurationChanged: true, hasFreshIntervention: false,
      entryScheduleKind: 'on_change',
    });
    expect(stillBlocked.providers).toEqual([expect.objectContaining({
      providerId: 'current', errorClass: 'permanent',
      blocking: true, retryAt: '2026-11-10T00:05:00.000Z',
    })]);
  });

  it('releases legacy rate-limit blocks only for a fresh intervention', () => {
    const providers = [fact('current', {
      rateLimitBlocked: true,
      rateLimitBlockedAt: '2026-11-10T00:00:00.000Z',
      rateLimitFailures: 4,
    })];
    const unchanged = applyLegacyRecoveryRelease(providers, {
      providerIds: ['current'], configurationChanged: false, hasFreshIntervention: false,
      entryScheduleKind: 'ready',
    });
    expect(unchanged.providers).toEqual(providers);
    expect(unchanged.changed).toBe(false);

    const released = applyLegacyRecoveryRelease(providers, {
      providerIds: ['current'], configurationChanged: false, hasFreshIntervention: true,
      entryScheduleKind: 'ready',
    });
    expect(released.providers[0]).toMatchObject({ rateLimitFailures: 0, blocking: true });
    expect(released.providers[0]).not.toHaveProperty('rateLimitBlocked');
    expect(applyLegacyRecoveryRelease(released.providers, {
      providerIds: ['current'], configurationChanged: false, hasFreshIntervention: true,
    }).changed).toBe(false);
  });
});
