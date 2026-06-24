/**
 * @module L2.Identity
 *
 * Identity brand types barrel — 现仅保留 StepNumber。
 * ClawId 于 phase 705 迁至 L2c.ClawIdentity；本文件保留 backward-compat re-export，
 * 避免外部调用方/测试级联改动，后续 cleanup phase 删除。
 */

export type { StepNumber } from './step-number.js';
export { makeStepNumber } from './step-number.js';

// Backward-compat（phase 705）：ClawId 已迁至 L2c.ClawIdentity。
export type { ClawId } from '../claw-identity/index.js';
export { makeClawId } from '../claw-identity/index.js';
