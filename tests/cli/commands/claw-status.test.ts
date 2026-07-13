/**
 * claw-status CLI command tests — phase 1472 Step C.
 *
 * Coverage:
 * - golden text path: empty claw → "no active contract / idle / not found / 0 files"
 * - --json path: structured output
 * - claw does not exist → CliError with `chestnut claw list` hint
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { clawStatusCommand } from '../../../src/cli/commands/claw-status.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CliError } from '../../../src/cli/errors.js';
import { loadGlobalConfig, clawExists } from '../../../src/assembly/config/config-load.js';
import { getClawDir, getClawConfigPath } from '../../../src/core/claw-topology/claw-instance-paths.js';
import { STATUS_AUDIT_EVENTS } from '../../../src/core/status-service/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn(),
    getClawConfigPath: vi.fn(),
  };
});
function makeAudit(): AuditLog & { events: [string, ...(string | number)[]][] } {
  const events: [string, ...(string | number)[]][] = [];
  return {
    __brand: 'AuditLog',
    write(type: string, ...cols: (string | number)[]) {
      events.push([type, ...cols]);
    },
    preview(s: string) {
      return s;
    },
    message(s: string) {
      return s;
    },
    summary(s: string) {
      return s;
    },
    dispose() {},
    events,
  } as unknown as AuditLog & { events: [string, ...(string | number)[]][] };
}

let currentAudit: ReturnType<typeof makeAudit>;

vi.mock('../../../src/foundation/audit/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/audit/index.js')>();
  return {
    ...actual,
    createSystemAudit: vi.fn(() => {
      currentAudit = makeAudit();
      return currentAudit;
    }),
  };
});

vi.mock('../../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(),
  buildLLMConfig: vi.fn(),
}));

describe('claw-status (phase 1472 Step C)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let tmpRoot: string;
  let clawDir: string;

  beforeEach(async () => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-status-test-'));
    clawDir = path.join(tmpRoot, '.chestnut', 'claws', 'foo');
    fs.mkdirSync(clawDir, { recursive: true });

    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    vi.mocked(getClawConfigPath).mockImplementation((name: string) => path.join('/tmp/chestnut/claws', name, 'config.yaml'));
    vi.mocked(clawExists).mockImplementation((_: any, configPath: string) => configPath.includes('/claws/foo/'));
    vi.mocked(getClawDir).mockImplementation(() => clawDir);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('empty claw → text output with idle / no-active / not-found', async () => {
    await clawStatusCommand({ fsFactory }, 'foo', {});

    const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain(`Claw: foo`);
    // phase 369 §4 (review-2026-06-13): 'string:' typeof leak → 'Dir:' 语义前缀
    expect(out).toContain(`Dir: ${path.resolve(clawDir)}`);
    expect(out).toContain('Contract: No active contract');
    expect(out).toContain('Tasks: idle');
    expect(out).toContain('MEMORY.md: Not found');
    expect(out).toContain('Clawspace: 0 files');
  });

  it('--json → structured output containing claw/clawDir/contract/tasks/storage', async () => {
    await clawStatusCommand({ fsFactory }, 'foo', { json: true });

    const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(out);
    expect(parsed.claw).toBe('foo');
    expect(parsed.clawDir).toBe(path.resolve(clawDir));
    expect(parsed.contract.type).toBe('no-active');
    expect(parsed.tasks.type).toBe('counts');
    expect(parsed.tasks.pending).toBe(0);
    expect(parsed.tasks.running).toBe(0);
    expect(parsed.storage.memoryMd.type).toBe('not-found');
    expect(parsed.storage.clawspace).toEqual({ type: 'count', files: 0 });
  });

  it('counts MEMORY.md size + clawspace files when present', async () => {
    fs.writeFileSync(path.join(clawDir, 'MEMORY.md'), 'x'.repeat(2048));
    fs.mkdirSync(path.join(clawDir, 'clawspace'), { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'clawspace', 'a.md'), 'a');
    fs.writeFileSync(path.join(clawDir, 'clawspace', 'b.md'), 'b');

    await clawStatusCommand({ fsFactory }, 'foo', {});

    const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('MEMORY.md: 2.0KB');
    expect(out).toContain('Clawspace: 2 files');
  });

  it('rejects unknown claw with `chestnut claw list` hint', async () => {
    await expect(clawStatusCommand({ fsFactory }, 'nonexistent', {})).rejects.toThrow(
      /chestnut claw list/,
    );
    await expect(clawStatusCommand({ fsFactory }, 'nonexistent', {})).rejects.toThrow(CliError);
  });

  it('writes TASK_RUNNING_ERROR audit when running dir fails', async () => {
    const eioErr = Object.assign(new Error('EIO'), { code: 'EIO' });
    const mockFs = {
      list: vi.fn().mockImplementation(async (dir: string) => {
        if (String(dir).includes('running')) throw eioErr;
        return [];
      }),
      exists: vi.fn().mockResolvedValue(false),
      read: vi.fn().mockRejectedValue(new Error('ENOENT')),
      existsSync: vi.fn().mockReturnValue(false),
      statSync: vi.fn(),
      readSync: vi.fn(),
      readBytesSync: vi.fn(),
      listSync: vi.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof fsFactory>;

    await clawStatusCommand({ fsFactory: () => mockFs }, 'foo', {});

    const runningErrors = currentAudit.events.filter(
      (e) => e[0] === STATUS_AUDIT_EVENTS.TASK_RUNNING_ERROR,
    );
    expect(runningErrors.length).toBe(1);
    expect(runningErrors[0][1]).toMatch(/^error=/);
  });
});
