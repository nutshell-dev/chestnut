/**
 * @module L1.LLMProvider.ThinkingDefaults
 *
 * Phase 1979: preset 自带的 thinking/effort 默认 → snake_case 配置字段。
 *
 * preset = 完整参数包：用户配置未显式给出任何 thinking 字段时，由
 * config-adapter 用本 helper 填充 resolved config；不写入 YAML、不做存量迁移。
 * catalog 明确 `reasoning: false` 的模型不应用默认（如 openai/gpt-4o）；
 * catalog 缺失时信任 preset（不做模型名启发式）。
 */

import { MODEL_CATALOG } from './model-catalog.generated.js';
import { resolvePreset, type ProviderPreset } from './presets.js';
import type { ThinkingLevel } from './thinking-levels.js';

/** `resolveThinkingDefaults` 的 snake_case 输出（与 YAML 字段同名，便于填充）。 */
export interface ResolvedThinkingDefaults {
  thinking?: boolean;
  thinking_mode?: 'adaptive' | 'enabled';
  thinking_effort?: ThinkingLevel;
  reasoning_effort?: ThinkingLevel;
  thinking_budget_tokens?: number;
  drop_thinking_blocks?: boolean;
}

/**
 * catalog 是否明确该模型不支持 reasoning。
 * - metadata-only preset 以固定 catalogModel 判定（用户改 wire model 时信任 preset）；
 * - 直连 preset 以 piAiProvider + resolvedModel 判定；
 * - 无 catalog 映射或条目缺失 → false（信任 preset）。
 */
function isKnownNonReasoning(preset: ProviderPreset, resolvedModel: string): boolean {
  const key = preset.catalogProvider && preset.catalogModel
    ? `${preset.catalogProvider}/${preset.catalogModel}`
    : preset.piAiProvider
      ? `${preset.piAiProvider}/${resolvedModel}`
      : undefined;
  if (!key) return false;
  return MODEL_CATALOG[key]?.reasoning === false;
}

/**
 * 解析 preset 的 thinking 默认（适配 model）。
 * preset 无 thinkingDefaults → undefined；未知 preset 由 resolvePreset loud 抛出。
 */
export function resolveThinkingDefaults(
  presetId: string,
  model: string | undefined,
): ResolvedThinkingDefaults | undefined {
  const preset = resolvePreset(presetId);
  const defaults = preset.thinkingDefaults;
  if (!defaults) return undefined;

  const resolvedModel = (!model || model === 'auto') ? preset.defaultModel : model;
  if (!resolvedModel) return undefined;
  if (isKnownNonReasoning(preset, resolvedModel)) return undefined;

  return {
    ...(defaults.thinking !== undefined && { thinking: defaults.thinking }),
    ...(defaults.thinkingMode !== undefined && { thinking_mode: defaults.thinkingMode }),
    ...(defaults.thinkingEffort !== undefined && { thinking_effort: defaults.thinkingEffort }),
    ...(defaults.reasoningEffort !== undefined && { reasoning_effort: defaults.reasoningEffort }),
    ...(defaults.thinkingBudgetTokens !== undefined && { thinking_budget_tokens: defaults.thinkingBudgetTokens }),
    ...(defaults.dropThinkingBlocks !== undefined && { drop_thinking_blocks: defaults.dropThinkingBlocks }),
  };
}
