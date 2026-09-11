/**
 * Phase 1826 Step Z 首轮未通过项（Z1–Z4）的正式回归。
 *
 * 复现源：`development log/phase1826-logs/Z-review-probes.test.ts.txt`（临时复现，未改源码）。
 * 与复现的差异：预算固定为生产默认 maxAttempts=3；补齐 call/stream 对称、fallback、
 * 重放与重启链路；断言基于真实 Orchestrator/session、真实临时文件存储与计数型假 provider。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { createRecoverySession } from '../../../src/foundation/llm-orchestrator/recovery.js';
import type {
  LLMEventSink,
  LLMOrchestratorOwner,
  LLMRecoverySession,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import { LLMAuthError, LLMNetworkError, LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

function providerConfig(name: string): ProviderConfig {
  return {
    name,
    apiKey: `key-${name}`,
    model: `model-${name}`,
    temperature: 0,
    timeoutMs: 1_000,
    apiFormat: 'anthropic',
  };
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    try { await cleanupTempDir(dir); } catch { /* ignore */ }
  }
});

interface FixtureOpts {
  primaryError?: () => Error;
  fallbackResponse?: () => LLMResponse;
  breaker?: boolean;
}

interface Fixture {
  session: () => LLMRecoverySession;
  sharedOrchestrator: LLMOrchestratorOwner;
  calls: () => number;
  advance: (ms: number) => void;
  now: () => number;
}

async function makeFixture(opts: FixtureOpts = {}): Promise<Fixture> {
  const dir = await createTrackedTempDir('recovery-zk-');
  cleanupDirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const events: LLMEventSink = { emit: () => {} };
  let count = 0;
  let nowMs = Date.now();
  const errors = opts.primaryError ?? (() => new LLMNetworkError('p', new Error('offline')));

  const failAdapter: ProviderAdapter = {
    name: 'primary',
    model: 'model-primary',
    call: async () => { count++; throw errors(); },
    stream: async function* () { count++; throw errors(); },
  };
  const fallbackAdapter: ProviderAdapter = {
    name: 'fallback',
    model: 'model-fallback',
    call: async () => { count++; return (opts.fallbackResponse ?? (() => OK_RESPONSE))(); },
    stream: async function* () {
      count++;
      const r = (opts.fallbackResponse ?? (() => OK_RESPONSE))();
      yield { type: 'text_delta' as const, delta: r.content[0] && 'text' in r.content[0] ? r.content[0].text : '' };
      yield { type: 'done' as const, stopReason: 'end_turn' };
    },
  };

  const orchestrator = createLLMOrchestrator({
    primary: providerConfig('primary'),
    ...(opts.fallbackResponse ? { fallbacks: [providerConfig('fallback')] } : {}),
    maxAttempts: 3,
    retryDelayMs: 0,
    events,
    createAnthropicAdapter: (config) => (config.name === 'fallback' ? fallbackAdapter : failAdapter),
    ...(opts.breaker ? { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 } } : {}),
  });

  return {
    session: () => createRecoverySession({
      scopeId: 'foreground', fs, events, orchestrator, now: () => nowMs,
    }),
    sharedOrchestrator: orchestrator,
    calls: () => count,
    advance: (ms) => { nowMs += ms; },
    now: () => nowMs,
  };
}

const OPTIONS = { messages: [{ role: 'user' as const, content: 'test' }] };

async function failedCall(
  s: LLMRecoverySession,
  stream = false,
): Promise<void> {
  try {
    if (stream) {
      for await (const _ of s.llm.stream(OPTIONS)) { void _; }
    } else {
      await s.llm.call(OPTIONS);
    }
  } catch { /* expected: provider failure */ }
}

const QUOTA_ERROR = () => new LLMAuthError('p', 403, 'weekly usage limit quota reached');

describe('Z1 确定性错误短路与局部预算（maxAttempts=3）', () => {
  it('quota 首次 stream 调用：单候选只 1 次真实请求（不跑满轮内预算）', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    const s = f.session();
    await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });

    await failedCall(s, true);

    expect(f.calls()).toBe(1);
  });

  it('quota 首次 call 调用：与 stream 对称，只 1 次真实请求', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    const s = f.session();
    await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });

    await failedCall(s);

    expect(f.calls()).toBe(1);
  });

  it('quota 恢复 probe：到期后每候选至多 1 次真实请求', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    const s = f.session();
    const a = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    await failedCall(s, true);
    await s.finish(a.attemptId, 'failed');

    f.advance(120_000);
    const b = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    expect(b.kind).toBe('admitted');

    const before = f.calls();
    await failedCall(s, true);
    expect(f.calls() - before).toBe(1);
  });

  it('primary quota + fallback 成功：primary 只 1 次、fallback 正常成功、不建全局等待', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR, fallbackResponse: () => OK_RESPONSE });
    const s = f.session();
    await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });

    await s.llm.call(OPTIONS);

    expect(f.calls()).toBe(2);   // primary 1 次（短路）+ fallback 1 次
    expect((await s.inspect()).kind).toBe('ready');
  });
});

describe('Z2 显式干预穿透旧 breaker（一次性资格）', () => {
  it('breaker open 后新用户干预：真实请求发生', async () => {
    const f = await makeFixture({ breaker: true });
    const s = f.session();

    const a = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    await failedCall(s);           // 网络失败 → breaker open（threshold=1）
    await s.finish(a.attemptId, 'failed');

    const before = f.calls();
    const b = await s.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(b.kind).toBe('admitted');

    await failedCall(s);
    expect(f.calls()).toBeGreaterThan(before);
  });

  it('同一 id 重放：不再获得提前资格（不被 breaker 放行）', async () => {
    const f = await makeFixture({ breaker: true });
    const s = f.session();
    const a = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    await failedCall(s);
    await s.finish(a.attemptId, 'failed');

    const first = await s.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    await failedCall(s);
    await s.finish(first.attemptId, 'failed');

    const replay = await s.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(replay.kind).toBe('waiting');
  });

  it('无 scope 的其他 caller 在 breaker open 时仍被跳过（资格不外溢）', async () => {
    const f = await makeFixture({ breaker: true });
    const s = f.session();
    const a = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    await failedCall(s);
    await s.finish(a.attemptId, 'failed');

    const before = f.calls();
    await expect(f.sharedOrchestrator.call(OPTIONS)).rejects.toBeTruthy();
    expect(f.calls()).toBe(before);   // 非 scoped 调用没有资格，未真发
  });
});

describe('Z3 服务端 Retry-After 不被客户端 cap 截短', () => {
  it('Retry-After 3600 秒：安排不早于其要求', async () => {
    const f = await makeFixture({ primaryError: () => new LLMRateLimitError('p', 3600) });
    const s = f.session();
    await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    await failedCall(s);

    const plan = await s.inspect();
    expect(plan.kind).toBe('at');
    if (plan.kind !== 'at') return;
    expect(Date.parse(plan.resumeAt) - f.now()).toBeGreaterThanOrEqual(3_600_000);
  });
});

describe('Z4 未开始的持久准入在重启后恢复', () => {
  it('begin 后、首请求前重启：同 id 再 begin 得到同一 attempt', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    const s = f.session();
    const a = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    await failedCall(s);
    await s.finish(a.attemptId, 'failed');

    const b = await s.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(b.kind).toBe('admitted');
    if (b.kind !== 'admitted') return;

    const restored = f.session();   // 重启：未开始的准入应被恢复
    const c = await restored.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(c.kind).toBe('admitted');
    if (c.kind === 'admitted') expect(c.attemptId).toBe(b.attemptId);
  });

  it('恢复后的准入仍带原预算/资格，失败后同 id 不重复干预', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR, breaker: true });
    const s = f.session();
    const a = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    await failedCall(s);
    await s.finish(a.attemptId, 'failed');

    const b = await s.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(b.kind).toBe('admitted');
    if (b.kind !== 'admitted') return;

    // 重启后重新驱动同一 attempt：局部资格（为干预放行）仍随准入恢复。
    const restored = f.session();
    const c = await restored.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(c.kind).toBe('admitted');
    expect(restored.attemptContext().allowBreakerProbe).toBe(true);

    const before = f.calls();
    await failedCall(restored);                 // 真实发一次（不被旧 breaker 拒绝）
    expect(f.calls()).toBe(before + 1);
    await restored.finish(c.kind === 'admitted' ? c.attemptId : '', 'failed');

    // 启动后再次失败：同 id 不再获得新的提前机会
    const replay = await restored.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(replay.kind).toBe('waiting');
  });

  it('已开始的准入在重启后仍按「结果未知」处理（不恢复句柄）', async () => {
    const f = await makeFixture({ primaryError: () => new LLMNetworkError('p', new Error('offline')) });
    const s = f.session();
    const a = await s.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    if (a.kind !== 'admitted') throw new Error('expected admitted');
    await failedCall(s);   // started 已置位

    const restored = f.session();
    const c = await restored.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    // 结果未知的旧 attempt 不复活；当前安排（failure）决定是否放行。
    expect(c.kind === 'admitted' ? c.attemptId !== a.attemptId : true).toBe(true);
  });
});
