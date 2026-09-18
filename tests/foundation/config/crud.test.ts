import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { getClawConfigPath } from '../../../src/foundation/claw-identity/index.js';

const { loadGlobalConfig, loadClawConfig, patchGlobalConfigPrimary, buildLLMConfig } = await import('../../../src/assembly/config/config-load.js');

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tempDir: string;

function setupTempDir() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-crud-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

describe('assembly/config-load: loadGlobalConfig', () => {
  beforeEach(setupTempDir);
  afterEach(teardownTempDir);

  it('throws on invalid YAML', () => {
    const configPath = path.join(tempDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ invalid yaml: [ }');

    expect(() => loadGlobalConfig({ fsFactory })).toThrow('Invalid YAML in config');
  });

  it('throws on missing env var reference', () => {
    const configPath = path.join(tempDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `
version: '1'
llm:
  primary:
    api_key: \${NONEXISTENT_VAR}
`);

    expect(() => loadGlobalConfig({ fsFactory })).toThrow('Invalid global config (env var)');
  });

  it('throws on read failure (permission)', () => {
    const configPath = path.join(tempDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'version: "1"\n');
    fs.chmodSync(configPath, 0o000);

    try {
      expect(() => loadGlobalConfig({ fsFactory })).toThrow('Failed to read config');
    } finally {
      fs.chmodSync(configPath, 0o644);
    }
  });
});

describe('assembly/config-load: loadClawConfig', () => {
  beforeEach(setupTempDir);
  afterEach(teardownTempDir);

  it('expands env vars in claw config', () => {
    vi.stubEnv('TEST_CLAW_KEY', 'sk-claw-123');
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'testclaw');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), `
name: testclaw
llm:
  primary:
    api_key: \${TEST_CLAW_KEY}
`);

    const config = loadClawConfig({ fsFactory }, getClawConfigPath('testclaw'));
    expect(config.llm?.primary?.api_key).toBe('sk-claw-123');
  });

  it('throws on invalid YAML in claw config', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'badclaw');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), '{ bad');

    expect(() => loadClawConfig({ fsFactory }, getClawConfigPath('badclaw'))).toThrow('Invalid YAML in config');
  });
});

describe('assembly/config-load: buildLLMConfig circuit breaker defaults (phase 1268 Step E)', () => {
  beforeEach(setupTempDir);
  afterEach(teardownTempDir);

  function writeMinimalConfig(extraLlmYaml = '') {
    const configPath = path.join(tempDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `
version: '1'
llm:
  primary:
    preset: anthropic
    api_key: sk-test
    model: claude-test
${extraLlmYaml}
`);
  }

  it('缺段 circuit_breaker 时 load + build 均得到默认启用配置', () => {
    writeMinimalConfig();
    const globalConfig = loadGlobalConfig({ fsFactory });
    expect(globalConfig.llm.circuit_breaker).toEqual({
      failure_threshold: 3,
      reset_timeout_ms: 60_000,
    });

    const llmConfig = buildLLMConfig(globalConfig);
    expect(llmConfig.circuitBreaker).toEqual({
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
    });
  });

  it('显式 circuit_breaker 值在读写后保持不被覆盖', () => {
    writeMinimalConfig(`  circuit_breaker:\n    failure_threshold: 5\n    reset_timeout_ms: 120000\n`);
    const globalConfig = loadGlobalConfig({ fsFactory });
    expect(globalConfig.llm.circuit_breaker).toEqual({
      failure_threshold: 5,
      reset_timeout_ms: 120_000,
    });

    const llmConfig = buildLLMConfig(globalConfig);
    expect(llmConfig.circuitBreaker).toEqual({
      failureThreshold: 5,
      resetTimeoutMs: 120_000,
    });
  });

  it('缺段 + primary+2 fallbacks 时 build 得到 N+1 个 breaker 配置', () => {
    writeMinimalConfig(`  fallbacks:\n    - preset: openai\n      api_key: sk-fb1\n      model: gpt-test\n    - preset: moonshot\n      api_key: sk-fb2\n      model: kimi-test\n`);
    const globalConfig = loadGlobalConfig({ fsFactory });
    const llmConfig = buildLLMConfig(globalConfig);
    expect(llmConfig.fallbacks).toHaveLength(2);
    expect(llmConfig.circuitBreaker).toEqual({
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
    });
  });
});

describe('assembly/config-load: patchGlobalConfig', () => {
  beforeEach(setupTempDir);
  afterEach(teardownTempDir);

  it('throws on array root YAML', () => {
    const configPath = path.join(tempDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '- item1\n- item2\n');

    expect(() => patchGlobalConfigPrimary({ fsFactory }, { model: 'x' })).toThrow('config parse failed');
  });
});
