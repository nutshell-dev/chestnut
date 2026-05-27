/**
 * Runtime.initialize() failure audit tests — phase155B / restored phase155E
 *
 * Covers:
 * - sessionManager.save(repaired) failure → precise audit + rethrow
 * - inboxReader.init() failure → precise audit + rethrow
 * - snapshot.commit('session-repair') unhandled failure → audit only, no throw
 *
 * 遗留：本文件 makeDeps helper 仍是 phase155B sync + 7 字段 + `dependencies: deps as any`
 * 形态。phase155C 新契约下 `as any` 是类型破口，应整体迁移到 makeRuntimeDeps
 *（tests/helpers/runtime-deps.ts）消除类型绕过。独立 phase 处理。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Runtime } from '../../src/core/runtime/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { DialogStore } from '../../src/foundation/dialog-store/index.js';
import { Snapshot } from '../../src/foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../../src/assembly/snapshot-patterns.js';
import { InboxReader } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';

import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../src/foundation/messaging/dirs.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Runtime.initialize() failure audits', () => {
  async function makeDeps(clawDir: string, overrides: { sessionManager?: DialogStore; inboxReader?: InboxReader } = {}) {
    const systemFs = new NodeFileSystem({ baseDir: clawDir });
    const clawFs = new NodeFileSystem({ baseDir: clawDir });
    const auditWriter = new AuditWriter(systemFs, 'audit.tsv', null);

    const snapshot = new Snapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
    vi.spyOn(snapshot, 'init').mockResolvedValue({ ok: true } as any);
    vi.spyOn(snapshot, 'commit').mockResolvedValue({ ok: true } as any);

    const sessionManager = overrides.sessionManager ?? new DialogStore(systemFs, 'dialog', auditWriter, 'current.json', 'test-claw');
    const inboxReader = overrides.inboxReader ?? new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, systemFs, auditWriter);
    const outboxWriter = createOutboxWriter('test-claw', clawDir, systemFs, auditWriter);

    return {
      systemFs, clawFs, auditWriter, snapshot, sessionManager, inboxReader, outboxWriter,
    };
  }

  function minimalMocks() {
    return {
      llm: { close: vi.fn().mockResolvedValue(undefined) } as any,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue(''),
      } as any,
      toolExecutor: {} as any,
      contractManager: {} as any,
      taskSystem: {
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as any,
      contextInjector: {} as any,
      execContext: {} as any,
    };
  }

  it('sessionManager.save failure audits module=session_manager phase=session_repair_save and rethrows', async () => {
    const clawDir = path.join(tmpdir(), `runtime-fail-test-${randomUUID()}`, 'claws', 'test');
    await fs.mkdir(clawDir, { recursive: true });

    const deps = await makeDeps(clawDir);
    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    // Mock sessionManager.load to return a session that needs repair
    vi.spyOn(deps.sessionManager, 'load').mockResolvedValue({
      session: {
        messages: [
          { role: 'assistant', content: 'ok', tool_use: { id: 't1', name: 'test', input: {} } },
        ],
      },
      source: 'current',
    } as any);

    // Mock DialogStore.repair to return toolCount > 0 so save() is triggered
    vi.spyOn(DialogStore, 'repair').mockReturnValue({ repaired: [], toolCount: 1 } as any);

    // Mock sessionManager.save to throw
    const saveError = new Error('ENOSPC: no space left on device');
    vi.spyOn(deps.sessionManager, 'save').mockRejectedValue(saveError);

    const mocks = minimalMocks();
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: { primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' }, maxAttempts: 1, retryDelayMs: 0 },
      dependencies: { ...deps, ...mocks } as any,
    });

    await expect(runtime.initialize()).rejects.toThrow('ENOSPC: no space left on device');

    const sessionRepairFailedCall = auditSpy.mock.calls.find(c => c[0] === 'runtime_session_repair_failed');
    expect(sessionRepairFailedCall).toBeDefined();
    expect(sessionRepairFailedCall![1]).toContain('ENOSPC');

    // Cleanup
    await fs.rm(path.dirname(path.dirname(clawDir)), { recursive: true, force: true }).catch(() => {});
  });

  it('inboxReader.init failure audits module=inbox_reader phase=init and rethrows', async () => {
    const clawDir = path.join(tmpdir(), `runtime-fail-test-${randomUUID()}`, 'claws', 'test');
    await fs.mkdir(clawDir, { recursive: true });

    const deps = await makeDeps(clawDir);
    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    // Mock inboxReader.init to throw
    const initError = new Error('ensureDir EACCES');
    vi.spyOn(deps.inboxReader, 'init').mockRejectedValue(initError);

    const mocks = minimalMocks();
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: { primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' }, maxAttempts: 1, retryDelayMs: 0 },
      dependencies: { ...deps, ...mocks } as any,
    });

    await expect(runtime.initialize()).rejects.toThrow('ensureDir EACCES');

    const inboxInitFailedCall = auditSpy.mock.calls.find(c => c[0] === 'runtime_inbox_init_failed');
    expect(inboxInitFailedCall).toBeDefined();
    expect(inboxInitFailedCall![1]).toContain('EACCES');

    // Cleanup
    await fs.rm(path.dirname(path.dirname(clawDir)), { recursive: true, force: true }).catch(() => {});
  });

  it('snapshot.commit session-repair failure writes snapshot_commit_failed and does not throw', async () => {
    const clawDir = path.join(tmpdir(), `runtime-fail-test-${randomUUID()}`, 'claws', 'test');
    await fs.mkdir(clawDir, { recursive: true });

    const deps = await makeDeps(clawDir);
    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    // Mock sessionManager.load to return a session that needs repair
    vi.spyOn(deps.sessionManager, 'load').mockResolvedValue({
      session: {
        messages: [
          { role: 'assistant', content: 'ok', tool_use: { id: 't1', name: 'test', input: {} } },
        ],
      },
      source: 'current',
    } as any);

    // Mock DialogStore.repair to return toolCount > 0 so save() and commit() are triggered
    vi.spyOn(DialogStore, 'repair').mockReturnValue({ repaired: [], toolCount: 1 } as any);

    // Mock snapshot.commit to throw (unhandled failure path)
    const commitError = new Error('git write-tree failed');
    vi.spyOn(deps.snapshot, 'commit').mockRejectedValue(commitError);

    const mocks = minimalMocks();
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: { primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' }, maxAttempts: 1, retryDelayMs: 0 },
      dependencies: { ...deps, ...mocks } as any,
    });

    // Should NOT throw — commit error is caught internally
    await expect(runtime.initialize()).resolves.not.toThrow();

    const snapshotCommitFailedCall = auditSpy.mock.calls.find(c => c[0] === 'snapshot_commit_failed');
    expect(snapshotCommitFailedCall).toBeDefined();
    expect(snapshotCommitFailedCall![1]).toContain('context=session-repair');
    expect(snapshotCommitFailedCall![2]).toContain('git write-tree failed');

    // session_repaired should still have been written before commit
    const sessionRepairedCall = auditSpy.mock.calls.find(c => c[0] === 'session_repaired');
    expect(sessionRepairedCall).toBeDefined();
    expect(sessionRepairedCall![1]).toMatch(/^tools=\d+$/);

    // Cleanup
    await fs.rm(path.dirname(path.dirname(clawDir)), { recursive: true, force: true }).catch(() => {});
  });
});
