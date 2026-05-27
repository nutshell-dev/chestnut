import { describe, it, expect } from 'vitest';
import { buildMinerSystemPrompt } from '../../src/prompts/mining.js';

describe('mining prompt: no `dispatch` literal (phase 1183 F.9)', () => {
  it('mining prompt 0 occurrences of `dispatch` literal', () => {
    const prompt = buildMinerSystemPrompt();
    expect(prompt).not.toContain('`dispatch`');
    expect(prompt).not.toContain('通过 dispatch');
    expect(prompt).toContain('`summon`');  // positive assertion
  });
});
