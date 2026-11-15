/**
 * @module L6.CLI.Motion.Steps
 * motion steps + step commands (thin wrapper around claw-steps)
 */

import { MOTION_CLAW_ID, requireMotionAccess } from '../../core/claw-topology/index.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';
import { clawStepsCommand, clawStepCommand } from './claw-steps.js';
import type { FileSystem } from '../../foundation/fs/index.js';

export async function motionStepsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, opts: { noHint?: boolean } = {}): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('read'), 'read', 'motion/steps');
  await clawStepsCommand(deps, MOTION_CLAW_ID, opts);
}

export async function motionStepCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, n: string): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('read'), 'read', 'motion/step');
  await clawStepCommand(deps, n, MOTION_CLAW_ID);
}
