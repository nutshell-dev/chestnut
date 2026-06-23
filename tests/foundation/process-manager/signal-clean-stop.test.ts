import { describe, it, expect, vi } from 'vitest';
import { signalCleanStop } from '../../../src/foundation/process-manager/signal-clean-stop.js';
import { makeDaemonDir } from '../../../src/foundation/process-manager/index.js';

describe('signalCleanStop (phase 1373 sub-3)', () => {
  it('应写入 clean-stop 标记并 audit', async () => {
    const fs = {
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as any;
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any;

    await signalCleanStop(fs, makeDaemonDir('/data/chestnut/motion'), audit);

    expect(fs.writeAtomic).toHaveBeenCalledWith(
      '/data/chestnut/motion/clean-stop',
      '',
    );
    expect(audit.write).toHaveBeenCalledWith(
      'clean_stop_signaled',
      'daemon_dir=/data/chestnut/motion',
    );
  });

  it('无 audit 时应写标记但不抛错', async () => {
    const fs = {
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as any;

    await expect(
      signalCleanStop(fs, makeDaemonDir('/data/chestnut/claws/claw-a'), undefined),
    ).resolves.toBeUndefined();

    expect(fs.writeAtomic).toHaveBeenCalledWith(
      '/data/chestnut/claws/claw-a/clean-stop',
      '',
    );
  });
});
