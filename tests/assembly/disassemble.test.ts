import { describe, it, expect, vi, beforeEach } from 'vitest';
import { disassemble } from '../../src/assembly/disassemble.js';

describe('disassemble', () => {
  let mockInstances: {
    clawId: string;
    runtime: { stop: ReturnType<typeof vi.fn> };
    streamWriter: { close: ReturnType<typeof vi.fn> };
    processManager: { releaseLock: ReturnType<typeof vi.fn> };
    auditWriter: { write: ReturnType<typeof vi.fn> };
    cronRunner?: { stop: ReturnType<typeof vi.fn> };
    heartbeat?: unknown;
  };

  beforeEach(() => {
    mockInstances = {
      clawId: 'test-claw',
      runtime: { stop: vi.fn().mockResolvedValue(undefined) },
      streamWriter: { close: vi.fn() },
      processManager: { releaseLock: vi.fn() },
      auditWriter: { write: vi.fn() },
      cronRunner: { stop: vi.fn() },
      heartbeat: undefined,
    };
  });

  it('应按反序关停并最后写 daemon_stop', async () => {
    await disassemble(mockInstances, 'SIGTERM');

    // 验证调用顺序
    expect(mockInstances.cronRunner!.stop).toHaveBeenCalledBefore(
      mockInstances.runtime.stop
    );
    expect(mockInstances.runtime.stop).toHaveBeenCalledBefore(
      mockInstances.streamWriter.close
    );
    expect(mockInstances.streamWriter.close).toHaveBeenCalledBefore(
      mockInstances.processManager.releaseLock
    );
    expect(mockInstances.processManager.releaseLock).toHaveBeenCalledBefore(
      mockInstances.auditWriter.write
    );

    // 验证 releaseLock 参数
    expect(mockInstances.processManager.releaseLock).toHaveBeenCalledWith('test-claw');

    // 验证 daemon_stop 在最后
    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigterm']);
  });

  it('cronRunner.stop 抛错时应继续后续步骤', async () => {
    mockInstances.cronRunner!.stop.mockImplementation(() => {
      throw new Error('cron stop fail');
    });

    await disassemble(mockInstances, 'SIGTERM');

    expect(mockInstances.auditWriter.write).toHaveBeenCalledWith(
      'disassemble_step_failed',
      'step=cron_stop',
      'reason=cron stop fail'
    );
    expect(mockInstances.runtime.stop).toHaveBeenCalled();
  });

  it('无 cronRunner 时应跳过 cron_stop 无副作用', async () => {
    const instancesWithoutCron = { ...mockInstances, cronRunner: undefined };
    await disassemble(instancesWithoutCron, 'SIGTERM');

    expect(mockInstances.runtime.stop).toHaveBeenCalled();
    expect(mockInstances.streamWriter.close).toHaveBeenCalled();
    expect(mockInstances.processManager.releaseLock).toHaveBeenCalled();

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigterm']);
  });

  it('runtime.stop 抛错时应继续后续步骤', async () => {
    mockInstances.runtime.stop.mockRejectedValue(new Error('stop failed'));

    await disassemble(mockInstances, 'SIGINT');

    expect(mockInstances.auditWriter.write).toHaveBeenCalledWith(
      'disassemble_step_failed',
      'step=runtime_stop',
      'reason=stop failed'
    );
    expect(mockInstances.streamWriter.close).toHaveBeenCalled();
    expect(mockInstances.processManager.releaseLock).toHaveBeenCalled();

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigint']);
  });

  it('streamWriter.close 抛错时应继续后续步骤', async () => {
    mockInstances.streamWriter.close.mockImplementation(() => {
      throw new Error('close failed');
    });

    await disassemble(mockInstances, 'SIGTERM');

    expect(mockInstances.auditWriter.write).toHaveBeenCalledWith(
      'disassemble_step_failed',
      'step=stream_close',
      'reason=close failed'
    );
    expect(mockInstances.processManager.releaseLock).toHaveBeenCalled();

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigterm']);
  });

  it('releaseLock 抛错时应仍写 daemon_stop', async () => {
    mockInstances.processManager.releaseLock.mockImplementation(() => {
      throw new Error('release failed');
    });

    await disassemble(mockInstances, 'SIGTERM');

    expect(mockInstances.auditWriter.write).toHaveBeenCalledWith(
      'disassemble_step_failed',
      'step=release_lock',
      'reason=release failed'
    );

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigterm']);
  });

  it('signal 应转为小写写入 audit', async () => {
    await disassemble(mockInstances, 'SIGKILL');

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigkill']);
  });
});
