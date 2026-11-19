import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  ApiKeyConfigError,
  createLLMConfigurationDocumentStore,
  migrateLegacyApiKeysAtPath,
  type SharedLLMInput,
} from '../../../src/core/llm-configuration/index.js';
import { getCredentialsFilePath } from '../../../src/core/llm-configuration/legacy-credentials/paths.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';
import * as path from 'node:path';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const deps = { fsFactory };
let homeDir: string;
let projectDir: string;

function plaintextSource(): SharedLLMInput {
  return {
    primary: { preset: 'anthropic', api_key: 'primary-secret', model: 'claude-test' },
    fallbacks: [{ preset: 'openai', api_key: 'fallback-secret', model: 'gpt-test' }],
  };
}

beforeEach(() => {
  homeDir = createTrackedTempDirSync('chestnut-api-key-home-');
  projectDir = createTrackedTempDirSync('chestnut-api-key-project-');
  vi.stubEnv('CHESTNUT_HOME', homeDir);
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(homeDir);
  cleanupTempDirSync(projectDir);
});

describe('legacy API key migration', () => {
  it('runtime read fails closed before migration without exposing the key', () => {
    const store = createLLMConfigurationDocumentStore(deps);
    store.createFromSource(plaintextSource(), 'legacy-seed');
    expect(() => store.readResolved()).toThrow(ApiKeyConfigError);
    expect(() => store.readResolved()).toThrow('legacy_plaintext_unmigrated');
    expect(() => store.readResolved()).not.toThrow('primary-secret');
  });

  it('migrates primary/fallback, verifies reload, and retries idempotently', async () => {
    const store = createLLMConfigurationDocumentStore(deps);
    store.createFromSource(plaintextSource(), 'legacy-seed');
    const events: string[] = [];
    const audit = { write: (event: string, ...columns: string[]) => {
      events.push([event, ...columns].join('\t'));
    } };

    const outcomes = await store.migrateLegacyApiKeys(audit);
    const raw = store.read();
    expect(outcomes).toHaveLength(2);
    expect(raw.primary.api_key).toMatch(/^\$\{CHESTNUT_/);
    expect(raw.fallbacks?.[0]?.api_key).toMatch(/^\$\{CHESTNUT_/);
    expect(store.readResolved().primary.api_key).toBe('primary-secret');
    expect(store.readResolved().fallbacks?.[0]?.api_key).toBe('fallback-secret');
    expect(fs.statSync(getCredentialsFilePath()).mode & 0o777).toBe(0o600);
    expect(events).toHaveLength(2);
    expect(events.join('\n')).not.toContain('primary-secret');
    expect(events.join('\n')).not.toContain('fallback-secret');

    const revision = raw.revision;
    await expect(store.migrateLegacyApiKeys()).resolves.toEqual([]);
    expect(store.read().revision).toBe(revision);
  });

  it('supports per-claw llm.primary overrides with the same protocol', async () => {
    const configPath = path.join(projectDir, 'claws', 'alice', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      'llm:',
      '  primary:',
      '    preset: anthropic',
      '    api_key: claw-secret',
      '    model: claude-test',
      '',
    ].join('\n'));

    await migrateLegacyApiKeysAtPath(deps, configPath);
    const text = fs.readFileSync(configPath, 'utf8');
    expect(text).toContain('${CHESTNUT_');
    expect(text).not.toContain('claw-secret');
  });
});
