import {
  observeProcessTarget as observeL1ProcessTarget,
  terminateProcessTarget as terminateL1ProcessTarget,
  makeProcessStartTime,
  type ProcessTarget,
  type ProcessTargetObservation,
  type ProcessTerminationOptions,
  type ProcessTerminationOutcome,
} from '../process-exec/index.js';
import type { ProcessManagerContext } from './types.js';

function processTarget(pid: number, startTime?: string): ProcessTarget {
  return {
    pid,
    ...(startTime !== undefined ? { startTime: makeProcessStartTime(startTime) } : {}),
  };
}

/** Resolve legacy records and injected legacy probes at the L1 boundary. */
export function observeProcessFact(
  ctx: ProcessManagerContext,
  pid: number,
  startTime?: string,
): ProcessTargetObservation {
  const target = processTarget(pid, startTime);
  return ctx.observeProcessTarget?.(target)
    ?? observeL1ProcessTarget(target, { legacyProbe: ctx.l1IsAlive });
}

/** PM supplies timing policy; L1 owns signals, polling and settle evidence. */
export function terminateProcessFact(
  ctx: ProcessManagerContext,
  pid: number,
  startTime: string | undefined,
  options: ProcessTerminationOptions,
): Promise<ProcessTerminationOutcome> {
  const target = processTarget(pid, startTime);
  return ctx.terminateProcessTarget?.(target, options)
    ?? terminateL1ProcessTarget(target, options, {
      legacyProbe: ctx.l1IsAlive,
      signal: ctx.kill,
      ...(ctx.observeProcessTarget !== undefined
        ? { observeTarget: ctx.observeProcessTarget }
        : {}),
    });
}
