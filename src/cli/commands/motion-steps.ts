/**
 * @module L6.CLI.Motion.Steps
 * motion steps + step commands (thin wrapper around claw-steps)
 */

import { MOTION_CLAW_ID } from '../../constants.js';
import { clawStepsCommand, clawStepCommand } from './claw-steps.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export async function motionStepsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<void> {
  await clawStepsCommand(deps, MOTION_CLAW_ID);
}

export async function motionStepCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, n: string): Promise<void> {
  await clawStepCommand(deps, n, MOTION_CLAW_ID);
}
