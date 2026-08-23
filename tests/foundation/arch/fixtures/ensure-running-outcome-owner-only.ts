import type { EnsureRunningOutcome as OwnerOutcome } from '../../../../src/foundation/process-manager/types.js';

// @ts-expect-error EnsureRunningOutcome is owner-only and must not be forwarded by manager.ts.
import type { EnsureRunningOutcome as ManagerOutcome } from '../../../../src/foundation/process-manager/manager.js';

export const ownerOutcomes = [
  { kind: 'spawned', pid: 11 },
  { kind: 'already_ready', pid: 12 },
  { kind: 'joined', pid: 13, generationId: 'generation-13' },
] satisfies readonly OwnerOutcome[];

export type ForbiddenManagerOutcome = ManagerOutcome;
