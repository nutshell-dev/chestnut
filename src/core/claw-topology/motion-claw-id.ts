/**
 * @module L3.ClawTopology.MotionClawId
 * MOTION_CLAW_ID — motion claw identifier、chestnut 拓扑根 claw。
 *
 * 应然 owner：core/claw-topology（motion 是 topology root、非 foundation 概念）。
 * phase 520 立、消 root_constants ↔ foundation 双向（前 owner src/constants.ts）。
 */

import { makeClawId, type ClawId } from '../../foundation/identity/index.js';

/** Motion claw identifier - the root orchestrator claw */
export const MOTION_CLAW_ID: ClawId = makeClawId('motion');
