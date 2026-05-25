/**
 * @module L6.CLI.Claw.Steps
 * claw steps + step commands for main-agent dialog observation
 */

import * as path from 'path';
import * as fs from 'fs';
import { getClawDir, getNamedSubrootDir } from '../../foundation/paths.js';
import { DIALOG_DIR } from '../../foundation/dialog-store/dirs.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { CliError } from '../errors.js';
import {
  loadSessionFromFile,
  parseMessagesFromSession,
  renderSteps,
  renderStepFull,
} from './_message-renderer.js';

function resolveDialogPath(name: string): string {
  const baseDir = name === MOTION_CLAW_ID ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(name);
  if (!fs.existsSync(baseDir)) {
    throw new CliError(
      name === MOTION_CLAW_ID
        ? `Motion directory not found: ${baseDir}`
        : `Claw "${name}" does not exist`,
    );
  }
  return path.join(baseDir, DIALOG_DIR, 'current.json');
}

export async function clawStepsCommand(name: string): Promise<void> {
  const session = loadSessionFromFile(resolveDialogPath(name));
  const turns = parseMessagesFromSession(session);
  if (turns.length === 0) {
    console.log('No turns found.');
    return;
  }
  console.log(renderSteps(turns));
}

export async function clawStepCommand(n: string, name: string): Promise<void> {
  const session = loadSessionFromFile(resolveDialogPath(name));
  const turns = parseMessagesFromSession(session);
  // 解析 n = "N" 或 "N.x"
  const match = n.match(/^(\d+)(?:\.([a-z]))?$/);
  if (!match) throw new CliError(`Invalid step number: ${n} (expected "N" or "N.x")`);
  const turnNum = parseInt(match[1], 10);
  const slotChar = match[2];
  const turn = turns.find(t => t.num === turnNum);
  if (!turn) throw new CliError(`Turn ${turnNum} not found (have ${turns.length} turns)`);
  const slotIdx = slotChar ? slotChar.charCodeAt(0) - 97 : undefined;
  console.log(renderStepFull(turn, slotIdx));
}
