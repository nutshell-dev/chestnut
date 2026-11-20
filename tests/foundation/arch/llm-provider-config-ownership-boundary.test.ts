import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const providerBarrel = read('../../../src/foundation/llm-provider/index.ts');
const providerConfigFacade = read('../../../src/foundation/llm-provider/capabilities/config-contract.ts');
const providerConfigAdapter = read('../../../src/foundation/llm-provider/config-adapter.ts');
const orchestratorBarrel = read('../../../src/foundation/llm-orchestrator/index.ts');
const configurationSchema = read('../../../src/core/llm-configuration/config-schema.ts');
const configurationBarrel = read('../../../src/core/llm-configuration/index.ts');
const formatMap = read('../../../src/cli/provider-format-map.ts');
const setupWorkflow = read('../../../src/core/llm-configuration/setup-workflow.ts');
const firstRunSetup = read('../../../src/cli/first-run-setup.ts');
const configCommand = read('../../../src/cli/commands/config.ts');
const explicitFormatConsumers = [
  '../../../src/cli/llm-config-editor.ts',
  '../../../src/cli/first-run-setup.ts',
].map(read);
const reconfigure = read('../../../src/cli/llm-connection-check.ts');

describe('LLM provider config ownership boundary', () => {
  it('moves schema, config type, and adapter to the L1 public barrel only', () => {
    expect(providerBarrel).toMatch(/export \* as llmProviderConfigContract from '\.\/capabilities\/config-contract\.js';/);
    expect(providerConfigFacade).toMatch(/export\s*\{\s*llmProviderConfigSchema\s*\}\s*from\s*'\.\.\/llm-provider-config-schema\.js';/);
    expect(providerConfigFacade).toMatch(/export\s*type\s*\{\s*LLMProviderConfig\s*\}\s*from\s*'\.\.\/llm-provider-config-schema\.js';/);
    expect(providerConfigFacade).toMatch(/export\s*\{\s*toProviderInput\s*\}\s*from\s*'\.\.\/config-adapter\.js';/);
    expect(providerConfigFacade).not.toMatch(/toProviderConnection|providerConnectionFromResolvedConfig|\bProviderConfig\b/);
    expect(orchestratorBarrel).not.toMatch(/\b(?:llmProviderConfigSchema|LLMProviderConfig|toProviderConfig|FORMAT_MAP)\b/);
    expect(orchestratorBarrel).not.toMatch(/\bllmOrchestratorConfigSchema\b/);
    expect(configurationBarrel).toMatch(/export\s*\{\s*llmOrchestratorConfigSchema\s*\}\s*from\s*'\.\/config-schema\.js';/);
    expect(configurationSchema).toMatch(/import\s*\{\s*llmProviderConfigContract\s*\}\s*from\s*'\.\.\/\.\.\/foundation\/llm-provider\/index\.js';\s*const\s*\{\s*llmProviderConfigSchema\s*\}\s*=\s*llmProviderConfigContract;/s);
  });

  it('keeps legacy preset resolution out of the active adapter', () => {
    expect(providerConfigAdapter).not.toMatch(/resolvePreset|PRESETS|resolveThinkingDefaults|\bpreset\b/);
    expect(providerConfigFacade).toMatch(/export\s*\{\s*toProviderInput\s*\}/);
  });

  it('retires the old Orchestrator files without compatibility facades', () => {
    expect(existsSync(new URL('../../../src/foundation/llm-provider/llm-provider-config-schema.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../../src/foundation/llm-provider/config-adapter.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../../src/foundation/llm-orchestrator/llm-provider-config-schema.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../../src/foundation/llm-orchestrator/config-adapter.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../../src/foundation/llm-orchestrator/config-schema.ts', import.meta.url))).toBe(false);
  });

  it('keeps one explicit setup workflow and one L4 business commit owner', () => {
    expect(setupWorkflow).not.toMatch(/^import\s+.*readline|from\s+['"][^'"]*cli|PRESETS|resolvePreset/m);
    expect(firstRunSetup).not.toMatch(/PRESETS|makeSetupCandidateProbe|probeSetupCandidates|mutateGlobalLocked|buildInitialConfig/);
    expect(firstRunSetup).toMatch(/runLLMSetupWorkflow\(/);
    expect(firstRunSetup).toMatch(/saveGlobalExclusive\(buildInitialRootConfig\(\)\)/);
    const providerAdd = configCommand.match(/async function providerAdd[\s\S]*?(?=\nfunction formatApiKeyStatus)/)?.[0];
    expect(providerAdd).toBeDefined();
    expect(providerAdd).toMatch(/runLLMSetupWorkflow\(/);
    expect(providerAdd).not.toMatch(/makeSetupCandidateProbe|probeSetupCandidates|mutateGlobalLocked|toProviderInput|checkLLMConnectionFor/);
    expect(setupWorkflow.match(/commitExplicitProvider\(/g)).toHaveLength(1);
  });

  it('keeps the explicit numeric format mapping in the shared editor owner', () => {
    expect(formatMap).toMatch(/export const FORMAT_MAP: Record<string, 'anthropic' \| 'openai' \| 'gemini'> = \{\s*'1': 'anthropic',\s*'2': 'openai',\s*'3': 'gemini',\s*\};/);
    expect(providerBarrel).not.toMatch(/\bFORMAT_MAP\b/);
    expect(orchestratorBarrel).not.toMatch(/\bFORMAT_MAP\b/);
    for (const consumer of explicitFormatConsumers) {
      expect(consumer).toMatch(/import\s*\{\s*FORMAT_MAP\s*\}\s*from\s*'[^']*provider-format-map\.js';/);
    }
    expect(configCommand).not.toMatch(/\bFORMAT_MAP\b/);
    expect(reconfigure).not.toMatch(/import\s*\{\s*FORMAT_MAP\s*\}/);
    expect(reconfigure).not.toMatch(/LEGACY_CUSTOM_FORMAT_MAP|PRESETS|preset default/);
  });
});
