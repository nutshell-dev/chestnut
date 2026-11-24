import { vi } from 'vitest';
import { llmProviderLegacyConfigMigration } from '../../src/foundation/llm-provider/index.js';
const { PRESETS } = llmProviderLegacyConfigMigration;

export function clearCliCredentialEnv(extraRefs: readonly string[] = []): void {
  const refs = new Set<string>(extraRefs);
  for (const preset of Object.values(PRESETS)) {
    if (preset.envVar) refs.add(preset.envVar);
  }
  for (const name of Object.keys(process.env)) {
    if (name.endsWith('API_KEY')) refs.add(name);
  }
  for (const ref of refs) vi.stubEnv(ref, undefined);
}
