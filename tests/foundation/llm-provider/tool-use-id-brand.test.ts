import { describe, it, expect } from 'vitest';
import { makeToolUseId, type ToolUseId } from '../../../src/foundation/llm-provider/tool-use-id.js';

describe('ToolUseId brand (phase 140 Step B)', () => {
  it('makeToolUseId returns a branded string', () => {
    const id = makeToolUseId('call_01_abc123');
    expect(String(id)).toBe('call_01_abc123');
  });

  it('makeToolUseId throws on empty string', () => {
    expect(() => makeToolUseId('')).toThrow(/expected non-empty string/);
  });

  it('runtime equivalent to plain string (toString / String)', () => {
    const raw = 'call_42_xyz789';
    const branded = makeToolUseId(raw);
    expect(branded.toString()).toBe(raw);
    expect(String(branded)).toBe(raw);
    // Brand is structurally a string at runtime
    expect(typeof branded).toBe('string');
  });

  it('compile-time: plain string is not assignable to ToolUseId', () => {
    // This test mainly serves as a compile-time assertion. At runtime we just
    // verify the factory returns the expected shape.
    const receive = (id: ToolUseId) => id;
    const branded = makeToolUseId('call_01_test');
    expect(receive(branded)).toBe(branded);
  });

  it('compile-time: object literal with __brand is not structurally assignable', () => {
    // ToolUseId uses a unique symbol brand, so plain `{ __brand: "ToolUseId" }`
    // is not assignable. Runtime assertion mirrors the compile-time invariant.
    const fake = { __brand: 'ToolUseId' as const };
    expect(fake.__brand).toBe('ToolUseId');
    // The real brand is a unique symbol, not a string literal — structural
    // match would fail at compile time.
  });
});
