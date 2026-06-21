/**
 * @module L3.ClawTopology.AgentDirResolver
 *
 * Topology helper: maps clawId → fs dir.
 * Motion claw → subroot dir; other claws → claws/<id>.
 *
 * Owner: core/claw-topology (motion-vs-claw dir mapping is chestnut topology fact).
 *
 * phase 535: extracted from foundation/process-manager/agent-factory's inline ternary.
 * foundation/process-manager 0 motion 概念；caller pre-bakes via this helper.
 */

import { MOTION_CLAW_ID } from './motion-claw-id.js';
import { getNamedSubrootDir, getClawDir } from '../../foundation/config/index.js';

/**
 * Build a clawId → dir resolver.
 *
 * Returned fn:
 * - motion → `getNamedSubrootDir('motion')`
 * - others → `getClawDir(id)`
 */
export function makeAgentDirResolver(): (id: string) => string {
  return (id) => id === MOTION_CLAW_ID ? getNamedSubrootDir('motion') : getClawDir(id);
}
