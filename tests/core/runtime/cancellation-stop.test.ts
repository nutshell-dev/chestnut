import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type { RuntimeCancellationStop } from '../../../src/core/runtime/types.js';
import {
  CONTRACT_CANCELLATION_DELIVERY_META_KEY,
  CONTRACT_INBOX_MESSAGE_TYPES,
  encodeContractCancelledGuidance,
  makeContractId,
} from '../../../src/core/contract/index.js';
import { makeClawId } from '../../../src/foundation/claw-identity/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import {
  createInboxMessageTypeRegistry,
  createInboxReader,
  createInboxWriter,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeMockAudit } from '../../helpers/audit.js';

class StopTestRuntime extends Runtime {
  injectForTest(reader: unknown, audit: unknown): void {
    (this as unknown as Record<string, unknown>).inboxReader = reader;
    (this as unknown as Record<string, unknown>).auditWriter = audit;
    (this as unknown as Record<string, unknown>).execContext = { trace_id: undefined };
  }

  installAbortController(controller: AbortController): void {
    (this as unknown as Record<string, unknown>).currentAbortController = controller;
  }
}

describe('Phase 2151 B4: Runtime cancellation stop evidence', () => {
  let root: string;
  let audit: ReturnType<typeof makeMockAudit>;
  let stop: RuntimeCancellationStop;

  beforeEach(async () => {
    root = await createTrackedTempDir('phase2151-runtime-stop-');
    audit = makeMockAudit();
    stop = {
      noteCancellationStop: vi.fn(async () => true),
      confirmCancellationStop: vi.fn(async () => true),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(root);
  });

  function makeRuntime(): StopTestRuntime {
    const formatterRegistry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(formatterRegistry, CONTRACT_INBOX_MESSAGE_TYPES);
    const runtime = new StopTestRuntime({
      clawId: 'worker-1',
      clawDir: root,
      idleTimeoutMs: 0,
      llmConfig: {
        primary: { name: 'mock', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
      },
      dependencies: { cancellationStop: stop, formatterRegistry },
    } as never);
    runtime.injectForTest(createInboxReader(new NodeFileSystem({ baseDir: root }), audit, root), audit);
    return runtime;
  }

  async function writeKeyedCancellation(): Promise<void> {
    createInboxWriter(new NodeFileSystem({ baseDir: root }), root, audit, {
      bodyMaxBytes: 64 * 1024,
    }).writeSync({
      type: 'contract_cancelled',
      source: 'system',
      priority: 'high',
      messageId: 'contract:c-1:cancelled:v2',
      body: 'cancelled',
      metadata: { contract_id: 'c-1' },
      extraFields: {
        ...encodeContractCancelledGuidance([{
          clawId: makeClawId('worker-1'),
          contractId: makeContractId('c-1'),
        }]),
        [CONTRACT_CANCELLATION_DELIVERY_META_KEY]: 'contract:c-1:cancelled:v2',
      },
    });
  }

  it('delivery without an explicit abort records only stop_unknown evidence', async () => {
    await writeKeyedCancellation();
    const runtime = makeRuntime();

    const prepared = await runtime.prepareInbox();
    const formatted = await runtime.formatPreparedInbox(prepared);
    await runtime.recheckFormattedInbox(formatted);

    expect(prepared.entries).toHaveLength(1);
    expect(stop.noteCancellationStop).toHaveBeenCalledWith(
      makeContractId('c-1'),
      'contract:c-1:cancelled:v2',
      'observed_without_abort',
    );
    expect(stop.noteCancellationStop).toHaveBeenCalledWith(
      makeContractId('c-1'),
      'contract:c-1:cancelled:v2',
      'injected_without_abort_confirmation',
    );
    expect(stop.confirmCancellationStop).not.toHaveBeenCalled();
  });

  it('an explicit abort of an active turn is the only path to stop_confirmed', async () => {
    await writeKeyedCancellation();
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.installAbortController(controller);

    await runtime.prepareInbox();

    expect(controller.signal.aborted).toBe(true);
    expect(stop.confirmCancellationStop).toHaveBeenCalledWith(
      makeContractId('c-1'),
      'contract:c-1:cancelled:v2',
      'abort',
    );
  });

  it('legacy unkeyed cancellation cannot confirm or mutate the current stop fact', async () => {
    createInboxWriter(new NodeFileSystem({ baseDir: root }), root, audit, {
      bodyMaxBytes: 64 * 1024,
    }).writeSync({
      type: 'contract_cancelled',
      source: 'system',
      messageId: 'contract:c-1:cancelled',
      body: 'legacy',
      metadata: { contract_id: 'c-1' },
    });
    const runtime = makeRuntime();
    runtime.installAbortController(new AbortController());

    const prepared = await runtime.prepareInbox();
    await runtime.formatPreparedInbox(prepared);

    expect(prepared.entries).toHaveLength(1);
    expect(stop.noteCancellationStop).not.toHaveBeenCalled();
    expect(stop.confirmCancellationStop).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.INBOX_INJECT,
      expect.any(String),
      'type=contract_cancelled',
      'from=system',
      'to=worker-1',
      'pri=normal',
      'cancellation_identity=legacy_unkeyed',
      expect.any(String),
    );
  });
});
