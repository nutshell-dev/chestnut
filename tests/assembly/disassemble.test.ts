import { describe, it, expect, vi, beforeEach } from 'vitest';
import { disassemble } from '../../src/assembly/disassemble.js';

describe('disassemble', () => {
  let mockInstances: {
    clawId: string;
    runtime: { stop: ReturnType<typeof vi.fn> };
    streamWriter: { close: ReturnType<typeof vi.fn> };
    auditWriter: { write: ReturnType<typeof vi.fn> };
    cronRunner?: { stop: ReturnType<typeof vi.fn> };
    heartbeat?: unknown;
    gateway?: { stop: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    mockInstances = {
      clawId: 'test-claw',
      runtime: { stop: vi.fn().mockResolvedValue(undefined) },
      streamWriter: { close: vi.fn() },
      auditWriter: { write: vi.fn() },
      cronRunner: { stop: vi.fn() },
      heartbeat: undefined,
      gateway: { stop: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it('应按反序关停并最后写 daemon_stop', async () => {
    await disassemble(mockInstances, 'SIGTERM');

    // 验证调用顺序（Phase 1204 Step C：lifecycle lock 已删除，无 releaseLock 步骤）
    expect(mockInstances.gateway!.stop).toHaveBeenCalledBefore(
      mockInstances.cronRunner!.stop
    );
    expect(mockInstances.cronRunner!.stop).toHaveBeenCalledBefore(
      mockInstances.runtime.stop
    );
    expect(mockInstances.runtime.stop).toHaveBeenCalledBefore(
      mockInstances.streamWriter.close
    );
    expect(mockInstances.streamWriter.close).toHaveBeenCalledBefore(
      mockInstances.auditWriter.write
    );

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

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigterm']);
  });

  it('无 gateway 时应跳过 gateway_stop 无副作用', async () => {
    const instancesWithoutGateway = { ...mockInstances, gateway: undefined };
    await disassemble(instancesWithoutGateway, 'SIGTERM');

    expect(mockInstances.cronRunner!.stop).toHaveBeenCalled();
    expect(mockInstances.runtime.stop).toHaveBeenCalled();
    expect(mockInstances.streamWriter.close).toHaveBeenCalled();

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigterm']);
  });

  it('gateway.stop 抛错时应继续后续步骤', async () => {
    mockInstances.gateway!.stop.mockRejectedValue(new Error('gateway stop fail'));

    await disassemble(mockInstances, 'SIGTERM');

    expect(mockInstances.auditWriter.write).toHaveBeenCalledWith(
      'disassemble_step_failed',
      'step=gateway_stop',
      'reason=gateway stop fail'
    );
    expect(mockInstances.cronRunner!.stop).toHaveBeenCalled();
    expect(mockInstances.runtime.stop).toHaveBeenCalled();
  });

  it('signal 应转为小写写入 audit', async () => {
    await disassemble(mockInstances, 'SIGKILL');

    const lastCall = mockInstances.auditWriter.write.mock.calls.at(-1);
    expect(lastCall).toEqual(['daemon_stop', 'signal=sigkill']);
  });
});
