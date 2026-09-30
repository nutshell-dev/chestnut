/**
 * Phase 1927 Step C：motion daemon LLM 身份 ready 业务事实协议测试。
 *
 * - encode/decode：roundtrip、schema_version 不符、字段缺失/类型不符均 malformed；
 * - ensureMotionLLMIdentity（start 消费侧）：ok / no_active / fact_missing
 *   （watchdog winner、旧 daemon）/ fact_malformed / generation_mismatch /
 *   identity_mismatch 全部分型 fail-closed（typed MotionLLMIdentityMismatchError，
 *   message 不含 secret）。
 */

import { describe, it, expect } from 'vitest';
import {
  encodeMotionLLMReadyFact,
  decodeMotionLLMReadyFact,
  ensureMotionLLMIdentity,
  MotionLLMIdentityMismatchError,
  type MotionLLMIdentityFailure,
  type MotionLLMReadyFact,
} from '../../src/daemon/llm-ready-fact.js';
import { makeDaemonDir, type DaemonDir } from '../../src/foundation/process-manager/index.js';

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
