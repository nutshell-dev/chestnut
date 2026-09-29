import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const catalogSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/model-context-windows.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider default context window surface', () => {
  it('keeps the default constant local while preserving resolver fallbacks', () => {
    expect(catalogSource).not.toMatch(/export\s+const\s+DEFAULT_MODEL_CONTEXT_WINDOW\b/);
    expect(catalogSource).toMatch(/const\s+DEFAULT_MODEL_CONTEXT_WINDOW\s*=\s*256_000;/);
    // Phase 1925 Step C: provider 感知签名（catalog 精确命中优先，启发式回退）
    expect(catalogSource).toMatch(/export\s+function\s+resolveContextWindow\s*\(\s*providerId:\s*string\s*\|\s*undefined,\s*modelName:\s*string\s*\|\s*undefined,?\s*\)\s*:\s*number/);
    expect(catalogSource.match(/return\s+DEFAULT_MODEL_CONTEXT_WINDOW;/g)).toHaveLength(2);
  });
});
