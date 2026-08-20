/**
 * claw import — CLI audit emit (phase 1452 Step B)
 *
 * 成功路径（落盘后）emit CLI_AUDIT_EVENTS.CLAW_IMPORT；
 * 失败路径走既有 CliError，无 audit（豁免：失败由 handler catch 承载）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { importCommand } from '../../src/cli/commands/claw-import.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CLI_AUDIT_EVENTS } from '../../src/cli/audit-events.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

describe('claw import audit emit (phase 1452 Step B)', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('chestnut-import-audit-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const configPath = path.join(tmpDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n',
    );
    const clawDir = path.join(tmpDir, '.chestnut', 'claws', 'alice');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: alice\n');
  });

  afterEach(async () => {
    logSpy.mockRestore();
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    await cleanupTempDir(tmpDir);
  });

  it('single-file import emits CLAW_IMPORT after writeAtomic', async () => {
    fs.writeFileSync(path.join(tmpDir, 'note.md'), 'hello');
    const audit = { write: vi.fn() };

    await importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'note.md'), 'alice', undefined, { audit: audit as any });

    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      CLI_AUDIT_EVENTS.CLAW_IMPORT,
      'claw=alice',
      'target=note.md',
    );
  });

  it('directory import emits CLAW_IMPORT with target subdir', async () => {
    fs.mkdirSync(path.join(tmpDir, 'bundle'));
    fs.writeFileSync(path.join(tmpDir, 'bundle', 'a.txt'), 'a');
    const audit = { write: vi.fn() };

    await importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'bundle'), 'alice', 'docs', { audit: audit as any });

    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      CLI_AUDIT_EVENTS.CLAW_IMPORT,
      'claw=alice',
      'target=docs/bundle',
    );
  });

  it('failed import (missing source) emits no audit', async () => {
    const audit = { write: vi.fn() };

    await expect(
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'ghost.md'), 'alice', undefined, { audit: audit as any }),
    ).rejects.toThrow();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
