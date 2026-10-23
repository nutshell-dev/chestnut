import { describe, it, expect } from 'vitest';
import { resolveContextWindow } from '../../../src/foundation/llm-provider/model-context-windows.js';

/**
 * Phase 1925 Step C 签名变更：resolveContextWindow(providerId, modelName)。
 * 优先级：exact (pi-ai provider, model) 目录命中 → preset piAiProvider 别名命中
 * → 启发式（默认 256K + 子串特判 1M）。明确不做 id-only 兜底（G3）。
 */
describe('resolveContextWindow (phase 684 + Phase 1925 Step C)', () => {
  describe('目录命中（exact (provider, model) 优先于启发式）', () => {
    it('pi-ai provider id 直接命中取目录值', () => {
      // pi-ai 1.4.0：anthropic claude-sonnet-4-5 目录值由 1M 修正为 200K
      // （目录 200K ≠ 启发式 1M（claude 子串）→ 仍证明目录优先）
      expect(resolveContextWindow('anthropic', 'claude-sonnet-4-5')).toBe(200_000);
      // 目录值与启发式 1M 不同 → 证明目录优先（gemini-2.5-pro 目录 1048576）
      expect(resolveContextWindow('google', 'gemini-2.5-pro')).toBe(1_048_576);
      expect(resolveContextWindow('deepseek', 'deepseek-v4-pro')).toBe(1_000_000);
    });

    it('chestnut preset id 经 piAiProvider/catalogProvider 别名命中', () => {
      // Phase 1975：preset kimi 已移除 piAiProvider，改经 catalogProvider（kimi-coding）
      // 别名命中；k3-256k 目录值 262144（启发式不会产出）
      expect(resolveContextWindow('kimi', 'k3-256k')).toBe(262_144);
      expect(resolveContextWindow('gemini', 'gemini-2.5-pro')).toBe(1_048_576);
    });

    it('目录命中覆盖启发式子串特判（claude 子串但目录值非 1M）', () => {
      // amazon-bedrock 的 claude-haiku 目录 200K；含 'claude' 子串但目录优先
      expect(resolveContextWindow('amazon-bedrock', 'anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(200_000);
    });
  });

  describe('启发式回退（provider undefined / 目录未命中）', () => {
    it('returns default 256K for undefined model', () => {
      expect(resolveContextWindow(undefined, undefined)).toBe(256_000);
      expect(resolveContextWindow('openai', undefined)).toBe(256_000);
    });

    it('returns default 256K for model without million-token substring', () => {
      expect(resolveContextWindow(undefined, 'gpt-4o-custom-ft')).toBe(256_000);
      expect(resolveContextWindow(undefined, 'grok-4')).toBe(256_000);
      expect(resolveContextWindow(undefined, 'llama3.1')).toBe(256_000);
      expect(resolveContextWindow(undefined, 'qwen-coder-plus-latest')).toBe(256_000);
    });

    it('returns 1M for claude substring', () => {
      expect(resolveContextWindow(undefined, 'claude-sonnet-4-5')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'anthropic/claude-opus-4-7')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'claude-3-7-sonnet-20250219')).toBe(1_000_000);
    });

    it('returns 1M for gemini substring', () => {
      expect(resolveContextWindow(undefined, 'gemini-2.5-pro-preview-03-25')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'google/gemini-2.0-flash')).toBe(1_000_000);
    });

    it('returns 1M for deepseek-v4 substring, default for other deepseek versions', () => {
      expect(resolveContextWindow(undefined, 'deepseek-v4')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'deepseek-v4-chat')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'deepseek-chat')).toBe(256_000);
      expect(resolveContextWindow(undefined, 'deepseek-v3')).toBe(256_000);
    });

    it('returns 1M for glm-5 substring, default for glm-4.x', () => {
      expect(resolveContextWindow(undefined, 'glm-5')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'glm-5-chat')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'glm-4.6')).toBe(256_000);
    });

    it('returns 1M for MiniMax-M3 (case-sensitive), default for M1/M2', () => {
      expect(resolveContextWindow(undefined, 'MiniMax-M3')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'MiniMax-M3-chat')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'MiniMax-M1')).toBe(256_000);
      expect(resolveContextWindow(undefined, 'MiniMax-M2')).toBe(256_000);
    });

    it('is case-sensitive (does not match lowercase minimax-m3)', () => {
      expect(resolveContextWindow(undefined, 'minimax-m3')).toBe(256_000);
    });

    it('returns 1M when multiple million-token substrings present', () => {
      expect(resolveContextWindow(undefined, 'hypothetical-claude-glm-5')).toBe(1_000_000);
    });

    it('provider 已知但 model 不在目录 → 启发式（不做 id-only 兜底）', () => {
      // G3：同 model id 不同 provider 限额可差 3.9×，宁走保守启发式
      expect(resolveContextWindow('anthropic', 'claude-future-unknown-model')).toBe(1_000_000);
      expect(resolveContextWindow('openai', 'gpt-99-unknown')).toBe(256_000);
    });

    it('provider 无 piAiProvider 映射（custom-*）→ 启发式', () => {
      expect(resolveContextWindow('custom-openai', 'claude-via-gateway')).toBe(1_000_000);
      expect(resolveContextWindow('ollama', 'llama3.1')).toBe(256_000);
    });
  });
});
