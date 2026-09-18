/**
 * Phase 270 Step B + Phase 283: subagent multi-artifact completeness cross-source audit tests.
 * Only AC-4 remains (phase 224 同源 bug 子代理检测).
 *
 * phase 1858 Step K (SA-D10): 消费面改 lifecycle sink（结构化断言）；
 * 事件字符串 / 列格式由 adapter 等价矩阵守（lifecycle-sink-equivalence.test.ts）。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  auditSubagentArtifactCompleteness,
  type ArtifactSnapshot,
  type ArtifactDeps,
} from '../../../src/core/subagent/artifact-cross-source-audit.js';

function makeMockMessageStore(overrides: { messages?: any[]; loadThrow?: boolean; loadIoError?: string } = {}) {
  return {
    load: vi.fn(async () => {
      if (overrides.loadThrow) throw new Error('load error');
      if (overrides.loadIoError) {
        return { source: 'io_error', error: overrides.loadIoError, session: null };
      }
      return {
        source: 'current',
        session: {
          messages: overrides.messages ?? [],
        },
      };
    }),
  } as unknown as ArtifactDeps['messageStore'];
}

function makeMockSink() {
  return {
    artifactCrossSourceOk: vi.fn(),
    artifactCrossSourceMismatch: vi.fn(),
    artifactCrossSourceSkipped: vi.fn(),
  };
}

function makeSnapshot(partial: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot {
  return {
    resultDir: '/tmp/results/test-agent',
    textEndCount: 0,
    ...partial,
  };
}

describe('subagent multi-artifact completeness audit (phase 270 Step B + phase 283)', () => {
  describe('AC-4: textEnd vs last assistant', () => {
    it('textend=1 + 末轮 assistant 含 text → ac4_ok（检查结论持久化，phase 1858 Step D）', async () => {
      const sink = makeMockSink();
      const messageStore = makeMockMessageStore({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        ],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        sink as any,
      );
      expect(sink.artifactCrossSourceOk).toHaveBeenCalledTimes(1);
      expect(sink.artifactCrossSourceOk).toHaveBeenCalledWith({ textEndCount: 1, lastRole: 'assistant' });
      expect(sink.artifactCrossSourceMismatch).not.toHaveBeenCalled();
      expect(sink.artifactCrossSourceSkipped).not.toHaveBeenCalled();
    });

    it('textend=1 + 末轮 assistant string content → ac4_ok', async () => {
      const sink = makeMockSink();
      const messageStore = makeMockMessageStore({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        sink as any,
      );
      expect(sink.artifactCrossSourceOk).toHaveBeenCalledTimes(1);
      expect(sink.artifactCrossSourceOk).toHaveBeenCalledWith({ textEndCount: 1, lastRole: 'assistant' });
    });

    it('textend=1 + 末轮 user → mismatch ac4', async () => {
      const sink = makeMockSink();
      const messageStore = makeMockMessageStore({
        messages: [
          { role: 'user', content: 'hi' },
        ],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        sink as any,
      );
      expect(sink.artifactCrossSourceMismatch).toHaveBeenCalledTimes(1);
      expect(sink.artifactCrossSourceMismatch).toHaveBeenCalledWith({ textEndCount: 1, lastRole: 'user' });
      expect(sink.artifactCrossSourceOk).not.toHaveBeenCalled();
    });

    it('textend=0 → 不 check (skip silent)', async () => {
      const sink = makeMockSink();
      const messageStore = makeMockMessageStore({
        messages: [{ role: 'user', content: 'hi' }],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 0 }),
        { fs: {} as any, messageStore },
        sink as any,
      );
      expect(sink.artifactCrossSourceOk).not.toHaveBeenCalled();
      expect(sink.artifactCrossSourceMismatch).not.toHaveBeenCalled();
      expect(sink.artifactCrossSourceSkipped).not.toHaveBeenCalled();
    });

    it('messageStore.load throw → skipped ac4_skip（reason=message_load_failed）', async () => {
      const sink = makeMockSink();
      const messageStore = makeMockMessageStore({ loadThrow: true });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        sink as any,
      );
      expect(sink.artifactCrossSourceSkipped).toHaveBeenCalledTimes(1);
      expect(sink.artifactCrossSourceSkipped).toHaveBeenCalledWith({
        kind: 'ac4_skip',
        reason: 'message_load_failed',
        error: 'load error',
      });
    });

    it('messageStore.load returns io_error → skipped ac4_skip without mismatch', async () => {
      const sink = makeMockSink();
      const messageStore = makeMockMessageStore({ loadIoError: 'EACCES' });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        sink as any,
      );
      expect(sink.artifactCrossSourceSkipped).toHaveBeenCalledTimes(1);
      expect(sink.artifactCrossSourceSkipped).toHaveBeenCalledWith({
        kind: 'ac4_skip',
        reason: 'message_load_io_error',
        error: 'EACCES',
      });
      expect(sink.artifactCrossSourceMismatch).not.toHaveBeenCalled();
    });
  });
});
