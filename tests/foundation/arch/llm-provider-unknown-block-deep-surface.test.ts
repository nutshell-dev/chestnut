import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerTypes = readFileSync(
  new URL('../../../src/foundation/llm-provider/types.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider UnknownBlock deep surface', () => {
  it('keeps UnknownBlock local to the open ContentBlock union', () => {
    expect(providerTypes).not.toMatch(/export\s+interface\s+UnknownBlock\s*\{/);
    expect(providerTypes).toMatch(
      /(?:^|\n)(?:export\s+)?interface\s+UnknownBlock\s*\{\s*type:\s*string;\s*\[key:\s*string\]:\s*unknown;\s*\}/,
    );
    expect(providerTypes).toMatch(
      /export\s+type\s+ContentBlock\s*=\s*TextBlock\s*\|\s*ToolUseBlock\s*\|\s*ToolResultBlock\s*\|\s*ThinkingBlock\s*\|\s*UnknownBlock;/,
    );
  });
});
