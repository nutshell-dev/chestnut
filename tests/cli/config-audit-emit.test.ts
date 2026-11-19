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
import { createLLMConfiguration } from '../../src/core/llm-configuration/index.js';
import { emitLLMSetupWorkflowAudit } from '../../src/cli/setup-provider-probe.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const configDeps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
  llmConfiguration: createLLMConfiguration({ fsFactory }),
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

  it.each([
    { kind: 'committed_platform_limited' as const },
    { kind: 'committed_durability_unknown' as const },
  ])('provider remove $kind：notice 后继续 saved/notify，不重写', async ({ kind }) => {
    const error = Object.assign(new Error(`directory fsync failed: ${kind}`), { code: 'EIO' });
    const write = vi.spyOn(configDeps.llmConfiguration, 'mutateGlobalLocked').mockResolvedValue({ kind, error });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'remove', 'fb-one']);

    expect(write).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`kind=${kind}`));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`directory fsync failed: ${kind}`));
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      '✓ Removed provider (label="fb-one" role=fallback match=label) from fallbacks',
    );
    expect(readAudit()).toContain('command=provider_remove');
  });

  it('provider remove throw：保持原 CLI 失败分类且不重试', async () => {
    const failure = new Error('rename failed');
    const write = vi.spyOn(configDeps.llmConfiguration, 'mutateGlobalLocked').mockRejectedValue(failure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    const cmd = createConfigCommand(configDeps);
    await expect(cmd.parseAsync(['node', 'test', 'provider', 'remove', 'fb-one']))
      .rejects.toThrow('process.exit(1)');

    expect(write).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Error:', expect.stringContaining('rename failed'));
  });
});

describe('setup workflow audit redaction', () => {
  it('不写原始 URL/userinfo/query，保留 candidate identity/kind/timing', () => {
    const write = vi.fn();
    const audit = {
      write,
      message: (value: string) => value,
    } as unknown as import('../../src/foundation/audit/index.js').AuditLog;
    const url = 'https://user:secret@example.test/v1?token=query-secret';

    emitLLMSetupWorkflowAudit(audit, {
      type: 'probe_attempted', identity: 'candidate-a', url, provider: 'custom:test', model: 'model',
      startedAt: '2026-01-01T00:00:00.000Z', kind: 'candidate',
    });
    emitLLMSetupWorkflowAudit(audit, {
      type: 'probe_finished', identity: 'candidate-a', url,
      result: { ok: false, errorType: 'network' },
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
      winner: false, kind: 'candidate',
    });

    const serialized = JSON.stringify(write.mock.calls);
    expect(serialized).not.toContain('url=');
    expect(serialized).not.toContain('user:secret');
    expect(serialized).not.toContain('query-secret');
    expect(serialized).toContain('candidate=candidate-a');
    expect(serialized).toContain('kind=candidate');
    expect(serialized).toContain('started_at=2026-01-01T00:00:00.000Z');
    expect(serialized).toContain('completed_at=2026-01-01T00:00:01.000Z');
  });
});
