import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const estimatorSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/token-estimator.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider single-tool estimator deep surface', () => {
  it('keeps estimateToolTokens local behind estimateToolsTokens', () => {
    expect(estimatorSource).not.toMatch(/export\s+function\s+estimateToolTokens\s*\(/);
    expect(estimatorSource).toMatch(/(?:^|\n)(?:export\s+)?function\s+estimateToolTokens\s*\(tool:\s*ToolDefinition\):\s*number\s*\{/);
    expect(estimatorSource).toMatch(/export\s+function\s+estimateToolsTokens\s*\(tools:\s*readonly\s+ToolDefinition\[\]\):\s*number\s*\{/);
    expect(estimatorSource).toMatch(/for\s*\(const\s+tool\s+of\s+tools\)\s*\{\s*total\s*\+=\s*estimateToolTokens\(tool\);/s);
  });
});
