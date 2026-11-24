import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createLLMConfigurationDocumentStore,
  LLMConfigurationCredentialUnavailableError,
} from '../../src/core/llm-configuration/index.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const deps = { fsFactory };
let tempDir: string;

beforeEach(() => {
  tempDir = createTrackedTempDirSync('chestnut-initialization-diagnostics-');
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  vi.stubEnv('PHASE2221_INIT_MISSING', undefined);
  fs.mkdirSync(path.join(tempDir, '.chestnut'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), "version: '1'\n");
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(tempDir);
});

async function commitMissingProvider(): Promise<void> {
  await createLLMConfigurationDocumentStore(deps).commitExplicitProvider({ kind: 'initialize' }, {
    provider_id: 'custom:anthropic',
    api_format: 'anthropic',
    auth_profile: 'api_key',
    label: 'main',
    api_key: '${PHASE2221_INIT_MISSING}',
    model: 'claude-test',
    base_url: 'https://example.test',
  });
}

describe('structural initialization diagnostics', () => {
  it('缺 credential 不阻断 raw 结构恢复，ready 不冒充 LLM 可运行', async () => {
    await commitMissingProvider();
    const root = createRootConfig(deps);
    expect(root.inspectInitialization().state).toBe('in_progress');

    root.completeInitialization();

    expect(root.inspectInitialization()).toEqual({ state: 'ready' });
    expect(root.getInitializationState()).toBe('ready');
    expect(() => createLLMConfigurationDocumentStore(deps).readSnapshot())
      .toThrow(LLMConfigurationCredentialUnavailableError);
    expect(fs.existsSync(path.join(tempDir, '.chestnut', '.initialized'))).toBe(true);
  });

  it('LLM malformed YAML 保留 llm_document 诊断且零覆盖', async () => {
    await commitMissingProvider();
    const configPath = path.join(tempDir, '.chestnut', 'llm', 'config.yaml');
    fs.writeFileSync(configPath, '{ invalid: [ }');
    const before = fs.readFileSync(configPath, 'utf8');

    const inspection = createRootConfig(deps).inspectInitialization();
    expect(inspection).toMatchObject({ state: 'invalid', reason: 'llm_document' });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(() => createRootConfig(deps).completeInitialization()).toThrow('llm_document');
  });

  it('root、audit、watchdog 与 ready layout 失败分别保留 owner reason', async () => {
    const root = createRootConfig(deps);
    fs.writeFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), '{ invalid: [ }');
    expect(root.inspectInitialization()).toMatchObject({ state: 'invalid', reason: 'root_config' });

    fs.writeFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), "version: '1'\n");
    await commitMissingProvider();
    root.completeInitialization();
    const auditPath = path.join(tempDir, '.chestnut', 'audit', 'config.yaml');
    const auditBefore = fs.readFileSync(auditPath, 'utf8');
    fs.writeFileSync(auditPath, 'schema_version: 999\n');
    expect(root.inspectInitialization()).toMatchObject({ state: 'invalid', reason: 'audit_config' });

    fs.writeFileSync(auditPath, auditBefore);
    const watchdogPath = path.join(tempDir, '.chestnut', 'watchdog', 'config.yaml');
    const watchdogBefore = fs.readFileSync(watchdogPath, 'utf8');
    fs.writeFileSync(watchdogPath, 'schema_version: 999\n');
    expect(root.inspectInitialization()).toMatchObject({ state: 'invalid', reason: 'watchdog_config' });

    fs.writeFileSync(watchdogPath, watchdogBefore);
    fs.rmSync(path.join(tempDir, '.chestnut', 'logs'), { recursive: true });
    expect(root.inspectInitialization()).toMatchObject({ state: 'invalid', reason: 'layout' });
  });
});
