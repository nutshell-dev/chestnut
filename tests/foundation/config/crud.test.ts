import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { getClawConfigPath } from '../../../src/core/claw-topology/claw-instance-paths.js';

const { loadGlobalConfig, loadClawConfig, patchGlobalConfigPrimary } = await import('../../../src/assembly/config/config-load.js');

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
