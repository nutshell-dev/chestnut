import type { ProcessWinnerConvergenceReason as OwnerReason } from '../../../../src/foundation/process-manager/types.js';

// @ts-expect-error ProcessWinnerConvergenceReason is owner-only and must not be forwarded by manager.ts.
import type { ProcessWinnerConvergenceReason as ManagerReason } from '../../../../src/foundation/process-manager/manager.js';

export const ownerReasons = [
  'winner_died',
  'winner_failed',
  'winner_retired',
  'winner_replaced',
  'winner_vanished',
  'join_timeout',
] satisfies readonly OwnerReason[];

export type ForbiddenManagerReason = ManagerReason;
