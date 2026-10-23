/**
 * @module L1.LLMProvider.ThinkingLevels
 *
 * Phase 1979: thinking/reasoning effort 全档（pi-ai ThinkingLevel 单源）。
 * 独立叶子模块，避免 `types.ts ↔ presets.ts` 循环依赖（presets 需要该类型）。
 * preset 默认 max；实际档位由 pi-ai 按模型能力 clamp。
 */

export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
