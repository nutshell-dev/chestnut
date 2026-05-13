/**
 * shadow-system Form A + Form B synthesis tests (phase 767)
 */

import { describe, it, expect } from 'vitest';
import { synthesizeFormA, synthesizeFormB } from '../../../src/core/shadow-system/_helpers.js';
import { SHADOW_INSTRUCTION_PREFIX } from '../../../src/prompts/shadow.js';
import type { Message } from '../../../src/types/message.js';

describe('shadow form synthesis', () => {
  const baseInstructionArgs = {
    shadowId: 'shadow-abc123',
    spawnedAt: '2024-01-01T00:00:00Z',
    spawnedByClawId: 'main-claw',
    toolUseId: 'tu-xyz789',
    task: 'Compute 1+1',
  } as const;

  describe('synthesizeFormA', () => {
    it('appends synthetic user tool_result with instruction', () => {
      const mainMessages: Message[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-xyz789', name: 'shadow', input: { task: 'Compute 1+1', form: 'A' } }] },
      ];

      const result = synthesizeFormA({
        mainMessages,
        toolUseId: 'tu-xyz789',
        instructionArgs: { ...baseInstructionArgs, form: 'A' },
      });

      expect(result).toHaveLength(mainMessages.length + 1);
      const last = result[result.length - 1];
      expect(last.role).toBe('user');
      expect(Array.isArray(last.content)).toBe(true);
      const blocks = last.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
      expect(blocks[0].type).toBe('tool_result');
      expect(blocks[0].tool_use_id).toBe('tu-xyz789');
      expect(blocks[0].content).toContain(SHADOW_INSTRUCTION_PREFIX);
      expect(blocks[0].content).toContain('form: A');
      expect(blocks[0].content).toContain('Compute 1+1');
    });

    it('preserves all main messages including marker', () => {
      const mainMessages: Message[] = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-xyz789', name: 'shadow', input: {} }] },
      ];

      const result = synthesizeFormA({ mainMessages, toolUseId: 'tu-xyz789', instructionArgs: { ...baseInstructionArgs, form: 'A' } });

      expect(result.slice(0, mainMessages.length)).toEqual(mainMessages);
    });
  });

  describe('synthesizeFormB', () => {
    it('appends fresh user message with instruction', () => {
      const mainMessagesBeforeMarker: Message[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ];

      const result = synthesizeFormB({
        mainMessagesBeforeMarker,
        instructionArgs: { ...baseInstructionArgs, form: 'B' },
      });

      expect(result).toHaveLength(mainMessagesBeforeMarker.length + 1);
      const last = result[result.length - 1];
      expect(last.role).toBe('user');
      expect(typeof last.content).toBe('string');
      expect(last.content).toContain(SHADOW_INSTRUCTION_PREFIX);
      expect(last.content).toContain('form: B');
      expect(last.content).toContain('Compute 1+1');
    });

    it('does not include marker assistant', () => {
      const mainMessagesBeforeMarker: Message[] = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ];

      const result = synthesizeFormB({
        mainMessagesBeforeMarker,
        instructionArgs: { ...baseInstructionArgs, form: 'B' },
      });

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(mainMessagesBeforeMarker[0]);
      expect(result[1]).toEqual(mainMessagesBeforeMarker[1]);
    });
  });
});
