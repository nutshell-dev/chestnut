import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const parserSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/custom-anthropic-sse-parser.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider custom-Anthropic stream parse error callback surface', () => {
  it('keeps the callback type local while preserving the parser contract', () => {
    expect(parserSource).not.toMatch(/export\s+type\s+StreamParseErrorCallback\b/);
    expect(parserSource).toMatch(/type\s+StreamParseErrorCallback\s*=\s*\(event:\s*\{[\s\S]*?provider:\s*string;[\s\S]*?raw:\s*string;[\s\S]*?error:\s*string;[\s\S]*?\}\)\s*=>\s*void;/);
    expect(parserSource).toMatch(/export\s+async\s+function\*\s+parseAnthropicSSEStream\s*\(/);
    expect(parserSource).toMatch(/onStreamParseError:\s*StreamParseErrorCallback\s*\|\s*undefined/);
  });
});
