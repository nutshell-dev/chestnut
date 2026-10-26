/**
 * Phase 2003 Step F：错误状态完整同步——stream 错误/终止事件 → activity payload 全矩阵，
 * 锁定 producer 输出与 claw bar 共享 formatter（formatClawBarError）逐字节一致：
 * 普通错误 ✗、context exceeded 临时/正式 retry ⟳、blocked ⏸、interrupted ✗，
 * sinceMs 携带事件 ts 作为 viewport/launcher 统一的 duration 时间原点。
 */

import { describe, expect, it } from 'vitest';
import { LauncherActivityMapper } from '../../src/cli/launcher-envelope-producer.js';
import { formatClawBarError, launcherActivityEnvelope } from '../../src/cli-protocol/index.js';
import { isContextExceededStreamError, LLM_CONTEXT_EXCEEDED_STREAM_PREFIX } from '../../src/foundation/stream/index.js';

const CLAW = 'test-claw';

describe('launcher 错误状态同步（Step F 矩阵）', () => {
  it('普通 turn_error → error phase，detail = formatter 输出，sinceMs = 事件 ts', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    const ts = 1_700_000_000_000;
    expect(mapper.map({ ts, type: 'turn_error', error: 'LLM 网络失败', trace_id: 't1' } as never)).toEqual({
      phase: 'error',
      label: 'turn',
      detail: formatClawBarError(CLAW, { kind: 'error', message: 'LLM 网络失败' }),
      sinceMs: ts,
      traceId: 't1',
    });
  });

  it('context-exceeded turn_error（wire 前缀）→ retry 临时态，不当普通 ✗ 错误', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    const ts = 1_700_000_000_000;
    expect(
      mapper.map({ ts, type: 'turn_error', error: `${LLM_CONTEXT_EXCEEDED_STREAM_PREFIX} prompt too long`, trace_id: 't1' } as never),
    ).toEqual({
      phase: 'retry',
      detail: formatClawBarError(CLAW, { kind: 'retry', message: 'context exceeded; trimming…' }),
      sinceMs: ts,
      traceId: 't1',
    });
  });

  it('context_trim_retry_scheduled → retry 正式态（attempt/max/delay 覆盖临时提示）', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    expect(
      mapper.map({ ts: 1, type: 'context_trim_retry_scheduled', attempt: 2, maxAttempts: 5, delayMs: 4000, trace_id: 't1' } as never),
    ).toEqual({
      phase: 'retry',
      detail: formatClawBarError(CLAW, { kind: 'retry', message: 'context exceeded · retrying (2/5, 4s)' }),
      traceId: 't1',
    });
  });

  it('context_trim_retry_scheduled 缺字段 → 回落临时提示文案', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    expect(mapper.map({ ts: 1, type: 'context_trim_retry_scheduled', trace_id: 't1' } as never)).toEqual({
      phase: 'retry',
      detail: formatClawBarError(CLAW, { kind: 'retry', message: 'context exceeded; trimming…' }),
      traceId: 't1',
    });
  });

  it('context_trim_blocked → blocked 终局（⏸，不是普通 ✗）', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    const ts = 1_700_000_000_000;
    expect(mapper.map({ ts, type: 'context_trim_blocked', reason: 'retry_exhausted', trace_id: 't1' } as never)).toEqual({
      phase: 'blocked',
      detail: formatClawBarError(CLAW, { kind: 'blocked', message: 'context blocked (retry_exhausted)' }),
      sinceMs: ts,
      traceId: 't1',
    });
  });

  it('turn_interrupted → interrupted 错误行（保留可见，不再静默 idle）', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    const ts = 1_700_000_000_000;
    expect(mapper.map({ ts, type: 'turn_interrupted', cause: 'user_interrupt', trace_id: 't1' } as never)).toEqual({
      phase: 'interrupted',
      detail: formatClawBarError(CLAW, { kind: 'interrupted' }),
      sinceMs: ts,
      traceId: 't1',
    });
  });

  it('turn_end 仍映射 idle（唯一恢复无活动的终止事件）', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    expect(mapper.map({ ts: 1, type: 'turn_end', trace_id: 't1' } as never)).toEqual({ phase: 'idle', traceId: 't1' });
  });

  it('context-exceeded 判定与 viewport 共享同一 wire 前缀单源', () => {
    expect(isContextExceededStreamError(`${LLM_CONTEXT_EXCEEDED_STREAM_PREFIX} x`)).toBe(true);
    expect(isContextExceededStreamError('LLM 网络失败')).toBe(false);
    expect(isContextExceededStreamError(undefined)).toBe(false);
  });

  it('activity envelope wire 形状：sinceMs 写入 payload；缺省字段不写入', () => {
    const withSince = launcherActivityEnvelope(7, 's1', {
      phase: 'error',
      label: 'turn',
      detail: '[test-claw] ✗ boom',
      sinceMs: 42,
      traceId: 't1',
    });
    expect(withSince.sequence).toBe(7);
    expect(withSince.kind).toBe('activity');
    expect(withSince.payload).toEqual({
      phase: 'error',
      label: 'turn',
      detail: '[test-claw] ✗ boom',
      sinceMs: 42,
      traceId: 't1',
    });
    const minimal = launcherActivityEnvelope(8, 's1', { phase: 'idle' });
    expect(minimal.payload).toEqual({ phase: 'idle' });
  });

  it('retry/blocked/interrupted/error 的 detail 符号与 viewport claw bar 同规则（⟳/⏸/✗）', () => {
    const mapper = new LauncherActivityMapper(CLAW);
    const retry = mapper.map({ ts: 1, type: 'context_trim_retry_scheduled', attempt: 1, maxAttempts: 5, delayMs: 1000 } as never);
    const blocked = mapper.map({ ts: 2, type: 'context_trim_blocked', reason: 'no_progress' } as never);
    const interrupted = mapper.map({ ts: 3, type: 'turn_interrupted' } as never);
    const error = mapper.map({ ts: 4, type: 'turn_error', error: 'boom' } as never);
    expect(retry?.detail).toContain('⟳');
    expect(blocked?.detail).toContain('⏸');
    expect(interrupted?.detail).toContain('✗ interrupted');
    expect(error?.detail).toBe(`[${CLAW}] ✗ boom`);
    // detail 均为单行（claw bar 单行约束）
    for (const d of [retry?.detail, blocked?.detail, interrupted?.detail, error?.detail]) {
      expect(d).toBeDefined();
      expect(d).not.toContain('\n');
    }
  });
});
