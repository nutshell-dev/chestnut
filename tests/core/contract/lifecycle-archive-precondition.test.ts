/**
 * Phase 1198 Step E: completed precondition failure must preserve all request facts.
 *
 * Reverse acceptance migrated from the deleted phase 1132 precondition suite:
 * when the completed precondition fails, `archiveAndEmit` must
 *   1. leave the immutable completed intent on disk (boot can observe the request);
 *   2. keep the active contract directory in place (no rename happened);
 *   3. leave progress.json bytes completely untouched (terminal lifecycle does
 *      not mutate progress before/without the directory rename).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createManagerVerificationContext } from '../../helpers/contract-subtask.js';
import { archiveAndEmit } from '../../../src/core/contract/verification-lifecycle.js';
import { readLifecycleIntentsForContract } from '../../../src/core/contract/lifecycle-intent.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { ContractId } from '../../../src/core/contract/types.js';

describe('Phase 1198 Step E: completed precondition failure preserves request facts', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  /** phase 1872 Step F: 构造期 onNotify holder（测试在断言前指向当次收集器）。 */
  let onNotifySink: ((event: { type: string }) => void) | undefined;
  let auditTypes: string[];

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    auditTypes = [];
    onNotifySink = undefined;
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: new NodeFileSystem({ baseDir: clawDir }),
      audit: {
        write: (type: string) => {
          auditTypes.push(type);
        },
      } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: path.join(tempDir, 'claws'),
      notifyClaw: () => Promise.resolve(),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('precondition failure: intent persisted, active kept, progress bytes untouched', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Precondition Not Met',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
    }));

    const activeRoot = path.join(clawDir, 'contract', 'active', contractId);
    const progressPath = path.join(activeRoot, 'progress.json');
    const progressBytesBefore = await fs.readFile(progressPath, 'utf-8');

    const notifyEvents: string[] = [];
    onNotifySink = (type) => notifyEvents.push(type);

    const ctx = createManagerVerificationContext(manager);
    const yaml = await ctx.loadContractYaml(contractId);
    if (!yaml) throw new Error('missing contract yaml');

    // No subtask is completed -> completed precondition fails.
    const result = await archiveAndEmit(ctx, contractId, yaml, 'precondition.reverse');
    expect(result).toEqual({ archived: false });

    // 1. The immutable completed intent is persisted for boot observation.
    const { intents, issues } = await readLifecycleIntentsForContract(
      new NodeFileSystem({ baseDir: clawDir }),
      { write: () => {} } as any,
      clawDir,
      contractId as ContractId,
    );
    expect(issues).toEqual([]);
    expect(intents).toHaveLength(1);
    expect(intents[0].requested_state).toBe('completed');

    // 2. The active contract directory still exists; nothing was archived.
    await expect(fs.access(activeRoot)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(clawDir, 'contract', 'archive', 'completed', contractId)),
    ).rejects.toBeTruthy();

    // 3. progress.json bytes are completely unchanged.
    const progressBytesAfter = await fs.readFile(progressPath, 'utf-8');
    expect(progressBytesAfter).toBe(progressBytesBefore);

    // Failure is audited as a move-archive failure, never as completion.
    expect(auditTypes).toContain(CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
    expect(auditTypes).not.toContain(CONTRACT_AUDIT_EVENTS.COMPLETED);
    expect(notifyEvents).not.toContain('contract_completed');
  });
});
