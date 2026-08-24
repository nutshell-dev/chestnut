import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const presetsSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/presets.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider ProviderPreset deep surface', () => {
  it('keeps ProviderPreset local to PRESETS and resolvePreset', () => {
    expect(presetsSource).not.toMatch(/export\s+interface\s+ProviderPreset\s*\{/);
    expect(presetsSource).toMatch(/(?:^|\n)(?:export\s+)?interface\s+ProviderPreset\s*\{/);
    expect(presetsSource).toMatch(/export\s+const\s+PRESETS:\s*Record<string,\s*ProviderPreset>\s*=/);
    expect(presetsSource).toMatch(/export\s+function\s+resolvePreset\(id:\s*string\):\s*ProviderPreset\s*\{/);
  });
});
