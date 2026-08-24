import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerErrors = readFileSync(
  new URL('../../../src/foundation/llm-provider/errors.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider LLMErrorCode deep surface', () => {
  it('keeps LLMErrorCode local to typed error class code properties', () => {
    expect(providerErrors).not.toMatch(/export\s+type\s+LLMErrorCode\s*=/);
    expect(providerErrors).toMatch(
      /(?:^|\n)(?:export\s+)?type\s+LLMErrorCode\s*=[\s\S]*?'LLM_INVALID_REQUEST';/,
    );
    expect(providerErrors.match(/readonly\s+code:\s*LLMErrorCode\s*=/g)).toHaveLength(11);
  });
});
