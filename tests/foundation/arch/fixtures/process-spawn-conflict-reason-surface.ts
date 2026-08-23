import type { ProcessSpawnConflictReason as OwnerReason } from '../../../../src/foundation/process-manager/types.js';
import type { ProcessSpawnConflictReason as PublicReason } from '../../../../src/foundation/process-manager/index.js';

// @ts-expect-error ProcessSpawnConflictReason must not be forwarded by manager.ts.
import type { ProcessSpawnConflictReason as ManagerReason } from '../../../../src/foundation/process-manager/manager.js';

export const ownerReasons = [
  'active_owner',
  'spawn_in_progress',
  'commit_lost',
] satisfies readonly OwnerReason[];

export const publicReasons: readonly PublicReason[] = ownerReasons;
export type ForbiddenManagerReason = ManagerReason;
