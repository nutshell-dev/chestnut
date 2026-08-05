/**
 * @module L4.EvolutionSystem
 * Evolution module exports
 */

export {
  EvolutionSystem,

  type MotionReviewContext,
} from './system.js';
export { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
export {
  RetrospectiveStore,
  type RegisterRetrospectiveInput,
  type RetrospectiveWorkItemV1,
  type LegacyPendingRetrospective,
} from './retrospective-store.js';

import { EvolutionSystem, type EvolutionSystemDeps } from './system.js';

export function createEvolutionSystem(deps: EvolutionSystemDeps): EvolutionSystem {
  return new EvolutionSystem(deps);
}

export { DISPATCH_SKILLS_PATH, DISPATCH_SKILLS_SUBDIR } from './dispatch-skills-paths.js';
