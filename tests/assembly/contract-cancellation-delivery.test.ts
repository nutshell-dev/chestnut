import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createContractCancellationDelivery } from '../../src/assembly/contract-cancellation-delivery.js';
import { makeContractId } from '../../src/core/contract/types.js';
import { makeClawNotifyTargetResolver } from '../../src/core/claw-topology/index.js';
import { createClawNotifier } from '../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeMockAudit } from '../helpers/audit.js';

describe('Phase 2091: Assembly cancellation delivery', () => {
  let chestnutRoot: string;

  beforeEach(async () => {
    chestnutRoot = await createTrackedTempDir('phase2091-assembly-delivery-');
  });

  afterEach(async () => {
    await cleanupTempDir(chestnutRoot);
  });

  it.each([
    { clawId: 'worker-1', relativeDir: path.join('claws', 'worker-1') },
    { clawId: 'motion', relativeDir: 'motion' },
  ])('uses real Messaging, template, and guidance codec for $clawId', async ({ clawId, relativeDir }) => {
    const targetDir = path.join(chestnutRoot, relativeDir);
    await fs.mkdir(targetDir, { recursive: true });
    const notifier = createClawNotifier({
      fs: new NodeFileSystem({ baseDir: chestnutRoot }),
      audit: makeMockAudit(),
      resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
    });
    const deliver = createContractCancellationDelivery({
      clawId,
      notifyAsync: (target, message) => notifier.notifyAsync(target, message),
    });

    await deliver({
      type: 'contract_cancelled',
      contractId: makeContractId('contract-1'),
      reason: 'user requested abort',
    });

    const pendingDir = path.join(targetDir, 'inbox', 'pending');
    const files = await fs.readdir(pendingDir);
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(pendingDir, files[0]), 'utf8');
    expect(content).toContain('type: contract_cancelled');
    expect(content).toContain('from: "system"');
    expect(content).toContain('priority: high');
    expect(content).toContain('id: contract:contract-1:cancelled');
    expect(content).toContain('契约已取消｜contract-1');
    expect(content).toContain(`执行者：${clawId}`);
    expect(content).toContain('取消原因：user requested abort');
    expect(content).toContain('guidance_schema_version: 1');
    expect(content).toContain(
      `cancelled_contract_refs: "[{\\"claw_id\\":\\"${clawId}\\",\\"contract_id\\":\\"contract-1\\"}]"`,
    );
  });

  it('rejects a missing target through the real throwing transport', async () => {
    const notifier = createClawNotifier({
      fs: new NodeFileSystem({ baseDir: chestnutRoot }),
      audit: makeMockAudit(),
      resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
    });
    const deliver = createContractCancellationDelivery({
      clawId: 'missing-worker',
      notifyAsync: (target, message) => notifier.notifyAsync(target, message),
    });

    await expect(deliver({
      type: 'contract_cancelled',
      contractId: makeContractId('contract-1'),
      reason: 'stop',
    })).rejects.toThrow('Target claw root does not exist');
  });

  it('awaits and propagates the original transport rejection', async () => {
    const failure = new Error('INBOX_WRITE_EIO');
    const notifyAsync = vi.fn(async () => { throw failure; });
    const deliver = createContractCancellationDelivery({
      clawId: 'worker-1',
      notifyAsync,
    });

    await expect(deliver({
      type: 'contract_cancelled',
      contractId: makeContractId('contract-1'),
      reason: 'stop',
    })).rejects.toBe(failure);
    expect(notifyAsync).toHaveBeenCalledWith('worker-1', expect.objectContaining({
      messageId: 'contract:contract-1:cancelled',
    }));
  });
});
