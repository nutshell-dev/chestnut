/**
 * Phase 1973 Step D — setup-provider-probe 纯 helper：首胜即停、全败 attempts、顺序稳定。
 */

import { describe, it, expect } from 'vitest';
import { probeSetupCandidates } from '../../src/cli/setup-provider-probe.js';
import type { SetupProbeCandidate } from '../../src/cli/setup-provider-catalog.js';

const KIMI_CANDIDATES: readonly SetupProbeCandidate[] = [
  { presetId: 'kimi', baseUrl: 'https://api.kimi.com/coding', label: 'Kimi Code (CN)' },
  { presetId: 'kimi', baseUrl: 'https://api.kimi.ai/coding', label: 'Kimi Code (Global)' },
  { presetId: 'kimi', baseUrl: 'https://api.moonshot.cn/anthropic', label: 'Kimi Open (CN)' },
  { presetId: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', label: 'Kimi Open (Global)' },
];

describe('probeSetupCandidates', () => {
  it('首胜即停：后续候选不再调用', async () => {
    const calls: string[] = [];
    const result = await probeSetupCandidates(KIMI_CANDIDATES, async (c) => {
      calls.push(c.baseUrl);
      return c.baseUrl.includes('moonshot.cn')
        ? { ok: true, model: 'k3-256k' }
        : { ok: false, errorType: 'auth' as const, message: '401', provider: 'kimi' };
    });
    expect(result.winner?.baseUrl).toBe('https://api.moonshot.cn/anthropic');
    expect(result.winnerModel).toBe('k3-256k');
    // 前两个失败、第三个成功、第四个未调用
    expect(calls).toEqual([
      'https://api.kimi.com/coding',
      'https://api.kimi.ai/coding',
      'https://api.moonshot.cn/anthropic',
    ]);
    expect(result.attempts).toHaveLength(3);
  });

  it('全败返回全部 attempts 且无 winner', async () => {
    const result = await probeSetupCandidates(KIMI_CANDIDATES, async () => ({
      ok: false as const,
      errorType: 'model' as const,
      message: '404',
      provider: 'kimi',
    }));
    expect(result.winner).toBeUndefined();
    expect(result.winnerModel).toBeUndefined();
    expect(result.attempts).toHaveLength(KIMI_CANDIDATES.length);
    expect(result.attempts.map(a => a.candidate.baseUrl)).toEqual(KIMI_CANDIDATES.map(c => c.baseUrl));
    expect(result.attempts.every(a => !a.result.ok)).toBe(true);
  });

  it('顺序稳定：严格按候选数组顺序串行调用', async () => {
    const calls: string[] = [];
    await probeSetupCandidates(KIMI_CANDIDATES, async (c) => {
      calls.push(c.baseUrl);
      return { ok: false as const, errorType: 'network' as const, message: 'timeout', provider: 'kimi' };
    });
    expect(calls).toEqual(KIMI_CANDIDATES.map(c => c.baseUrl));
  });

  it('首个候选成功时只调用一次', async () => {
    const calls: string[] = [];
    const result = await probeSetupCandidates(KIMI_CANDIDATES, async (c) => {
      calls.push(c.baseUrl);
      return { ok: true as const, model: 'k3-256k' };
    });
    expect(calls).toHaveLength(1);
    expect(result.winner?.baseUrl).toBe(KIMI_CANDIDATES[0].baseUrl);
    expect(result.attempts).toHaveLength(1);
  });
});
