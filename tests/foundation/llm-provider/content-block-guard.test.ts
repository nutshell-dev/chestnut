import { describe, it, expect } from 'vitest';
import { assertContentBlocks } from '../../../src/foundation/llm-provider/_block-guards.js';

describe('assertContentBlocks (phase 980 D fork)', () => {
  it('passes for valid ContentBlock[]', () => {
    const valid = [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 't1', name: 'read', input: {} },
    ];
    expect(() => assertContentBlocks(valid)).not.toThrow();
  });

  it('throws for non-array', () => {
    expect(() => assertContentBlocks('not array')).toThrow(TypeError);
    expect(() => assertContentBlocks(null)).toThrow(TypeError);
    expect(() => assertContentBlocks({})).toThrow(TypeError);
  });

  it('throws for array with missing .type', () => {
    expect(() => assertContentBlocks([{ text: 'no type' }])).toThrow(TypeError);
  });

  it('throws for array with non-string .type', () => {
    expect(() => assertContentBlocks([{ type: 42 }])).toThrow(TypeError);
  });
});
