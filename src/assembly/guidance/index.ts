/**
 * @module L6.Assembly.Guidance
 * phase 1469: Motion guidance registry barrel.
 *
 * 详 design/modules/l2_messaging.md §10。
 */

export type { GuidanceEntry, GuidanceComposer, MotionGuidanceRegistry } from './types.js';
export { NO_GUIDANCE } from './types.js';
export { createMotionGuidanceRegistry } from './registry.js';
export { registerAllMotionGuidance } from './composers/index.js';
