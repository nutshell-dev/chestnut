/**
 * @module L4.EvolutionSystem
 * Evolution module exports
 */

export {
  EvolutionSystem,
  type EvolutionSystemDeps,
  type RetroResult,
  type MotionResources,
  type ClawFactories,
  type MotionReviewContext,
} from './system.js';
export { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
export {
  RetrospectiveStore,
  type RegisterRetrospectiveInput,
  type RetrospectiveWorkItem,
  type RetrospectiveWorkItemV1,
  type BeginDispatchDisposition,
  type LegacyPendingRetrospective,
  READY_DIR,
  DISPATCHING_DIR,
  SUBMITTED_DIR,
} from './retrospective-store.js';

import { EvolutionSystem, type EvolutionSystemDeps } from './system.js';

export function createEvolutionSystem(deps: EvolutionSystemDeps): EvolutionSystem {
  return new EvolutionSystem(deps);
}
