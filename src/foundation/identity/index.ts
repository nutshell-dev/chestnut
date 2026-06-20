/**
 * @module L2.Identity
 *
 * Identity brand types barrel — `ClawId` + `StepNumber` 单源容器。
 * phase 460 + 489 + 507 立 barrel。跨模块 caller 走本 barrel、不深穿 claw-id.ts / step-number.ts。
 * 同目录 sister files 仍可 direct import（phase 1312 sibling-direct ratify）。
 */

export type { ClawId } from './claw-id.js';
export { makeClawId } from './claw-id.js';

export type { StepNumber } from './step-number.js';
export { makeStepNumber } from './step-number.js';
