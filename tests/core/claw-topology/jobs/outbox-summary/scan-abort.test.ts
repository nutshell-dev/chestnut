import { describe, it, expect, vi } from 'vitest';
import { scanOutboxes, throwIfAborted } from '../../../../../src/core/claw-topology/jobs/outbox-summary/scan.js';
import type { ClawTopology } from '../../../../../src/core/claw-topology/types.js';
import type { OutboxReader } from '../../../../../src/foundation/messaging/index.js';
import type { FileSystem } from '../../../../../src/foundation/fs/index.js';

describe('scanOutboxes abort propagation', () => {
  function makeTopology(): ClawTopology {
    return {
      enumerate: () => ['clawA'],
      resolve: () => ({ kind: 'local', clawDir: '/claws/clawA' }),
      read: vi.fn(),
      readJSON: vi.fn(),
    } as unknown as ClawTopology;
  }

  it('propagates abort from enumerate instead of returning empty state', async () => {
    const controller = new AbortController();
    const topology = {
      ...makeTopology(),
      enumerate: () => {
        controller.abort();
        throw new Error('enumerate boom');
      },
    } as unknown as ClawTopology;

    await expect(
      scanOutboxes({ clawTopology: topology, fs: {} as FileSystem, outboxReader: {} as OutboxReader, signal: controller.signal }),
    ).rejects.toThrow('Execution aborted');
  });

  it('propagates abort instead of treating as failed claw', async () => {
    const controller = new AbortController();
    const outboxReader = {
      listClawOutboxPending: async () => {
        controller.abort();
        throw new Error('peek boom');
      },
      peekLastOutboxPending: vi.fn(),
    } as unknown as OutboxReader;

    await expect(
      scanOutboxes({ clawTopology: makeTopology(), fs: {} as FileSystem, outboxReader, signal: controller.signal }),
    ).rejects.toThrow('Execution aborted');
  });
});

describe('throwIfAborted', () => {
  it('throws an ExternalAbortError (AbortError) instead of a generic Error', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow('Execution aborted');
    expect(() => throwIfAborted(controller.signal)).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });
});
