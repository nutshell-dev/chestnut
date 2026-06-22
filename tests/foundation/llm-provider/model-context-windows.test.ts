import { describe, it, expect } from 'vitest';
import {
  resolveContextWindow,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from '../../../src/foundation/llm-provider/model-context-windows.js';

describe('resolveContextWindow (phase 684)', () => {
  it('returns default 256K for undefined model', () => {
    expect(resolveContextWindow(undefined)).toBe(256_000);
    expect(DEFAULT_MODEL_CONTEXT_WINDOW).toBe(256_000);
  });

  it('returns default 256K for model without million-token substring', () => {
    expect(resolveContextWindow('gpt-4o')).toBe(256_000);
    expect(resolveContextWindow('grok-4')).toBe(256_000);
    expect(resolveContextWindow('llama3.1')).toBe(256_000);
    expect(resolveContextWindow('qwen-coder-plus-latest')).toBe(256_000);
  });

  it('returns 1M for claude substring', () => {
    expect(resolveContextWindow('claude-sonnet-4-5')).toBe(1_000_000);
    expect(resolveContextWindow('anthropic/claude-opus-4-7')).toBe(1_000_000);
    expect(resolveContextWindow('claude-3-7-sonnet-20250219')).toBe(1_000_000);
  });

  it('returns 1M for gemini substring', () => {
    expect(resolveContextWindow('gemini-2.5-pro-preview-03-25')).toBe(1_000_000);
    expect(resolveContextWindow('google/gemini-2.0-flash')).toBe(1_000_000);
  });

  it('returns 1M for deepseek-v4 substring, default for other deepseek versions', () => {
    expect(resolveContextWindow('deepseek-v4')).toBe(1_000_000);
    expect(resolveContextWindow('deepseek-v4-chat')).toBe(1_000_000);
    expect(resolveContextWindow('deepseek-chat')).toBe(256_000);
    expect(resolveContextWindow('deepseek-v3')).toBe(256_000);
  });

  it('returns 1M for glm-5 substring, default for glm-4.x', () => {
    expect(resolveContextWindow('glm-5')).toBe(1_000_000);
    expect(resolveContextWindow('glm-5-chat')).toBe(1_000_000);
    expect(resolveContextWindow('glm-4.6')).toBe(256_000);
  });

  it('returns 1M for MiniMax-M3 (case-sensitive), default for M1/M2', () => {
    expect(resolveContextWindow('MiniMax-M3')).toBe(1_000_000);
    expect(resolveContextWindow('MiniMax-M3-chat')).toBe(1_000_000);
    expect(resolveContextWindow('MiniMax-M1')).toBe(256_000);
    expect(resolveContextWindow('MiniMax-M2')).toBe(256_000);
  });

  it('is case-sensitive (does not match lowercase minimax-m3)', () => {
    expect(resolveContextWindow('minimax-m3')).toBe(256_000);
  });

  it('returns 1M when multiple million-token substrings present', () => {
    expect(resolveContextWindow('hypothetical-claude-glm-5')).toBe(1_000_000);
  });
});
