import { describe, it, expect } from 'vitest';
import { resolveContextWindow } from '../../../src/foundation/llm-provider/model-context-windows.js';
import { MODEL_CATALOG } from '../../../src/foundation/llm-provider/model-catalog.generated.js';

/**
 * Phase 1925 Step C 签名变更：resolveContextWindow(providerId, modelName)。
 *
 * Phase 1977 用户改判：context window **模型优先**——model id 在目录中唯一时
 * 直接使用（不依赖 provider/preset label）；同名多值由 provider/preset 精确
 * 消歧，仍无法消歧取保守最小值；目录未命中保留启发式。
 * （Phase 1925 G3「不做 id-only 兜底」由 Phase 1977 显式覆盖。）
 */
describe('resolveContextWindow (phase 684 + Phase 1925 Step C + Phase 1977)', () => {
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

  describe('Phase 1977 模型优先（唯一目录值不依赖 provider label）', () => {
    it('custom label + k3-256k → 262144', () => {
      expect(resolveContextWindow('custom-anthropic', 'k3-256k')).toBe(262_144);
      expect(resolveContextWindow('kimi-year', 'k3-256k')).toBe(262_144);
      expect(resolveContextWindow('kimi-year2', 'k3-256k')).toBe(262_144);
      expect(resolveContextWindow(undefined, 'k3-256k')).toBe(262_144);
    });

    it('claude-sonnet-4-5 在目录中唯一 → 模型值优先于 claude 子串启发式', () => {
      expect(resolveContextWindow(undefined, 'claude-sonnet-4-5')).toBe(200_000);
      expect(resolveContextWindow('custom-openai', 'claude-sonnet-4-5')).toBe(200_000);
    });

    it('k3-256k 在目录中只有唯一 contextWindow（数据完整性）', () => {
      const windows = new Set<number>();
      for (const [key, entry] of Object.entries(MODEL_CATALOG)) {
        if (key.slice(key.indexOf('/') + 1) === 'k3-256k') windows.add(entry.contextWindow);
      }
      expect([...windows]).toEqual([262_144]);
    });
  });

  describe('Phase 1977 同名多值消歧', () => {
    it('provider 精确命中取精确值（不取 min）', () => {
      expect(resolveContextWindow('openai', 'gpt-5')).toBe(400_000);
      expect(resolveContextWindow('cloudflare-ai-gateway', 'gpt-5')).toBe(128_000);
    });

    it('preset 别名命中取精确值（qwen → qwen-token-plan）', () => {
      expect(resolveContextWindow('qwen', 'qwen3.8-max')).toBe(1_000_000);
    });

    it('无法消歧 → 保守最小值', () => {
      expect(resolveContextWindow(undefined, 'gpt-5')).toBe(128_000);
      expect(resolveContextWindow('custom-anthropic', 'gpt-5')).toBe(128_000);
      expect(resolveContextWindow(undefined, 'glm-5')).toBe(202_752);
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

    it('returns 1M for claude substring（目录未命中的 model）', () => {
      // 'anthropic/claude-opus-4-7' 以 model id 整体含 '/' → 索引未命中 → 启发式
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

    it('glm-5 目录多值取 min；glm-5-chat 目录未命中走 1M 子串', () => {
      expect(resolveContextWindow(undefined, 'glm-5')).toBe(202_752);
      expect(resolveContextWindow(undefined, 'glm-5-chat')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'glm-4.6')).toBe(256_000);
    });

    it('returns 1M for MiniMax-M3 (case-sensitive), default for M1/M2', () => {
      expect(resolveContextWindow(undefined, 'MiniMax-M3')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'MiniMax-M3-chat')).toBe(1_000_000);
      expect(resolveContextWindow(undefined, 'MiniMax-M1')).toBe(256_000);
      expect(resolveContextWindow(undefined, 'MiniMax-M2')).toBe(256_000);
    });

    it('heuristic is case-sensitive (lowercase minimax-m3-* not matched by MiniMax-M3)', () => {
      // 注：裸 'minimax-m3' 是目录内 model id（多值 → min），不走启发式；
      // 此处用目录外变体验证启发式子串大小写敏感。
      expect(resolveContextWindow(undefined, 'minimax-m3-custom')).toBe(256_000);
    });

    it('returns 1M when multiple million-token substrings present', () => {
      expect(resolveContextWindow(undefined, 'hypothetical-claude-glm-5')).toBe(1_000_000);
    });

    it('provider 已知但 model 不在目录 → 启发式（目录未命中兜底）', () => {
      // Phase 1977：唯一目录值优先与多值 min 只作用于目录内 model；
      // 目录外 model 仍按 1M 子串/默认 256K 启发式。
      expect(resolveContextWindow('anthropic', 'claude-future-unknown-model')).toBe(1_000_000);
      expect(resolveContextWindow('openai', 'gpt-99-unknown')).toBe(256_000);
    });

    it('provider 无 piAiProvider 映射（custom-*）→ 启发式', () => {
      expect(resolveContextWindow('custom-openai', 'claude-via-gateway')).toBe(1_000_000);
      expect(resolveContextWindow('ollama', 'llama3.1')).toBe(256_000);
    });
  });
});
