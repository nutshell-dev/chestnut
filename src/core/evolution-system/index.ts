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
  type RegisterRetrospectiveInput,
} from './retrospective-store.js';

import { EvolutionSystem, type EvolutionSystemDeps } from './system.js';

export function createEvolutionSystem(deps: EvolutionSystemDeps): EvolutionSystem {
  return new EvolutionSystem(deps);
}

export { DISPATCH_SKILLS_PATH, DISPATCH_SKILLS_SUBDIR } from './dispatch-skills-paths.js';
