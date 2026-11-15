import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import type { CancellationDelivery } from '../../../src/core/contract/cancellation-delivery.js';
import type { CancellationDeliveryRecord } from '../../../src/core/contract/index.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { createContractCancellationDelivery } from '../../../src/assembly/contract-cancellation-delivery.js';
import { makeClawNotifyTargetResolver } from '../../../src/core/claw-topology/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  createClawNotifier,
  createInboxReader,
  writeInboxAsync,
} from '../../../src/foundation/messaging/index.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeMockAudit } from '../../helpers/audit.js';

describe('Phase 2151 B4: durable cancellation delivery recovery', () => {
  let root: string;
  let clawDir: string;
  let audit: ReturnType<typeof makeMockAudit>;

  beforeEach(async () => {
    root = await createTrackedTempDir('phase2151-cancel-recovery-');
    clawDir = path.join(root, 'claws', 'worker-1');
    await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
    audit = makeMockAudit();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(root);
  });

  function realDelivery(): CancellationDelivery {
    const notifier = createClawNotifier({
      fs: new NodeFileSystem({ baseDir: root }),
      audit,
      resolveTarget: makeClawNotifyTargetResolver(root),
    });
    return createContractCancellationDelivery({
      clawId: 'worker-1',
      notifyAsync: (target, message) => notifier.notifyAsync(target, message),
    });
  }

  function makeManager(
    deliverCancellation: CancellationDelivery = realDelivery(),
    fsImpl = new NodeFileSystem({ baseDir: clawDir }),
  ): ContractSystem {
    return new ContractSystem({
      clawDir,
      clawId: 'worker-1',
      fs: fsImpl,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      notifyClaw: vi.fn(),
      deliverCancellation,
    });
  }

  async function readRecord(contractId: string): Promise<CancellationDeliveryRecord> {
    return JSON.parse(await fs.readFile(
      path.join(clawDir, 'contract', 'cancellation-delivery', `${contractId}.json`),
      'utf8',
    )) as CancellationDeliveryRecord;
  }

  async function writeDeliveryState(
    contractId: string,
    delivery: CancellationDeliveryRecord['delivery'],
  ): Promise<void> {
    const record = await readRecord(contractId);
    await fs.writeFile(
      path.join(clawDir, 'contract', 'cancellation-delivery', `${contractId}.json`),
      JSON.stringify({ ...record, delivery }, null, 2),
    );
  }

  async function pendingFiles(): Promise<string[]> {
    return (await fs.readdir(path.join(clawDir, 'inbox', 'pending'))).filter(name => name.endsWith('.md'));
  }

  it('persists stop_requested before the terminal rename and never treats it as confirmed', async () => {
    const fsImpl = new NodeFileSystem({ baseDir: clawDir });
    const writeAtomic = fsImpl.writeAtomic.bind(fsImpl);
    let initial: CancellationDeliveryRecord | undefined;
    vi.spyOn(fsImpl, 'writeAtomic').mockImplementation(async (target: string, content: string) => {
      if (!initial && target.includes('cancellation-delivery')) {
        initial = JSON.parse(content) as CancellationDeliveryRecord;
      }
      return writeAtomic(target, content);
    });
    const manager = makeManager(realDelivery(), fsImpl);
    const contractId = await manager.create(makeContractYaml());

    await manager.cancel(makeContractId(contractId), 'stop');

    expect(initial).toMatchObject({
      delivery: { kind: 'pending' },
      stop: { kind: 'stop_requested' },
    });
    expect((await readRecord(contractId)).stop.kind).toBe('stop_unknown');
  });

  it('committed then already_committed retains one stable physical delivery', async () => {
    const manager = makeManager();
    const contractId = await manager.create(makeContractYaml());

    const committed = await manager.cancel(makeContractId(contractId), 'first reason');
    const firstRecord = await readRecord(contractId);
    const repeated = await manager.cancel(makeContractId(contractId), 'must not replace first reason');

    expect(committed.commit.kind).toBe('committed');
    expect(repeated.commit.kind).toBe('already_committed');
    expect(repeated.cancellationDelivery).toEqual({ kind: 'delivered' });
    expect(await pendingFiles()).toHaveLength(1);
    expect(await readRecord(contractId)).toMatchObject({
      intentId: firstRecord.intentId,
      deliveryId: `contract:${contractId}:cancelled:v2`,
      reason: 'first reason',
      delivery: { kind: 'confirmed' },
      stop: { kind: 'stop_unknown' },
    });
    expect(await manager.confirmCancellationStop(
      makeContractId(contractId),
      'legacy-unkeyed-id',
      'abort',
    )).toBe(false);
    expect((await readRecord(contractId)).stop.kind).toBe('stop_unknown');
    expect(await manager.confirmCancellationStop(
      makeContractId(contractId),
      firstRecord.deliveryId,
      'abort',
    )).toBe(true);
    expect((await readRecord(contractId)).stop).toMatchObject({
      kind: 'stop_confirmed',
      evidence: 'abort',
    });
  });

  it('recovers a post-rename crash and retries already_committed without replacing identity', async () => {
    const queryError = new Error('INBOX_QUERY_EIO');
    const first = makeManager(async () => { throw queryError; });
    const contractId = await first.create(makeContractYaml());

    const failed = await first.cancel(makeContractId(contractId), 'stop');
    const failedRecord = await readRecord(contractId);
    expect(failed.commit.kind).toBe('committed');
    expect(failedRecord.delivery).toMatchObject({ kind: 'unknown', stage: 'delivery' });
    expect(failedRecord.stop.kind).not.toBe('stop_confirmed');
    await expect(fs.access(path.join(clawDir, 'contract', 'archive', 'cancelled', contractId)))
      .resolves.toBeUndefined();

    // Restart after the terminal rename: the pre-rename record drives recovery.
    const restarted = makeManager();
    await restarted.init();
    expect(await pendingFiles()).toHaveLength(1);
    expect((await readRecord(contractId)).deliveryId).toBe(failedRecord.deliveryId);

    const repeated = await restarted.cancel(makeContractId(contractId), 'different retry reason');
    expect(repeated.commit.kind).toBe('already_committed');
    expect(repeated.cancellationDelivery).toEqual({ kind: 'delivered' });
    expect(await pendingFiles()).toHaveLength(1);
    await restarted.init();
    expect(await pendingFiles()).toHaveLength(1);
  });

  it('reconciles message_written against done history instead of writing a replacement', async () => {
    const manager = makeManager();
    const contractId = await manager.create(makeContractYaml());
    await manager.cancel(makeContractId(contractId), 'stop');

    const reader = createInboxReader(new NodeFileSystem({ baseDir: clawDir }), audit, clawDir);
    await reader.init();
    const drained = await reader.drainAndDeliver();
    for (const handle of drained.handles) await reader.ack(handle);
    expect(await pendingFiles()).toHaveLength(0);
    await writeDeliveryState(contractId, {
      kind: 'message_written',
      updatedAt: new Date().toISOString(),
    });

    await makeManager().init();

    expect(await pendingFiles()).toHaveLength(0);
    expect((await readRecord(contractId)).delivery.kind).toBe('confirmed');
    expect(await fs.readdir(path.join(clawDir, 'inbox', 'done'))).toHaveLength(1);
  });

  it('keeps terminal-query failure unknown and retries it on a later boot', async () => {
    const first = makeManager(async () => { throw new Error('INBOX_WRITE_UNKNOWN'); });
    const contractId = await first.create(makeContractYaml());
    await first.cancel(makeContractId(contractId), 'stop');

    const fsImpl = new NodeFileSystem({ baseDir: clawDir });
    const stat = fsImpl.stat.bind(fsImpl);
    let injected = false;
    vi.spyOn(fsImpl, 'stat').mockImplementation(async (target: string) => {
      if (!injected && target.includes(path.join('archive', 'cancelled', contractId))) {
        injected = true;
        throw new Error('TERMINAL_QUERY_EIO');
      }
      return stat(target);
    });

    await makeManager(realDelivery(), fsImpl).init();
    const unknown = await readRecord(contractId);
    expect(unknown.delivery).toMatchObject({ kind: 'unknown', stage: 'terminal_query' });
    expect(await pendingFiles()).toHaveLength(0);

    vi.restoreAllMocks();
    await makeManager().init();
    expect((await readRecord(contractId)).delivery.kind).toBe('confirmed');
    expect(await pendingFiles()).toHaveLength(1);
  });

  it('does not mistake a legacy unkeyed envelope for the current delivery', async () => {
    const manager = makeManager();
    const contractId = await manager.create(makeContractYaml());
    const fsImpl = new NodeFileSystem({ baseDir: clawDir });
    await writeInboxAsync(fsImpl, clawDir, {
      id: `contract:${contractId}:cancelled`,
      type: 'contract_cancelled',
      from: 'system',
      to: '',
      priority: 'high',
      content: 'legacy cancellation without a delivery key',
      timestamp: new Date().toISOString(),
    }, audit);

    await manager.cancel(makeContractId(contractId), 'stop');

    const files = await pendingFiles();
    expect(files).toHaveLength(2);
    const contents = await Promise.all(files.map(name =>
      fs.readFile(path.join(clawDir, 'inbox', 'pending', name), 'utf8')));
    expect(contents.some(content => content.includes(`id: contract:${contractId}:cancelled\n`))).toBe(true);
    expect(contents.some(content =>
      content.includes(`id: contract:${contractId}:cancelled:v2`) &&
      content.includes('contract_cancellation_delivery_id:') && content.includes(`${contractId}:cancelled:v2`),
    )).toBe(true);
  });
});
