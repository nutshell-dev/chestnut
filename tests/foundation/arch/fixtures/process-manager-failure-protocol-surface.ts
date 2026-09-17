import type {
  EnsureRunningOutcome as OwnerOutcome,
  ProcessWinnerConvergenceReason as OwnerReason,
} from '../../../../src/foundation/process-manager/types.js';
import type {
  EnsureRunningOutcome as PublicOutcome,
  ProcessWinnerConvergenceReason as PublicReason,
} from '../../../../src/foundation/process-manager/index.js';

// barrel 公开类型与 owner 类型必须同源（互相可赋值、成员全集可枚举）
export const ownerReasons = [
  'winner_died',
  'winner_probe_unavailable',
  'winner_failed',
  'winner_retired',
  'winner_replaced',
  'winner_vanished',
  'join_timeout',
] satisfies readonly OwnerReason[];

export const publicReasons: readonly PublicReason[] = ownerReasons;

const ownerOutcome: OwnerOutcome = { kind: 'joined', pid: 1, generationId: 'generation-1' };
export const publicOutcome: PublicOutcome = ownerOutcome;
