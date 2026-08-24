import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const presetsSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/presets.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider AuthMethod deep surface', () => {
  it('keeps AuthMethod local to ProviderPreset.authMethod', () => {
    expect(presetsSource).not.toMatch(/export\s+type\s+AuthMethod\s*=/);
    expect(presetsSource).toMatch(
      /(?:^|\n)(?:export\s+)?type\s+AuthMethod\s*=\s*'api_key';/,
    );
    expect(presetsSource).toMatch(
      /export\s+interface\s+ProviderPreset\s*\{[^}]*authMethod:\s*AuthMethod;/s,
    );
  });
});
