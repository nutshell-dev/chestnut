/**
 * @module L6.CLI.Motion.Steps
 * motion steps + step commands (thin wrapper around claw-steps)
 */

import { MOTION_CLAW_ID } from '../../constants.js';
import { clawStepsCommand, clawStepCommand } from './claw-steps.js';

export async function motionStepsCommand(): Promise<void> {
  await clawStepsCommand(MOTION_CLAW_ID);
}

export async function motionStepCommand(n: string): Promise<void> {
  await clawStepCommand(n, MOTION_CLAW_ID);
}
