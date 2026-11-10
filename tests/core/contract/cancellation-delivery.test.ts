import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import type {
  ContractCancelledEvent,
  CancellationDelivery,
} from '../../../src/core/contract/cancellation-delivery.js';
import type { ContractNotification } from '../../../src/core/contract/notification.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeMockAudit } from '../../helpers/audit.js';

describe('Phase 2091: ContractSystem cancellation delivery', () => {
  let tempDir: string;
  let clawDir: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('phase2091-delivery-');
    clawDir = path.join(tempDir, 'claws', 'worker-1');
    await fs.mkdir(clawDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  function makeManager(opts: {
    deliverCancellation: CancellationDelivery;
    onNotify?: (event: ContractNotification) => void;
    audit?: AuditLog;
  }): ContractSystem {
    return new ContractSystem({
      clawDir,
      clawId: 'worker-1',
      fs: new NodeFileSystem({ baseDir: clawDir }),
      audit: opts.audit ?? makeMockAudit(),
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      notifyClaw: vi.fn(),
      deliverCancellation: opts.deliverCancellation,
      onNotify: opts.onNotify,
    });
  }

  it('delivers after a committed cancel without an observer sink', async () => {
    const deliverCancellation = vi.fn(async (_event: ContractCancelledEvent) => {});
    const manager = makeManager({ deliverCancellation });
    const contractId = await manager.create(makeContractYaml());

    const outcome = await manager.cancel(makeContractId(contractId), 'user requested abort');

    expect(outcome.commit.kind).toBe('committed');
    expect(outcome.cancellationDelivery).toEqual({ kind: 'delivered' });
    expect(deliverCancellation).toHaveBeenCalledTimes(1);
    expect(deliverCancellation).toHaveBeenCalledWith({
      type: 'contract_cancelled',
      contractId,
      reason: 'user requested abort',
    });
  });

  it('keeps the cancelled state and original transport error when delivery fails', async () => {
    const deliveryError = new Error('INBOX_WRITE_EIO');
    const deliverCancellation = vi.fn(async () => { throw deliveryError; });
    const onNotify = vi.fn();
    const audit = makeMockAudit();
    const manager = makeManager({ deliverCancellation, onNotify, audit });
    const contractId = await manager.create(makeContractYaml());
    onNotify.mockClear();

    const outcome = await manager.cancel(makeContractId(contractId), 'stop');

    expect(outcome.commit.kind).toBe('committed');
    expect(outcome.cancellationDelivery).toEqual({ kind: 'failed', cause: deliveryError });
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
      'notify_type=contract_cancelled',
      'error=INBOX_WRITE_EIO',
    );
    await expect(fs.access(path.join(
      clawDir, 'contract', 'archive', 'cancelled', contractId,
    ))).resolves.toBeUndefined();
  });

  it('attempts business delivery before a throwing observer and delivers only once', async () => {
    const calls: string[] = [];
    const deliverCancellation = vi.fn(async () => { calls.push('delivery'); });
    const audit = makeMockAudit();
    const manager = makeManager({
      deliverCancellation,
      audit,
      onNotify: (event) => {
        if (event.type !== 'contract_cancelled') return;
        calls.push('observer');
        throw new Error('STREAM_WRITE_EIO');
      },
    });
    const contractId = await manager.create(makeContractYaml());

    const outcome = await manager.cancel(makeContractId(contractId), 'stop');

    expect(outcome.cancellationDelivery).toEqual({ kind: 'delivered' });
    expect(calls).toEqual(['delivery', 'observer']);
    expect(deliverCancellation).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
      'notify_type=contract_cancelled',
      'error=STREAM_WRITE_EIO',
    );
  });

  it('preserves delivery, observer, and audit diagnostics when failure reporting also throws', async () => {
    const deliveryError = new Error('DELIVERY_EIO');
    const observerError = new Error('OBSERVER_EIO');
    const auditError = new Error('AUDIT_EIO');
    const audit = makeMockAudit();
    vi.mocked(audit.write).mockImplementation((type: string) => {
      if (type === CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED) throw auditError;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const manager = makeManager({
      deliverCancellation: async () => { throw deliveryError; },
      onNotify: (event) => { if (event.type === 'contract_cancelled') throw observerError; },
      audit,
    });
    const contractId = await manager.create(makeContractYaml());

    const outcome = await manager.cancel(makeContractId(contractId), 'stop');

    expect(outcome.commit.kind).toBe('committed');
    if (outcome.cancellationDelivery.kind !== 'failed') {
      throw new Error('expected failed cancellation delivery');
    }
    expect(outcome.cancellationDelivery.cause).toBeInstanceOf(AggregateError);
    const aggregate = outcome.cancellationDelivery.cause as AggregateError;
    expect(aggregate.errors).toEqual([deliveryError, auditError]);
    const diagnostics = stderr.mock.calls.map(call => String(call[0])).join('');
    expect(diagnostics).toContain('DELIVERY_EIO');
    expect(diagnostics).toContain('OBSERVER_EIO');
    expect(diagnostics).toContain('AUDIT_EIO');
  });

  it('does not deliver or observe again for already_committed or retryable_failure', async () => {
    const deliverCancellation = vi.fn(async () => {});
    const onNotify = vi.fn();
    const manager = makeManager({ deliverCancellation, onNotify });
    const contractId = await manager.create(makeContractYaml());
    onNotify.mockClear();

    await manager.cancel(makeContractId(contractId), 'first');
    const repeated = await manager.cancel(makeContractId(contractId), 'second');
    const missing = await manager.cancel(makeContractId('missing'), 'missing');

    expect(repeated.commit.kind).toBe('already_committed');
    expect(repeated.cancellationDelivery).toEqual({ kind: 'not_attempted' });
    expect(missing.commit.kind).toBe('retryable_failure');
    expect(missing.cancellationDelivery).toEqual({ kind: 'not_attempted' });
    expect(deliverCancellation).toHaveBeenCalledTimes(1);
    expect(deliverCancellation).toHaveBeenCalledWith(expect.objectContaining({ reason: 'first' }));
    expect(onNotify).toHaveBeenCalledTimes(1);
  });

  it('allows only the committed race winner to deliver and observe', async () => {
    const deliverA = vi.fn(async () => {});
    const deliverB = vi.fn(async () => {});
    const observeA = vi.fn();
    const observeB = vi.fn();
    const managerA = makeManager({ deliverCancellation: deliverA, onNotify: observeA });
    const managerB = makeManager({ deliverCancellation: deliverB, onNotify: observeB });
    const contractId = await managerA.create(makeContractYaml());
    observeA.mockClear();
    observeB.mockClear();

    const outcomes = await Promise.all([
      managerA.cancel(makeContractId(contractId), 'A'),
      managerB.cancel(makeContractId(contractId), 'B'),
    ]);

    expect(outcomes.filter(outcome => outcome.commit.kind === 'committed')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.commit.kind === 'already_committed')).toHaveLength(1);
    expect(deliverA.mock.calls.length + deliverB.mock.calls.length).toBe(1);
    expect(observeA.mock.calls.length + observeB.mock.calls.length).toBe(1);
    for (const outcome of outcomes) {
      expect(outcome.cancellationDelivery.kind).toBe(
        outcome.commit.kind === 'committed' ? 'delivered' : 'not_attempted',
      );
    }
  });
});
