/**
 * config provider remove / move — CLI audit emit (phase 1452 Step B)
 *
 * 每个 mutation 子命令 saveGlobal 成功侧 emit cli_config_saved（载荷含子命令名）。
 * add / set-primary 的同类断言见 config-provider-*-probe.test.ts。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const configDeps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
};

// config provider commands use action('required') → ensureWatchdog at CLI boundary;
// these tests focus on audit emit, so stub watchdog to avoid spawning real processes.
vi.mock('../../src/watchdog/ensure.js', () => ({
  ensureWatchdog: vi.fn().mockResolvedValue(undefined),
}));

const { createConfigCommand } = await import('../../src/cli/commands/config.js');

let tempDir: string;

function setupTempDir() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-config-audit-emit-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeInitialConfig() {
  const configDir = path.join(tempDir, '.chestnut');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    `llm:\n  primary:\n    preset: anthropic\n    api_key: sk-ant-old\n  fallbacks:\n    - preset: openai\n      label: fb-one\n      api_key: sk-1\n    - preset: openai\n      label: fb-two\n      api_key: sk-2\n`,
  );
}

function readAudit(): string {
  return fs.readFileSync(path.join(tempDir, '.chestnut', 'audit.tsv'), 'utf-8');
}

describe('config provider remove/move — audit emit (phase 1452 Step B)', () => {
  beforeEach(() => {
    setupTempDir();
    writeInitialConfig();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    teardownTempDir();
  });

  it('provider remove emits cli_config_saved after saveGlobal', async () => {
    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'remove', 'fb-one']);

    const auditContent = readAudit();
    expect(auditContent).toContain('cli_config_saved');
    expect(auditContent).toContain('command=provider_remove');
    expect(auditContent).toContain('label=fb-one');
  });

  it('provider move emits cli_config_saved after saveGlobal', async () => {
    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'move', 'fb-two', '1']);

    const auditContent = readAudit();
    expect(auditContent).toContain('cli_config_saved');
    expect(auditContent).toContain('command=provider_move');
    expect(auditContent).toContain('label=fb-two');
    expect(auditContent).toContain('position=1');
  });
});
