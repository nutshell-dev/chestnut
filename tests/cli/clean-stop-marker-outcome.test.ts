import { describe, expect, it } from 'vitest';
import { commitCleanStopMarker } from '../../src/cli/commands/clean-stop-marker.js';

const base = {
  scope: 'global',
  path: '/tmp/chestnut/clean-stop',
} as const;

describe('clean-stop marker outcome', () => {
  it.each(['durable', 'committed_platform_limited'] as const)(
    '%s is a committed marker',
    async kind => {
      const outcome = await commitCleanStopMarker({
        ...base,
        write: () => ({
          kind,
          ...(kind === 'committed_platform_limited'
            ? { error: Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }) }
            : {}),
        }),
      });
      expect(outcome.kind).toBe('committed');
      expect(outcome.operationId).toBeTruthy();
    },
  );

  it('preserves post-rename durability unknown and its original error', async () => {
    const outcome = await commitCleanStopMarker({
      ...base,
      write: () => ({
        kind: 'committed_durability_unknown',
        error: Object.assign(new Error('fsync EIO'), { code: 'EIO' }),
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'unknown',
      error: { name: 'Error', message: 'fsync EIO' },
    });
  });

  it('classifies a pre-commit write exception as failed', async () => {
    const outcome = await commitCleanStopMarker({
      ...base,
      write: () => { throw new Error('read-only filesystem'); },
    });
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: { message: 'read-only filesystem' },
    });
  });
});
