import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { loadGlobalConfig, loadClawConfig, patchGlobalConfigPrimary } = await import('../../../src/foundation/config/crud.js');
const { CONFIG_DEFAULTS } = await import('../../../src/assembly/config-defaults.js');

let tempDir: string;

function setupTempDir() {
  tempDir = path.join(tmpdir(), `clawforum-crud-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CLAWFORUM_ROOT', tempDir);
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

describe('loadGlobalConfig', () => {
  beforeEach(setupTempDir);
  afterEach(teardownTempDir);

  it('throws on invalid YAML', () => {
    const configPath = path.join(tempDir, '.clawforum', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ invalid yaml: [ }');

    expect(() => loadGlobalConfig(CONFIG_DEFAULTS)).toThrow('Invalid YAML in config');
  });

  it('throws on missing env var reference', () => {
    const configPath = path.join(tempDir, '.clawforum', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `
version: '1'
llm:
  primary:
    api_key: \${NONEXISTENT_VAR}
`);

    expect(() => loadGlobalConfig(CONFIG_DEFAULTS)).toThrow('Invalid global config (env var)');
  });

  it('throws on read failure (permission)', () => {
    const configPath = path.join(tempDir, '.clawforum', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'version: "1"\n');
    fs.chmodSync(configPath, 0o000);

    try {
      expect(() => loadGlobalConfig(CONFIG_DEFAULTS)).toThrow('Failed to read config');
    } finally {
      fs.chmodSync(configPath, 0o644);
    }
  });
});

describe('loadClawConfig', () => {
  beforeEach(setupTempDir);
  afterEach(teardownTempDir);

  it('expands env vars in claw config', () => {
    vi.stubEnv('TEST_CLAW_KEY', 'sk-claw-123');
    const clawDir = path.join(tempDir, '.clawforum', 'claws', 'testclaw');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), `
name: testclaw
llm:
  primary:
    api_key: \${TEST_CLAW_KEY}
`);

    const config = loadClawConfig('testclaw', CONFIG_DEFAULTS);
    expect(config.llm?.primary?.api_key).toBe('sk-claw-123');
  });

  it('throws on invalid YAML in claw config', () => {
    const clawDir = path.join(tempDir, '.clawforum', 'claws', 'badclaw');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), '{ bad');

    expect(() => loadClawConfig('badclaw', CONFIG_DEFAULTS)).toThrow('Invalid YAML in config');
  });
});

describe('patchGlobalConfig', () => {
  beforeEach(setupTempDir);
  afterEach(teardownTempDir);

  it('throws on array root YAML', () => {
    const configPath = path.join(tempDir, '.clawforum', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '- item1\n- item2\n');

    expect(() => patchGlobalConfigPrimary({ model: 'x' })).toThrow('config parse failed');
  });
});
