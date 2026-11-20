/** @module L1.LLMProvider.ModelFamilyResolver */

export const MODEL_FAMILY_RESOLVER_REVISION = 'model-family-v1' as const;

export type InputModelFamily = 'deepseek' | 'kimi' | 'qwen' | 'glm';

/**
 * Normalize only the model name. The final path segment supports gateway IDs;
 * a single trailing context suffix such as `[1m]` is not part of the family.
 */
export function normalizeModelFamilyName(modelName: string): string {
  const normalized = modelName.trim().toLowerCase().replace(/\[[^\]]*\]$/u, '');
  return normalized.split('/').at(-1)?.trim() ?? '';
}

/** Fixed aliases are model-name facts; no provider, API, or endpoint is consulted. */
export function resolveModelFamily(modelName: string): InputModelFamily | undefined {
  const name = normalizeModelFamilyName(modelName);
  if (/^deepseek(?:$|[-_.])/u.test(name)) return 'deepseek';
  if (/^(?:kimi|k3)(?:$|[-_.])/u.test(name)) return 'kimi';
  if (/^qwen(?:$|[-_.]|[0-9])/u.test(name)) return 'qwen';
  if (/^glm(?:$|[-_.]|[0-9])/u.test(name)) return 'glm';
  return undefined;
}
