/**
 * Phase 1927 Step C：motion daemon LLM 身份 ready 业务事实协议测试。
 *
 * - encode/decode：roundtrip、schema_version 不符、字段缺失/类型不符均 malformed；
 * - ensureMotionLLMIdentity（start 消费侧）：ok / no_active / fact_missing
 *   （watchdog winner、旧 daemon）/ fact_malformed / generation_mismatch /
 *   identity_mismatch 全部分型 fail-closed（typed MotionLLMIdentityMismatchError，
 *   message 不含 secret）。
 * - Phase 1945 Step C：createMotionLLMReadyFactPublisher（热重载后发布器）——
 *   fake PM 窄面单测（written/previousRaw 分型、错误类型）+ 真实 PM 集成
 *   （发布后 ensureMotionLLMIdentity 放行新身份、旧身份继续拒绝）。
 */

import { describe, it, expect } from 'vitest';
import {
  encodeMotionLLMReadyFact,
  decodeMotionLLMReadyFact,
  ensureMotionLLMIdentity,
  MotionLLMIdentityMismatchError,
  MotionLLMReadyFactPublishError,
  createMotionLLMReadyFactPublisher,
  type MotionLLMIdentityFailure,
  type MotionLLMReadyFact,
} from '../../src/daemon/llm-ready-fact.js';
import {
  makeDaemonDir,
  ProcessManager,
  type DaemonDir,
  type UpdateActiveBusinessFact,
} from '../../src/foundation/process-manager/index.js';
import {
  newProcessGeneration,
  prepareGeneration,
  commitSpawning,
  writeChildPid,
  type ProcessGenerationRecord,
} from '../../src/foundation/process-manager/generation.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../helpers/audit.js';
import { testClawDaemonDir } from '../helpers/daemon-dir.js';
import type { ProcessManagerContext } from '../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const DAEMON_DIR: DaemonDir = makeDaemonDir('/tmp/test/motion/.daemon');

const FACT: MotionLLMReadyFact = {
  generationId: 'gen-1',
  llmIdentity: 'a'.repeat(64),
  committedAt: '2026-09-29T00:00:00.000Z',
};

type PmNarrow = Parameters<typeof ensureMotionLLMIdentity>[0];

/** PM 窄面 fake（readActiveBusinessFact 唯一消费点）。 */
function fakePm(result: { kind: string; generationId?: string; raw?: string; cause?: unknown }): PmNarrow {
  return {
    readActiveBusinessFact: () => result,
  } as unknown as PmNarrow;
}

function failureOf(run: () => unknown): { err: MotionLLMIdentityMismatchError; failure: MotionLLMIdentityFailure } {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(MotionLLMIdentityMismatchError);
    const err = e as MotionLLMIdentityMismatchError;
    return { err, failure: err.failure };
  }
  throw new Error('expected MotionLLMIdentityMismatchError');
}

describe('MotionLLMReadyFact encode/decode', () => {
  it('roundtrip：encode → decode 得同一事实', () => {
    const decoded = decodeMotionLLMReadyFact(encodeMotionLLMReadyFact(FACT));
    expect(decoded).toEqual({ status: 'ok', fact: FACT });
  });

  it('非法 JSON / 非对象 / schema_version 不符 / 字段缺失 → malformed', () => {
    expect(decodeMotionLLMReadyFact('not-json').status).toBe('malformed');
    expect(decodeMotionLLMReadyFact('"str"').status).toBe('malformed');
    expect(decodeMotionLLMReadyFact(JSON.stringify({ schema_version: 999, ...FACT })).status).toBe('malformed');
    expect(decodeMotionLLMReadyFact(JSON.stringify({ schema_version: 1, llmIdentity: 'x', committedAt: 'y' })).status).toBe('malformed');
    expect(decodeMotionLLMReadyFact(JSON.stringify({ schema_version: 1, generationId: 'g', llmIdentity: 42, committedAt: 'y' })).status).toBe('malformed');
  });
});

describe('ensureMotionLLMIdentity (start 消费侧 fail-closed)', () => {
  it('ok：generation + identity 均相等 → 返回事实', () => {
    const fact = ensureMotionLLMIdentity(
      fakePm({ kind: 'ok', generationId: 'gen-1', raw: encodeMotionLLMReadyFact(FACT) }),
      DAEMON_DIR,
      FACT.llmIdentity,
    );
    expect(fact).toEqual(FACT);
  });

  it('no_active_generation（ready 后竞态 retire/replace）→ fail-closed', () => {
    const { failure } = failureOf(() =>
      ensureMotionLLMIdentity(fakePm({ kind: 'no_active' }), DAEMON_DIR, FACT.llmIdentity));
    expect(failure).toBe('no_active_generation');
  });

  it('fact_missing（watchdog winner / 旧 daemon 未发布）→ fail-closed', () => {
    const { err, failure } = failureOf(() =>
      ensureMotionLLMIdentity(fakePm({ kind: 'fact_missing', generationId: 'gen-9' }), DAEMON_DIR, FACT.llmIdentity));
    expect(failure).toBe('fact_missing');
    expect(err.message).toContain('gen-9');
  });

  it('fact_malformed：PM 读取失败 → fail-closed', () => {
    const { failure } = failureOf(() =>
      ensureMotionLLMIdentity(fakePm({ kind: 'malformed', cause: new Error('EIO') }), DAEMON_DIR, FACT.llmIdentity));
    expect(failure).toBe('fact_malformed');
  });

  it('fact_malformed：内容解析失败 → fail-closed', () => {
    const { failure } = failureOf(() =>
      ensureMotionLLMIdentity(fakePm({ kind: 'ok', generationId: 'gen-1', raw: 'garbage' }), DAEMON_DIR, FACT.llmIdentity));
    expect(failure).toBe('fact_malformed');
  });

  it('generation_mismatch：事实自称的 generation 与 active 不等 → fail-closed', () => {
    const raw = encodeMotionLLMReadyFact({ ...FACT, generationId: 'gen-stale' });
    const { failure } = failureOf(() =>
      ensureMotionLLMIdentity(fakePm({ kind: 'ok', generationId: 'gen-1', raw }), DAEMON_DIR, FACT.llmIdentity));
    expect(failure).toBe('generation_mismatch');
  });

  it('identity_mismatch：配置 A 的 daemon 不得服务验证 B 的 start（message 无 secret）', () => {
    const otherIdentity = 'b'.repeat(64);
    const { err, failure } = failureOf(() =>
      ensureMotionLLMIdentity(
        fakePm({ kind: 'ok', generationId: 'gen-1', raw: encodeMotionLLMReadyFact(FACT) }),
        DAEMON_DIR,
        otherIdentity,
      ));
    expect(failure).toBe('identity_mismatch');
    expect(err.message).toContain(FACT.llmIdentity);
    expect(err.message).toContain(otherIdentity);
    expect(err.message).not.toMatch(/api[_-]?key/i);
  });
});

// ── Phase 1945 Step C：createMotionLLMReadyFactPublisher（热重载后发布器）──────

describe('createMotionLLMReadyFactPublisher（Phase 1945 Step C）', () => {
  const BINDING = { generationId: 'gen-1', pid: 4321 };
  const IDENTITY_B = 'b'.repeat(64);

  /** PM 窄面 fake（updateActiveBusinessFact 唯一消费点）；捕获收到的 raw。 */
  function fakeUpdatePm(result: UpdateActiveBusinessFact) {
    const calls: { daemonDir: DaemonDir; expected: { generationId: string; pid: number }; raw: string }[] = [];
    return {
      calls,
      pm: {
        updateActiveBusinessFact: async (daemonDir: DaemonDir, expected: { generationId: string; pid: number }, raw: string) => {
          calls.push({ daemonDir, expected, raw });
          return result;
        },
      },
    };
  }

  it('written + 旧事实可读 → 交还 previousIdentity/previousFact=ok；写入的新事实可解码且绑定 generation', async () => {
    const previousRaw = encodeMotionLLMReadyFact(FACT);
    const { calls, pm } = fakeUpdatePm({ kind: 'written', previousRaw });
    const publish = createMotionLLMReadyFactPublisher(pm, DAEMON_DIR, BINDING);

    const outcome = await publish(IDENTITY_B);

    expect(outcome).toEqual({ previousIdentity: FACT.llmIdentity, previousFact: 'ok' });
    expect(calls.length).toBe(1);
    expect(calls[0].daemonDir).toBe(DAEMON_DIR);
    expect(calls[0].expected).toEqual(BINDING);
    const written = decodeMotionLLMReadyFact(calls[0].raw);
    expect(written.status).toBe('ok');
    expect(written.status === 'ok' && written.fact.llmIdentity).toBe(IDENTITY_B);
    expect(written.status === 'ok' && written.fact.generationId).toBe(BINDING.generationId);
  });

  it('written + 旧事实缺失 → previousFact=missing（修复路径）', async () => {
    const { pm } = fakeUpdatePm({ kind: 'written', previousRaw: undefined });
    const outcome = await createMotionLLMReadyFactPublisher(pm, DAEMON_DIR, BINDING)(IDENTITY_B);
    expect(outcome).toEqual({ previousFact: 'missing' });
  });

  it('written + 旧事实不可解析 → previousFact=malformed（不阻断本次发布成功事实）', async () => {
    const { pm } = fakeUpdatePm({ kind: 'written', previousRaw: 'garbage' });
    const outcome = await createMotionLLMReadyFactPublisher(pm, DAEMON_DIR, BINDING)(IDENTITY_B);
    expect(outcome).toEqual({ previousFact: 'malformed' });
  });

  it('PM 拒绝（generation_mismatch / no_active / retryable_failure）→ typed MotionLLMReadyFactPublishError 携带 kind', async () => {
    for (const result of [
      { kind: 'generation_mismatch' },
      { kind: 'no_active' },
      { kind: 'retryable_failure', cause: new Error('EIO') },
    ] as UpdateActiveBusinessFact[]) {
      const { pm } = fakeUpdatePm(result);
      const err = await createMotionLLMReadyFactPublisher(pm, DAEMON_DIR, BINDING)(IDENTITY_B)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MotionLLMReadyFactPublishError);
      expect((err as MotionLLMReadyFactPublishError).kind).toBe(result.kind);
      expect((err as Error).message).not.toMatch(/api[_-]?key/i);
    }
  });

  it('真实 PM 集成：出生身份 A → 发布 B 后 ensureMotionLLMIdentity 放行 B、拒绝 A', async () => {
    const tempDir = await createTrackedTempDir('llm-ready-fact-publish-');
    try {
      const nodeFs = new NodeFileSystem({ baseDir: tempDir });
      const daemonDir = testClawDaemonDir(tempDir, 'motion');
      const { audit } = makeAudit();
      const ctx: ProcessManagerContext = { fs: nodeFs, audit, getProcessStartTime: () => undefined };
      const pm = new ProcessManager(nodeFs, audit);

      // 出生：spawning 协议 + activation 携带身份 A 的业务事实
      const record: ProcessGenerationRecord = newProcessGeneration(ctx, daemonDir);
      prepareGeneration(ctx, record);
      expect(commitSpawning(ctx, record).kind).toBe('committed');
      expect((await writeChildPid(ctx, record, BINDING.pid)).kind).toBe('written');
      const birth = await pm.activateChildGeneration(daemonDir, {
        generationId: record.generation_id,
        pid: BINDING.pid,
        startTime: undefined,
        businessFact: encodeMotionLLMReadyFact({
          generationId: record.generation_id,
          llmIdentity: FACT.llmIdentity,
          committedAt: new Date().toISOString(),
        }),
      });
      expect(birth.kind).toBe('activated');

      // 出生事实消费：身份 A 放行
      const before = ensureMotionLLMIdentity(pm, daemonDir, FACT.llmIdentity);
      expect(before.llmIdentity).toBe(FACT.llmIdentity);

      // 热重载成功 → 发布身份 B（真实 updateActiveBusinessFact 路径）
      const publish = createMotionLLMReadyFactPublisher(pm, daemonDir, {
        generationId: record.generation_id,
        pid: BINDING.pid,
      });
      const outcome = await publish(IDENTITY_B);
      expect(outcome).toEqual({ previousIdentity: FACT.llmIdentity, previousFact: 'ok' });

      // 发布后：新身份放行（start 门通过），旧身份 fail-closed（真实分歧仍拒绝）
      const after = ensureMotionLLMIdentity(pm, daemonDir, IDENTITY_B);
      expect(after.llmIdentity).toBe(IDENTITY_B);
      const { failure } = failureOf(() => ensureMotionLLMIdentity(pm, daemonDir, FACT.llmIdentity));
      expect(failure).toBe('identity_mismatch');
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
