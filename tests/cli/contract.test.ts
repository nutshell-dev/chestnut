import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/cli/utils/factories.js', () => ({
  createDirContext: vi.fn(() => ({
    fs: {
      appendSync: vi.fn(() => { throw new Error('disk full'); }),
    },
    audit: { write: vi.fn() },
  })),
}));

vi.mock('../../src/foundation/messaging/index.js', () => ({
  notifySystem: vi.fn(),
}));

import { notifyContractCreated } from '../../src/cli/commands/contract.js';
import { createDirContext } from '../../src/cli/utils/factories.js';

describe('notifyContractCreated audit observability', () => {
  it('audit includes contractId on append failure', () => {
    const audit = { write: vi.fn() };
    (createDirContext as any).mockReturnValue({
      fs: {
        appendSync: vi.fn(() => { throw new Error('disk full'); }),
      },
      audit,
    });

    const contract = {
      title: 'Test Contract',
      goal: 'test goal',
      subtasks: [{ id: 't1', description: 'd1' }],
    } as any;

    notifyContractCreated('/tmp/claw', 'claw-1', 'test-contract-001', contract);

    expect(audit.write).toHaveBeenCalledWith(
      'stream_append_failed',
      'context=contract_notify',
      'contractId=test-contract-001',
      expect.stringMatching(/reason=disk full/),
    );
  });
});
