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
import { makeClawId } from '../../../src/foundation/identity/index.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { Message, ContentBlock } from '../../../src/foundation/llm-provider/types.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';

const clawId = makeClawId('test-claw');

describe('deep-dream pure helpers (phase 1467)', () => {
  describe('estimateTokens', () => {
    it('empty string returns 0', () => {
      expect(__test_estimateTokens('')).toBe(0);
    });

    it('ASCII text ~chars/4 ceil', () => {
      expect(__test_estimateTokens('a')).toBe(1);        // ceil(1/4) = 1
      expect(__test_estimateTokens('abcd')).toBe(1);     // ceil(4/4) = 1
      expect(__test_estimateTokens('abcde')).toBe(2);    // ceil(5/4) = 2
      expect(__test_estimateTokens('abcdefgh')).toBe(2); // ceil(8/4) = 2
    });

    it('long text scales', () => {
      const long = 'x'.repeat(4000);
      expect(__test_estimateTokens(long)).toBe(1000);
    });

    it('multibyte chars counted by .length (JS UTF-16 code units)', () => {
      // 中文 1 char ≈ 1 UTF-16 unit
      const cn = '你好';                                    // 2 chars
      expect(__test_estimateTokens(cn)).toBe(1);          // ceil(2/4) = 1
      const cnLong = '你好世界'.repeat(100);                // 400 chars
      expect(__test_estimateTokens(cnLong)).toBe(100);    // ceil(400/4) = 100
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(__test_responseText(res as any)).toBe('reply');
    });

    it('returns empty string when no text blocks', () => {
      const res = {
        content: [{ type: 'tool_use', id: 'id1', name: 'tool', input: {} }] as ContentBlock[],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { readSync: vi.fn(readImpl) } as any;
    }

    it('FileNotFoundError returns silent default state (no audit)', () => {
      const fs = makeMockFs(() => {
        throw new FileNotFoundError('.deep-dream-state.json');
      });
      const audit = makeMockAudit();

      const state = __test_loadDreamState(fs, audit, clawId);
      expect(state).toEqual({ processedArchives: [], currentSessionDreamedDate: '' });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('valid JSON returns parsed state', () => {
      const stored: __test_DreamStateData = {
        processedArchives: ['a.json', 'b.json'],
        currentSessionDreamedDate: '2026-05-30',
      };
      const fs = makeMockFs(() => JSON.stringify(stored));
      const audit = makeMockAudit();

      const state = __test_loadDreamState(fs, audit, clawId);
      expect(state).toEqual(stored);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('corrupt JSON emits DEEP_DREAM_ERROR audit + returns default', () => {
      const fs = makeMockFs(() => '{ corrupt');
      const audit = makeMockAudit();

      const state = __test_loadDreamState(fs, audit, clawId);
      expect(state).toEqual({ processedArchives: [], currentSessionDreamedDate: '' });
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
      expect(call).toEqual(expect.arrayContaining([
        expect.stringMatching(/^step=load_state$/),
        expect.stringContaining(`clawId=${clawId}`),
      ]));
    });

    it('non-ENOENT IO error (EACCES) emits audit + returns default', () => {
      const fs = makeMockFs(() => {
        throw new Error('EACCES: permission denied');
      });
      const audit = makeMockAudit();

      const state = __test_loadDreamState(fs, audit, clawId);
      expect(state).toEqual({ processedArchives: [], currentSessionDreamedDate: '' });
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
      expect(call.some((s: unknown) => typeof s === 'string' && s.includes('EACCES'))).toBe(true);
    });
  });

  describe('saveDreamState', () => {
    function makeMockFsForWrite(writeImpl?: (file: string, content: string) => void): FileSystem {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { writeAtomicSync: vi.fn(writeImpl ?? (() => {})) } as any;
    }

    it('writes JSON to DEEP_DREAM_STATE_FILE on success (no audit)', () => {
      const writes: Array<[string, string]> = [];
      const fs = makeMockFsForWrite((file, content) => { writes.push([file, content]); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        processedArchives: ['x.json'],
        currentSessionDreamedDate: '2026-05-30',
      };
      __test_saveDreamState(fs, state, audit, clawId);

      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe('.deep-dream-state.json');
      expect(JSON.parse(writes[0][1])).toEqual(state);
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('write failure emits DEEP_DREAM_ERROR audit + does NOT re-throw (F36 resilient)', () => {
      const fs = makeMockFsForWrite(() => { throw new Error('ENOSPC: no space'); });
      const audit = makeMockAudit();

      const state: __test_DreamStateData = {
        processedArchives: [],
        currentSessionDreamedDate: '',
      };
      expect(() => __test_saveDreamState(fs, state, audit, clawId)).not.toThrow();
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
