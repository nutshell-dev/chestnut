/**
 * @module L2a.AuditLog
 * phase 1318 Step C: 心跳每小时摘要计数器。
 *
 * 纯时间判定（非 tick 计数满），用于 watchdog / daemon 每小时向 audit.tsv
 * 写一条摘要事件（长期留痕）。
 */

export interface HourlyHeartbeatAccumulator {
  /** 记录一次心跳 tick；可选传入当前时间戳（测试用）。 */
  tick: (nowMs?: number) => void;
  /** 重置计数与时间锚点（测试用）。 */
  reset: () => void;
}

export interface HourlyAccumulatorOptions {
  /** 满 1 小时触发回调，入参为过去 1h 内的 tick 数与真实经过毫秒。 */
  onHourly: (tickCount: number, elapsedMs: number) => void;
  /** 时间锚点；未指定则取构造时的 Date.now()。 */
  startTs?: number;
}

const HOUR_MS = 60 * 60 * 1000;

export function createHourlyHeartbeatAccumulator(
  options: HourlyAccumulatorOptions,
): HourlyHeartbeatAccumulator {
  let tickCount = 0;
  let lastHourlyWriteTs = options.startTs ?? Date.now();

  return {
    tick(nowMs = Date.now()) {
      tickCount++;
      const elapsed = nowMs - lastHourlyWriteTs;
      if (elapsed >= HOUR_MS) {
        options.onHourly(tickCount, elapsed);
        tickCount = 0;
        lastHourlyWriteTs = nowMs;
      }
    },
    reset() {
      tickCount = 0;
      lastHourlyWriteTs = Date.now();
    },
  };
}
