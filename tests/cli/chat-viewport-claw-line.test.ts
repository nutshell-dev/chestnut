/**
 * Phase 1978: claw 状态行 context trim 三态展示 + track 生命周期。
 *
 * - buildClawLine 不活跃分支优先级：blockedNotice > retryNotice > lastError；
 * - createClawManager 消费 context_trim_* 事件，不污染 lastError；
 * - turn_start / turn_end / turn_interrupted 清理 notices。
 */

import { describe, it, expect } from 'vitest';
import { buildClawLine, makeClawTrack } from '../../src/viewport/chat-viewport-claw-line.js';
import { createClawManager } from '../../src/viewport/chat-viewport-claw-manager.js';

describe('Phase 1978 buildClawLine context trim notices', () => {
  function runningTrack() {
    const t = makeClawTrack();
    t.hasContract = true;
    t.isAlive = true;
    t.daemonStatus = 'running';
    return t;
  }

  it('blockedNotice > retryNotice > lastError 优先级与颜色', () => {
    const t = runningTrack();
    t.lastError = 'boom';
    t.retryNotice = 'context exceeded · retrying (1/3, 30s)';
    t.blockedNotice = 'context blocked (no_progress)';

    const blocked = buildClawLine('c', t, 120);
    expect(blocked).toContain('[c] ⏸ context blocked (no_progress)');
    expect(blocked).toContain('\x1b[38;5;214m');
    expect(blocked).not.toContain('✗');

    t.blockedNotice = null;
    const retry = buildClawLine('c', t, 120);
    expect(retry).toContain('[c] ⟳ context exceeded · retrying (1/3, 30s)');
    expect(retry).toContain('\x1b[33m');
    expect(retry).not.toContain('✗');

    t.retryNotice = null;
    expect(buildClawLine('c', t, 120)).toContain('[c] ✗ boom');
  });

  it('默认 makeClawTrack 无 notices', () => {
    const t = makeClawTrack();
    expect(t.retryNotice).toBeNull();
    expect(t.blockedNotice).toBeNull();
  });
});

describe('Phase 1978 claw manager context trim lifecycle', () => {
  function makeManager() {
    let content = '';
    const fs = {
      statSync: () => ({ size: Buffer.byteLength(content) }),
      readBytesSync: (_path: string, start: number, end: number) =>
        Buffer.from(content.slice(start, end), 'utf-8'),
    };
    const clawTrackMap = new Map<string, ReturnType<typeof makeClawTrack>>();
    const track = makeClawTrack();
    track.hasContract = true;
    track.isAlive = true;
    track.daemonStatus = 'running';
    clawTrackMap.set('c', track);

    const manager = createClawManager({
      fs: fs as never,
      pm: {
        inspectSpawning: () => ({ status: 'no_record' }),
        isAlive: () => true,
      },
      audit: { write: () => {} } as never,
      isMotion: true,
      clawTopology: {
        resolve: () => ({ kind: 'local', clawDir: '/tmp/claw-c' }),
        enumerate: () => [],
      } as never,
      clawTrackMap,
      updateClawPanel: () => {},
    });

    const push = (event: Record<string, unknown>) => {
      content += `${JSON.stringify(event)}\n`;
      manager.refreshClawStatus('c');
    };

    return { manager, track, push };
  }

  it('context turn_error 不写 lastError；retry 覆盖临时提示；blocked 清 retry', () => {
    const { track, push } = makeManager();

    push({ ts: 1, type: 'turn_error', error: '[LLM_CONTEXT_EXCEEDED] LLM context exceeded for p' });
    expect(track.lastError).toBeNull();
    expect(track.retryNotice).toBe('context exceeded; trimming…');
    expect(track.blockedNotice).toBeNull();

    push({ ts: 2, type: 'context_trim_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 30_000, before: 1000, after: 100 });
    expect(track.retryNotice).toBe('context exceeded · retrying (1/3, 30s)');
    expect(track.blockedNotice).toBeNull();
    expect(track.lastError).toBeNull();

    push({ ts: 3, type: 'context_trim_blocked', reason: 'no_progress', before: 1000, after: 1000 });
    expect(track.retryNotice).toBeNull();
    expect(track.blockedNotice).toBe('context blocked (no_progress)');
    expect(track.lastError).toBeNull();
  });

  it('普通 turn_error 仍写 lastError，且不发 retry notice', () => {
    const { track, push } = makeManager();

    push({ ts: 1, type: 'turn_error', error: 'boom' });
    expect(track.lastError).toBe('boom');
    expect(track.retryNotice).toBeNull();
    expect(track.blockedNotice).toBeNull();
  });

  it('turn_start / turn_end / turn_interrupted 清理 notices', () => {
    const { track, push } = makeManager();

    push({ ts: 1, type: 'context_trim_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 30_000, before: 1000, after: 100 });
    expect(track.retryNotice).not.toBeNull();

    push({ ts: 2, type: 'turn_start' });
    expect(track.retryNotice).toBeNull();
    expect(track.blockedNotice).toBeNull();

    push({ ts: 3, type: 'context_trim_blocked', reason: 'policy_conflict', before: 1, after: 1 });
    expect(track.blockedNotice).not.toBeNull();
    push({ ts: 4, type: 'turn_end' });
    expect(track.blockedNotice).toBeNull();

    push({ ts: 5, type: 'context_trim_retry_scheduled', attempt: 2, maxAttempts: 3, delayMs: 60_000, before: 1, after: 0 });
    expect(track.retryNotice).not.toBeNull();
    push({ ts: 6, type: 'turn_interrupted', cause: 'user_interrupt' });
    expect(track.retryNotice).toBeNull();
    expect(track.blockedNotice).toBeNull();
  });
});
