/**
 * @module L4.EvolutionSystem
 * Evolution module exports
 */

export { EvolutionSystem, type EvolutionSystemDeps, type RetroResult } from './system.js';
export { type RetroConfig, scheduleRetro } from './retro-scheduler.js';
export { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';

import { EvolutionSystem, type EvolutionSystemDeps } from './system.js';

export function createEvolutionSystem(deps: EvolutionSystemDeps): EvolutionSystem {
  return new EvolutionSystem(deps);
}
