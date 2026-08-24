import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const estimatorSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/token-estimator.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider per-message overhead deep surface', () => {
  it('keeps the overhead constant local to estimateMessageTokens', () => {
    expect(estimatorSource).not.toMatch(/export\s+const\s+PER_MESSAGE_OVERHEAD_TOKENS\s*=/);
    expect(estimatorSource).toMatch(/(?:^|\n)(?:export\s+)?const\s+PER_MESSAGE_OVERHEAD_TOKENS\s*=\s*4;/);
    expect(estimatorSource).toMatch(/function\s+estimateMessageTokens\s*\([^)]*\)\s*:\s*number\s*\{\s*let\s+total\s*=\s*PER_MESSAGE_OVERHEAD_TOKENS;/s);
  });
});
