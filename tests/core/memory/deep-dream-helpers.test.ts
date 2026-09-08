/**
 * phase 1467 — memory-system test cov 补强 (F9 from audit-2026-05-30)
 *
 * 覆盖 deep-dream.ts 6 个 internal pure helper:
 * - extractText / responseText / serializeSession / estimateTokens (pure)
 * - loadDreamState / saveDreamState (FS + audit)
 *
 * scope 严守：仅 helper unit tests / 不动 runDeepDream public API surface
 */
import { describe, it, expect, vi } from 'vitest';
import {
  __test_extractText,
  __test_responseText,
  __test_serializeSession,
  __test_estimateTokens,
  __test_loadDreamState,
  __test_saveDreamState,
  __test_DEEP_DREAM_STATE_FILE,
  type __test_DreamStateData,
} from '../../../src/core/memory/deep-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { ContentBlock } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';

const clawId = 'test-claw';
const defaultState = {
  schema_version: 2,
  lastProcessedDeepDreamAt: 0,
  currentSessionDreamedDate: '',
  currentSessionRetryCount: 0,
  pendingNotifications: [],
};

describe('deep-dream pure helpers (phase 1467)', () => {
  describe('estimateTokens', () => {
    it('empty string returns 0', () => {
      expect(__test_estimateTokens('')).toBe(0);
    });

    it('ASCII text (cl100k_base encoding)', () => {
      expect(__test_estimateTokens('a')).toBe(1);
      expect(__test_estimateTokens('abcd')).toBe(1);
      expect(__test_estimateTokens('abcde')).toBe(2);
      expect(__test_estimateTokens('abcdefgh')).toBe(1); // common pattern = 1 token in cl100k_base
    });

    it('long text scales (cl100k_base)', () => {
      // diverse prose (pangram repeat) 避 repeated single-char BPE pathological case
      // (phase 181 follow-up: phase 184 fix js-tiktoken cl100k_base repeated-char encode timeout)
      const long = 'The quick brown fox jumps over the lazy dog. '.repeat(90); // ~4050 chars
      const tokens = __test_estimateTokens(long);
      expect(tokens).toBeGreaterThan(500); // 一定大于 short baseline
      expect(tokens).toBeLessThan(2000); // diverse prose ~ chars/3 to chars/2
    });

    it('CJK text (cl100k_base)', () => {
      const cn = '你好';
      expect(__test_estimateTokens(cn)).toBe(2);       // 2 chars → 2 tokens
      const cnLong = '你好世界'.repeat(100);            // 400 chars
      expect(__test_estimateTokens(cnLong)).toBe(500); // ~1.25 tokens per char in cl100k_base
    });
  });

  describe('extractText', () => {
    it('string content returns as-is', () => {
      expect(__test_extractText('hello world')).toBe('hello world');
    });

    it('ContentBlock[] filters text blocks and joins', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ];
      expect(__test_extractText(blocks)).toBe('hello world');
    });

    it('ContentBlock[] mixed types filters non-text', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'visible' },
        { type: 'tool_use', id: 'id1', name: 'tool', input: {} },
        { type: 'text', text: '-after' },
      ];
      expect(__test_extractText(blocks)).toBe('visible-after');
    });

    it('empty ContentBlock[] returns empty string', () => {
      expect(__test_extractText([])).toBe('');
    });
  });

  describe('responseText', () => {
    it('extracts text from LLMResponse content', () => {
      const res = {
        content: [{ type: 'text', text: 'reply' }] as ContentBlock[],
      };
      expect(__test_responseText(res as any)).toBe('reply');
    });

    it('returns empty string when no text blocks', () => {
      const res = {
        content: [{ type: 'tool_use', id: 'id1', name: 'tool', input: {} }] as ContentBlock[],
      };
      expect(__test_responseText(res as any)).toBe('');
    });
  });

  describe('serializeSession', () => {
    it('skips system messages and formats user/assistant', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi back' },
      ];
      const out = __test_serializeSession(messages);
      expect(out).toContain('[User] hello');
      expect(out).toContain('[Assistant] hi back');
      expect(out).not.toContain('system prompt');
    });

    it('skips empty content after trim', () => {
      const messages: Message[] = [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '   ' },   // whitespace only
        { role: 'user', content: 'y' },
      ];
      const out = __test_serializeSession(messages);
      expect(out).toContain('[User] x');
      expect(out).toContain('[User] y');
      // empty assistant skipped
      expect(out.match(/\[Assistant\]/g) ?? []).toHaveLength(0);
    });

    it('joins multiple with double newline', () => {
      const messages: Message[] = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ];
      expect(__test_serializeSession(messages)).toBe('[User] a\n\n[Assistant] b');
    });

    it('empty messages returns empty string', () => {
      expect(__test_serializeSession([])).toBe('');
    });
  });

  describe('DEEP_DREAM_STATE_FILE constant', () => {
    it('matches the contract filename', () => {
      expect(__test_DEEP_DREAM_STATE_FILE).toBe('.deep-dream-state.json');
    });
  });

  describe('loadDreamState', () => {
    function makeMockFs(readImpl: (file: string) => string): FileSystem {
      return { readSync: vi.fn(readImpl) } as any;
    }

    it('FileNotFoundError returns ready default state (no audit)', () => {
      const fs = makeMockFs(() => {
        throw new FileNotFoundError('.deep-dream-state.json');
      });
      const audit = makeMockAudit();

      const result = __test_loadDreamState(fs, audit, clawId);
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') throw new Error('expected ready');
      expect(result.state).toEqual(defaultState);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('valid JSON returns ready parsed state', () => {
      const stored: __test_DreamStateData = {
        lastProcessedDeepDreamAt: 1717000000000,
        currentSessionDreamedDate: '2026-05-30',
      };
      const fs = makeMockFs(() => JSON.stringify(stored));
      const audit = makeMockAudit();

      const result = __test_loadDreamState(fs, audit, clawId);
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') throw new Error('expected ready');
      expect(result.state).toEqual({
        schema_version: 2,
        lastProcessedDeepDreamAt: 1717000000000,
        currentSessionDreamedDate: '2026-05-30',
        pendingNotifications: [],
      });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('future schema_version returns blocked result', () => {
      const fs = makeMockFs(() => JSON.stringify({
        schema_version: 99,
        lastProcessedDeepDreamAt: 12345,
        currentSessionDreamedDate: '2026-01-01',
      }));
      const audit = makeMockAudit();

      const result = __test_loadDreamState(fs, audit, clawId);
      expect(result.status).toBe('blocked');
      if (result.status !== 'blocked') throw new Error('expected blocked');
      expect(result.reason).toBe('future_schema');
      expect(result.version).toBe(99);
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DREAM_STATE_FUTURE_VERSION);
      expect(call).toEqual(expect.arrayContaining([
        expect.stringMatching(/^version=99$/),
        expect.stringMatching(/^current=2$/),
        expect.stringMatching(/^clawId=test-claw$/),
        expect.stringMatching(/^reason=cannot_migrate_future_version$/),
      ]));
      // No write occurred — future-version file is preserved on disk.
      expect(fs.writeAtomicSync).toBeUndefined();
    });

    it('corrupt JSON → degraded malformed + quarantine 保留 raw（phase 1810，不再隐式 default）', () => {
      const moves: Array<[string, string]> = [];
      const fs = {
        readSync: vi.fn(() => '{ corrupt'),
        existsSync: vi.fn(() => false),
        moveSync: vi.fn((from: string, to: string) => { moves.push([from, to]); }),
        writeAtomicSync: vi.fn(() => {}),
      } as unknown as FileSystem;
      const audit = makeMockAudit();

      const result = __test_loadDreamState(fs, audit, clawId);
      expect(result.status).toBe('degraded');
      if (result.status !== 'degraded') throw new Error('expected degraded');
      expect(result.degraded.cause).toBe('malformed');
      // 原子 quarantine：canonical → 唯一后缀，raw 原文保留
      expect(moves).toEqual([['.deep-dream-state.json', '.deep-dream-state.json.corrupt-1']]);
      if (result.degraded.cause !== 'malformed') throw new Error('expected malformed');
      expect(result.degraded.quarantine).toEqual({
        kind: 'quarantined',
        path: '.deep-dream-state.json.corrupt-1',
      });
      // 本轮 run 不得 save 覆盖（load 阶段无 canonical 写入）
      expect(fs.writeAtomicSync).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
      expect(call).toEqual(expect.arrayContaining([
        expect.stringMatching(/^step=load_state$/),
        expect.stringContaining(`clawId=${clawId}`),
        expect.stringMatching(/^cause=malformed$/),
        expect.stringMatching(/^quarantine=\.deep-dream-state\.json\.corrupt-1$/),
      ]));
    });

    it('non-ENOENT IO error (EACCES) → degraded unavailable，不 quarantine 不写文件（phase 1810）', () => {
      const fs = {
        readSync: vi.fn(() => { throw new Error('EACCES: permission denied'); }),
        existsSync: vi.fn(() => false),
        moveSync: vi.fn(),
        writeAtomicSync: vi.fn(() => {}),
      } as unknown as FileSystem;
      const audit = makeMockAudit();

      const result = __test_loadDreamState(fs, audit, clawId);
      expect(result.status).toBe('degraded');
      if (result.status !== 'degraded') throw new Error('expected degraded');
      expect(result.degraded).toEqual({
        cause: 'unavailable',
        error: 'EACCES: permission denied',
      });
      // unavailable 不触碰文件（不 quarantine、不 save）
      expect(fs.moveSync).not.toHaveBeenCalled();
      expect(fs.writeAtomicSync).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
      expect(call).toEqual(expect.arrayContaining([
        expect.stringMatching(/^step=load_state$/),
        expect.stringMatching(/^cause=unavailable$/),
        expect.stringContaining('EACCES'),
      ]));
    });
  });

  describe('saveDreamState', () => {
    function makeMockFsForWrite(writeImpl?: (file: string, content: string) => void): FileSystem {
      return { writeAtomicSync: vi.fn(writeImpl ?? (() => {})) } as any;
    }

    it('writes JSON to DEEP_DREAM_STATE_FILE on success (no audit)', () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        lastProcessedDeepDreamAt: 1717000000000,
        currentSessionDreamedDate: '2026-05-30',
      };
      __test_saveDreamState(fs, state, audit, clawId);

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe('.deep-dream-state.json');
      // phase 547 / phase 1162 Step B: save 写入总带 schema_version 2
      expect(JSON.parse(writes[0][1])).toEqual({ schema_version: 2, ...state });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('write failure emits DEEP_DREAM_ERROR audit + returns false + does NOT re-throw (F36 resilient)', () => {
      const fs = makeMockFsForWrite(() => { throw new Error('ENOSPC: no space'); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        lastProcessedDeepDreamAt: 0,
        currentSessionDreamedDate: '',
      };
      expect(__test_saveDreamState(fs, state, audit, clawId)).toBe(false);
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
      expect(call).toEqual(expect.arrayContaining([
        expect.stringMatching(/^step=save_state$/),
        expect.stringContaining(`clawId=${clawId}`),
      ]));
      expect(call.some((s: unknown) => typeof s === 'string' && s.includes('ENOSPC'))).toBe(true);
    });
  });
});
