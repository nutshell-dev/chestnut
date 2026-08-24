import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const estimatorSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/token-estimator.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider composite token estimator deep surface', () => {
  it('exposes only the owner text, messages, and tools estimators', () => {
    expect(estimatorSource).not.toMatch(/\bInputTokenEstimateOptions\b/);
    expect(estimatorSource).not.toMatch(/\bInputTokenEstimate\b/);
    expect(estimatorSource).not.toMatch(/\bestimateInputTokens\b/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateTextTokens\s*\(/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateMessagesTokens\s*\(/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateToolsTokens\s*\(/);
  });
});
