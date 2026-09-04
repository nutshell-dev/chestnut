/**
 * Liveness typed protocol fixtures（phase 1773）。
 *
 * 构造 LivenessResult union 各 discriminant，供 pm.liveness() mock 与
 * discriminant 断言使用；替代旧 `{alive, reason:string}` 字面量 double。
 */
import type { LivenessResult } from '../../src/foundation/process-manager/index.js';

export function aliveLiveness(pid = 123, startTime?: string): LivenessResult {
  return { kind: 'alive', pid, ...(startTime !== undefined ? { startTime } : {}) };
}

export function deadLiveness(pid = 123, startTime?: string): LivenessResult {
  return { kind: 'dead', pid, ...(startTime !== undefined ? { startTime } : {}) };
}

export function absentLiveness(reason: 'missing_active' | 'missing_pid' = 'missing_active'): LivenessResult {
  return { kind: 'absent', reason };
}

export function malformedLiveness(
  file: 'generation.json' | 'pid.json' = 'generation.json',
  evidence: unknown = 'test_shape_mismatch',
): LivenessResult {
  return { kind: 'malformed', file, evidence };
}

export function probeUnavailableLiveness(pid = 123, error: unknown = new Error('EPERM')): LivenessResult {
  return { kind: 'probe_unavailable', pid, error };
}
