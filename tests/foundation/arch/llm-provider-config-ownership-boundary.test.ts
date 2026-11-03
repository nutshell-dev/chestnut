import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const providerBarrel = read('../../../src/foundation/llm-provider/index.ts');
const orchestratorBarrel = read('../../../src/foundation/llm-orchestrator/index.ts');
const orchestratorConfigSchema = read('../../../src/foundation/llm-orchestrator/config-schema.ts');
const formatMap = read('../../../src/cli/provider-format-map.ts');
const cliConsumers = [
  '../../../src/cli/llm-connection-check.ts',
  '../../../src/cli/commands/config.ts',
  '../../../src/cli/first-run-setup.ts',
].map(read);

describe('LLM provider config ownership boundary', () => {
  it('moves schema, config type, and adapter to the L1 public barrel only', () => {
    expect(providerBarrel).toMatch(/export\s*\{\s*llmProviderConfigSchema\s*\}\s*from\s*'\.\/llm-provider-config-schema\.js';/);
    expect(providerBarrel).toMatch(/export\s*type\s*\{\s*LLMProviderConfig\s*\}\s*from\s*'\.\/llm-provider-config-schema\.js';/);
    expect(providerBarrel).toMatch(/export\s*\{\s*toProviderConfig\s*\}\s*from\s*'\.\/config-adapter\.js';/);
    expect(orchestratorBarrel).not.toMatch(/\b(?:llmProviderConfigSchema|LLMProviderConfig|toProviderConfig|FORMAT_MAP)\b/);
    expect(orchestratorBarrel).toMatch(/export\s*\{\s*llmOrchestratorConfigSchema\s*\}\s*from\s*'\.\/config-schema\.js';/);
    expect(orchestratorConfigSchema).toMatch(/import\s*\{\s*llmProviderConfigSchema\s*\}\s*from\s*'\.\.\/llm-provider\/index\.js';/);
  });

  it('retires the old Orchestrator files without compatibility facades', () => {
    expect(existsSync(new URL('../../../src/foundation/llm-provider/llm-provider-config-schema.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../../src/foundation/llm-provider/config-adapter.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../../src/foundation/llm-orchestrator/llm-provider-config-schema.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../../src/foundation/llm-orchestrator/config-adapter.ts', import.meta.url))).toBe(false);
  });

  it('keeps the numeric format map as one CLI-owned source', () => {
    expect(formatMap).toMatch(/export const FORMAT_MAP: Record<string, string> = \{\s*'1': 'custom-anthropic',\s*'2': 'custom-openai',\s*'3': 'custom-gemini',\s*\};/);
    expect(providerBarrel).not.toMatch(/\bFORMAT_MAP\b/);
    expect(orchestratorBarrel).not.toMatch(/\bFORMAT_MAP\b/);
    for (const consumer of cliConsumers) {
      expect(consumer).toMatch(/import\s*\{\s*FORMAT_MAP\s*\}\s*from\s*'[^']*provider-format-map\.js';/);
    }
  });
});
