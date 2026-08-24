import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerTypes = readFileSync(
  new URL('../../../src/foundation/llm-provider/types.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider Role deep surface', () => {
  it('keeps Role local to Message instead of exporting a standalone capability', () => {
    expect(providerTypes).not.toMatch(/export\s+type\s+Role\s*=/);
    expect(providerTypes).toMatch(/(?:^|\n)(?:export\s+)?type\s+Role\s*=\s*'user'\s*\|\s*'assistant'\s*\|\s*'system';/);
    expect(providerTypes).toMatch(/export\s+interface\s+Message\s*\{[^}]*role:\s*Role;/s);
  });
});
