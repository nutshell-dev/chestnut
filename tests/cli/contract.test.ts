import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { type ContractYaml } from '../../src/core/contract/index.js';

vi.mock('../../src/foundation/audit/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/audit/index.js')>()),
  createDirContext: vi.fn((_deps: any) => ({
    fs: {
      appendSync: vi.fn(() => { throw new Error('disk full'); }),
    },
    audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)},
  })),
}));

vi.mock('../../src/foundation/messaging/index.js', () => ({
  notifyClaw: vi.fn(),
  INBOX_PENDING_DIR: 'inbox/pending',
  resolveDlqDir: (inboxDir: string) => `${inboxDir}/dead-letter`,
}));

import { notifyContractCreated } from '../../src/cli/commands/contract.js';
import { createDirContext } from '../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('notifyContractCreated audit observability', () => {
  it('audit includes contractId on append failure', () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    (createDirContext as any).mockReturnValue({
      fs: {
        appendSync: vi.fn(() => { throw new Error('disk full'); }),
        resolve: vi.fn((p: string) => path.resolve(p)),
      },
      audit,
    });

    const contract = {
      title: 'Test Contract',
      goal: 'test goal',
      subtasks: [{ id: 't1', description: 'd1' }],
    } as any;

    notifyContractCreated({ fsFactory }, '/tmp/claw', 'claw-1', 'test-contract-001', contract, '/tmp/chestnut');

    expect(audit.write).toHaveBeenCalledWith(
      'stream_append_failed',
      'path=stream.jsonl',
      'type=user_notify',
      expect.stringMatching(/reason=disk full/),
      expect.stringMatching(/"contractId":"test-contract-001"/),
    );
  });

  it('appends contract_created event to stream.jsonl via PerResourceStreamWriter (phase 1120)', async () => {
    const tempDir = await createTrackedTempDir('contract-notify-');
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    try {
      (createDirContext as any).mockReturnValue({
        fs: {
          appendSync: vi.fn((filePath: string, data: string) => {
            fs.appendFileSync(path.join(tempDir, filePath), data);
          }),
          resolve: vi.fn((p: string) => path.resolve(tempDir, p)),
        },
        audit,
      });

      const contract: ContractYaml = {
        title: 'T', goal: 'G', subtasks: [{ id: 's1', description: 'd' }],
      };

      notifyContractCreated({ fsFactory }, tempDir, 'claw-A', 'c-001', contract, tempDir);
      const streamContent = fs.readFileSync(path.join(tempDir, 'stream.jsonl'), 'utf-8');
      const lines = streamContent.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('user_notify');
      expect(parsed.subtype).toBe('contract_created');
      expect(parsed.contractId).toBe('c-001');
      expect(parsed.clawId).toBe('claw-A');
      expect(parsed.title).toBe('T');
      expect(parsed.subtaskCount).toBe(1);
      expect(typeof parsed.ts).toBe('number');
    } finally {
      fs.chmodSync(tempDir, 0o700);
      await cleanupTempDir(tempDir);
    }
  });

  it('emits STREAM_AUDIT_EVENTS.APPEND_FAILED on stream write failure (phase 1120)', () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    (createDirContext as any).mockReturnValue({
      fs: {
        appendSync: vi.fn(() => { throw new Error('disk full'); }),
        resolve: vi.fn((p: string) => path.resolve(p)),
      },
      audit,
    });

    const contract: ContractYaml = {
      title: 'T', goal: 'G', subtasks: [],
    };

    expect(() => notifyContractCreated({ fsFactory }, '/tmp/claw', 'claw-A', 'c-002', contract, '/tmp/chestnut')).not.toThrow();

    const streamFailedCalls = audit.write.mock.calls.filter(c => c[0] === 'stream_append_failed');
    expect(streamFailedCalls).toHaveLength(1);
    const call = streamFailedCalls[0];
    expect(call[0]).toBe('stream_append_failed');
    expect(call[1]).toBe('path=stream.jsonl');
    expect(call[2]).toBe('type=user_notify');
    expect(call[3]).toMatch(/reason=disk full/);
    expect(call[4]).toMatch(/body=.*"contractId":"c-002"/);
  });
});

describe('phase 906 Step B1: contract.ts cause chain + ENOENT narrow', () => {
  const contractPath = path.join(__dirname, '../../src/cli/commands/contract-show.ts');
  const sourceCode = fs.readFileSync(contractPath, 'utf-8');

  it('contractShowCommand catch 块保留 Error cause chain', () => {
    const idx = sourceCode.indexOf('readContractYamlRaw');
    expect(idx).toBeGreaterThan(-1);
    const block = sourceCode.slice(idx, idx + 800);
    // catch (err) 存在
    expect(block).toMatch(/catch\s*\(err\)\s*\{/);
    // { cause: err } 存在（ES2022 Error cause chain）
    expect(block).toContain('{ cause: err }');
    // 旧 reason 拼接模式已移除
    expect(block).not.toContain('err instanceof Error ? err.message : String(err)');
  });

  it('progress read catch narrow 到 ENOENT only', () => {
    const idx = sourceCode.indexOf('progress = await manager.getProgress');
    expect(idx).toBeGreaterThan(-1);
    const block = sourceCode.slice(idx, idx + 600);
    // catch (err) 存在
    expect(block).toMatch(/catch\s*\(err\)\s*\{/);
    // ENOENT / FS_NOT_FOUND narrow 存在（phase 1215: 改用 isFileNotFound 双码 narrow）
    expect(block).toContain('isFileNotFound(err)');
    // 非 ENOENT 时 throw err
    expect(block).toContain('throw err');
  });

  it('CliError 类已 align 支持 { cause } 透传', () => {
    const errPath = path.join(__dirname, '../../src/cli/errors.ts');
    const errCode = fs.readFileSync(errPath, 'utf-8');
    expect(errCode).toContain('cause?: unknown');
    expect(errCode).toContain('super(message, optionsOrCode)');
  });
});
