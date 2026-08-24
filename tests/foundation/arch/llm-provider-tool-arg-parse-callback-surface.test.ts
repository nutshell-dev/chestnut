import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const parserSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/openai-response-parser.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider OpenAI tool arg parse callback surface', () => {
  it('keeps the callback type local while preserving the parser contract', () => {
    expect(parserSource).not.toMatch(/export\s+type\s+ToolArgParseErrorCallback\b/);
    expect(parserSource).toMatch(/type\s+ToolArgParseErrorCallback\s*=\s*\(event:\s*\{[\s\S]*?provider:\s*string;[\s\S]*?toolName:\s*string;[\s\S]*?rawArgs:\s*string;[\s\S]*?error:\s*string;[\s\S]*?\}\)\s*=>\s*void;/);
    expect(parserSource).toMatch(/export\s+function\s+parseResponse\s*\(/);
    expect(parserSource).toMatch(/onToolArgParseError\?:\s*ToolArgParseErrorCallback/);
  });
});
