/**
 * Phase 270 Step B + Phase 283: subagent multi-artifact completeness cross-source audit tests.
 * Only AC-4 remains (phase 224 同源 bug 子代理检测).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  auditSubagentArtifactCompleteness,
  type ArtifactSnapshot,
  type ArtifactDeps,
} from '../../../src/core/subagent/artifact-cross-source-audit.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';

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

function makeMockAudit() {
  return {
    write: vi.fn(),
  };
}

function makeSnapshot(partial: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot {
  return {
    agentId: 'test-agent',
    resultDir: '/tmp/results/test-agent',
    textEndCount: 0,
    ...partial,
  };
}

describe('subagent multi-artifact completeness audit (phase 270 Step B + phase 283)', () => {
  describe('AC-4: textEnd vs last assistant', () => {
    it('textend=1 + 末轮 assistant 含 text → 0 emit', async () => {
      const audit = makeMockAudit();
      const messageStore = makeMockMessageStore({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        ],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        audit as any,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('textend=1 + 末轮 assistant string content → 0 emit', async () => {
      const audit = makeMockAudit();
      const messageStore = makeMockMessageStore({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        audit as any,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('textend=1 + 末轮 user → emit ac4', async () => {
      const audit = makeMockAudit();
      const messageStore = makeMockMessageStore({
        messages: [
          { role: 'user', content: 'hi' },
        ],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        audit as any,
      );
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0]).toBe(SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_MISMATCH);
      expect(audit.write.mock.calls[0]).toContain('kind=ac4_textend_without_last_assistant_text');
    });

    it('textend=0 → 不 check (skip silent)', async () => {
      const audit = makeMockAudit();
      const messageStore = makeMockMessageStore({
        messages: [{ role: 'user', content: 'hi' }],
      });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 0 }),
        { fs: {} as any, messageStore },
        audit as any,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('messageStore.load throw → emit _skipped ac4_skip', async () => {
      const audit = makeMockAudit();
      const messageStore = makeMockMessageStore({ loadThrow: true });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        audit as any,
      );
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0]).toBe(SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED);
      expect(audit.write.mock.calls[0]).toContain('kind=ac4_skip');
    });

    it('messageStore.load returns io_error → emit _skipped ac4_skip without mismatch', async () => {
      const audit = makeMockAudit();
      const messageStore = makeMockMessageStore({ loadIoError: 'EACCES' });
      await auditSubagentArtifactCompleteness(
        makeSnapshot({ textEndCount: 1 }),
        { fs: {} as any, messageStore },
        audit as any,
      );
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0]).toBe(SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED);
      expect(audit.write.mock.calls[0]).toContain('kind=ac4_skip');
      expect(audit.write.mock.calls[0]).toContain('reason=message_load_io_error');
    });
  });
});
