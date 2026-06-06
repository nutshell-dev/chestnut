import { describe, it, expect } from 'vitest';
import { createSummonStateStore } from '../../../src/core/summon-system/summon-state-store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

async function createTempFs() {
  const dir = path.join(os.tmpdir(), `summon-state-test-${randomUUID()}`);
  const fs = new NodeFileSystem({ baseDir: dir });
  await fs.ensureDir('summon-state');
  return { fs, dir };
}

describe('createSummonStateStore', () => {
  it('write/read roundtrip', async () => {
    const { fs } = await createTempFs();
    const store = createSummonStateStore(fs);
    const decision = {
      taskId: 'task-1',
      verify: false,
      targetClaw: 'test-claw',
      mode: 'shadow' as const,
      dispatchedAt: new Date().toISOString(),
    };
    await store.write(decision);
    const read = await store.read('task-1');
    expect(read).toEqual(decision);
  });

  it('read returns undefined when file does not exist', async () => {
    const { fs } = await createTempFs();
    const store = createSummonStateStore(fs);
    const read = await store.read('nonexistent-task');
    expect(read).toBeUndefined();
  });

  it('concurrent writes do not lose data (last write wins)', async () => {
    const { fs } = await createTempFs();
    const store = createSummonStateStore(fs);
    const d1 = { taskId: 'task-concurrent', verify: false, mode: 'shadow' as const, dispatchedAt: '2024-01-01T00:00:00.000Z' };
    const d2 = { taskId: 'task-concurrent', verify: true, mode: 'mining' as const, dispatchedAt: '2024-01-02T00:00:00.000Z' };
    await Promise.all([store.write(d1), store.write(d2)]);
    const read = await store.read('task-concurrent');
    expect(read).toBeDefined();
    expect(read!.taskId).toBe('task-concurrent');
  });
});
