import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const SHARED_EDITOR = 'src/cli/llm-config-editor.ts';
const ENTRY_POINTS = ['src/cli/first-run-setup.ts', 'src/cli/commands/config.ts'];
const NORMAL_SETUP = [
  'src/cli/first-run-setup.ts',
  SHARED_EDITOR,
  'src/cli/setup-provider-catalog.ts',
  'src/cli/setup-provider-probe.ts',
];

describe('Phase 2207: shared explicit LLM setup boundary', () => {
  it('start/init 与 provider add 只调用同一个 interactive editor 和 repair editor', () => {
    for (const file of ENTRY_POINTS) {
      const source = read(file);
      expect(source).toMatch(/from ['"](?:\.|\.\.)\/llm-config-editor\.js['"]/);
      expect(source).toContain('collectExplicitLLMConfig');
      expect(source).toContain('repairExplicitLLMConfig');
      expect(source).not.toMatch(/collectSetupDraft|collectProviderAddDraft|selectSetupService|selectPreset/);
      expect(source).not.toContain('passwordQuestion');
    }
  });

  it('正常 setup import/source 不包含 preset alias 或 legacy migration', () => {
    for (const file of NORMAL_SETUP) {
      const source = read(file);
      expect(source, file).not.toMatch(/\bPRESETS\b|\bpresetId\b|migrateLegacyProviderConfig|preset-migration/);
    }
  });

  it('provider add target adapter 不读取 preset，PRESETS 仅留给既有 login 兼容', () => {
    const source = read('src/cli/commands/config.ts');
    const start = source.indexOf('async function providerAdd(');
    const end = source.indexOf('function formatApiKeyStatus(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toMatch(/\bPRESETS\b|\bpresetId\b|migrateLegacyProviderConfig/);
  });

  it('L4 migration owner 保留且正常 setup 不导入它', () => {
    const migration = 'src/core/llm-configuration/preset-migration.ts';
    expect(fs.existsSync(path.join(ROOT, migration))).toBe(true);
    expect(read(migration)).toContain('migrateLegacyProviderConfig');
  });
});
