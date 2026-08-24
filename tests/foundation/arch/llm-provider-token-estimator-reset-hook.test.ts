import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const estimatorSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/token-estimator.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider token estimator reset hook surface', () => {
  it('has no unused reset hook while retaining runtime caches', () => {
    expect(estimatorSource).not.toMatch(/\b__resetForTest\b/);
    expect(estimatorSource).toMatch(/let\s+encodingCache:\s*Tiktoken\s*\|\s*null\s*=\s*null;/);
    expect(estimatorSource).toMatch(/const\s+textTokenCache\s*=\s*new\s+Map<string,\s*number>\(\);/);
    expect(estimatorSource).toMatch(/const\s+TEXT_TOKEN_CACHE_MAX_ENTRIES\s*=\s*128;/);
    expect(estimatorSource).toMatch(/const\s+TEXT_TOKEN_CACHE_MAX_TEXT_CHARS\s*=\s*50_000;/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateTextTokens\s*\(/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateMessagesTokens\s*\(/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateToolsTokens\s*\(/);
  });
});
