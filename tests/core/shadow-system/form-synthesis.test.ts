/**
 * shadow-system Form B synthesis tests (phase 767, phase 770 删 Form A)
 */

import { describe, it, expect } from 'vitest';
import { synthesizeFormB } from '../../../src/core/shadow-system/_helpers.js';
import { SHADOW_INSTRUCTION_PREFIX } from '../../../src/templates/prompts/shadow.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

describe('shadow form synthesis', () => {
  const baseInstructionArgs = {
    shadowId: 'shadow-abc123',
    spawnedAt: '2024-01-01T00:00:00Z',
    spawnedByClawId: 'main-claw',
    toolUseId: 'tu-xyz789',
    task: 'Compute 1+1',
  } as const;

  describe('synthesizeFormB', () => {
    it('appends fresh user message with instruction', () => {
      const mainMessagesBeforeMarker: Message[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ];

      const result = synthesizeFormB({
        mainMessagesBeforeMarker,
        instructionArgs: { ...baseInstructionArgs },
      });

      expect(result).toHaveLength(mainMessagesBeforeMarker.length + 1);
      const instructionMsg = result[mainMessagesBeforeMarker.length];
      expect(instructionMsg.role).toBe('user');
      expect(typeof instructionMsg.content).toBe('string');
      expect(instructionMsg.content).toContain(SHADOW_INSTRUCTION_PREFIX);
      expect(instructionMsg.content).toContain('shadow_id: shadow-abc123');
      expect(instructionMsg.content).toContain('Compute 1+1');
    });

    it('does not include marker assistant', () => {
      const mainMessagesBeforeMarker: Message[] = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ];

      const result = synthesizeFormB({
        mainMessagesBeforeMarker,
        instructionArgs: { ...baseInstructionArgs },
      });

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(mainMessagesBeforeMarker[0]);
      expect(result[1]).toEqual(mainMessagesBeforeMarker[1]);
    });

    it('main messages prefix 不变（cache invariant）', () => {
      const main: Message[] = [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ];
      const result = synthesizeFormB({
        mainMessagesBeforeMarker: main,
        instructionArgs: { ...baseInstructionArgs, shadowId: 'test' },
      });
      expect(result.slice(0, 2)).toEqual(main); // prefix bit-identical
    });
  });
});
