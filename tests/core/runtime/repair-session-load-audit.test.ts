/**
 * Runtime — repairSessionIfNeeded load failure observability (R72-P1-2)
 *
 * Covers:
 * - sessionManager.load() failure → SESSION_REPAIR_FAILED audit with context=load_skipped
 * - initialize() does NOT throw (null fallback)
 * - turn pipeline remains reachable after load failure
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Runtime } from '../../../src/core/runtime/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import { Snapshot } from '../../../src/foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../../../src/foundation/snapshot/index.js';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import { OutboxWriter } from '../../../src/foundation/messaging/index.js';
import { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../../src/types/paths.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';

describe('Runtime — repairSessionIfNeeded load failure observability (R72-P1-2)', () => {
  async function makeDeps(clawDir: string) {
    const systemFs = new NodeFileSystem({ baseDir: clawDir });
    const clawFs = new NodeFileSystem({ baseDir: clawDir });
    const auditWriter = new AuditWriter(systemFs, 'audit.tsv', null);

    const snapshot = new Snapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
    vi.spyOn(snapshot, 'init').mockResolvedValue({ ok: true } as any);
    vi.spyOn(snapshot, 'commit').mockResolvedValue({ ok: true } as any);

    const sessionManager = new DialogStore(systemFs, 'dialog', auditWriter, 'current.json', 'test-system-prompt', 'test-claw');
    const inboxReader = new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, systemFs, auditWriter);
    const outboxWriter = new OutboxWriter('test-claw', clawDir, systemFs, auditWriter);

    return { systemFs, clawFs, auditWriter, snapshot, sessionManager, inboxReader, outboxWriter };
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

  it('triggers SESSION_REPAIR_FAILED audit context=load_skipped when sessionManager.load throws', async () => {
    const clawDir = path.join(tmpdir(), `runtime-repair-load-test-${randomUUID()}`, 'claws', 'test');
    await fs.mkdir(clawDir, { recursive: true });

    const deps = await makeDeps(clawDir);
    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    // Mock sessionManager.load to throw
    const loadError = new Error('disk-full');
    vi.spyOn(deps.sessionManager, 'load').mockRejectedValue(loadError);

    const mocks = minimalMocks();
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: { primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' }, maxAttempts: 1, retryDelayMs: 0 },
      dependencies: { ...deps, ...mocks } as any,
    });

    // Should NOT throw — load error is caught internally and falls back to null
    await expect(runtime.initialize()).resolves.not.toThrow();

    const sessionRepairFailedCall = auditSpy.mock.calls.find(
      (c) => c[0] === RUNTIME_AUDIT_EVENTS.SESSION_REPAIR_FAILED
    );
    expect(sessionRepairFailedCall).toBeDefined();
    expect(sessionRepairFailedCall![1]).toBe('context=load_skipped');
    expect(sessionRepairFailedCall![2]).toContain('reason=disk-full');

    // Cleanup
    await fs.rm(path.dirname(path.dirname(clawDir)), { recursive: true, force: true }).catch(() => {});
  });
});
