import { describe, it, expect, vi } from 'vitest';
import { signalCleanStop } from '../../../src/foundation/process-manager/signal-clean-stop.js';

describe('signalCleanStop (phase 1373 sub-3)', () => {
  it('应写入 clean-stop 标记并 audit', async () => {
    const fs = {
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as any;
    const audit = { write: vi.fn() } as any;

    await signalCleanStop(fs, '/data/clawforum', 'motion', audit);

    expect(fs.writeAtomic).toHaveBeenCalledWith(
      '/data/clawforum/motion/clean-stop',
      '',
    );
    expect(audit.write).toHaveBeenCalledWith(
      'clean_stop_signaled',
      'claw=motion',
    );
  });

  it('无 audit 时应写标记但不抛错', async () => {
    const fs = {
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as any;

    await expect(
      signalCleanStop(fs, '/data/clawforum', 'claw-a', undefined),
    ).resolves.toBeUndefined();

    expect(fs.writeAtomic).toHaveBeenCalledWith(
      '/data/clawforum/claw-a/clean-stop',
      '',
    );
  });
});
