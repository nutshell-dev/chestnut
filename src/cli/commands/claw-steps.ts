/**
 * @module L6.CLI.Claw.Steps
 * claw steps + step commands for main-agent dialog observation
 */

import { getNamedSubrootDir } from '../../core/claw-topology/index.js';
import { getClawDir } from '../../core/claw-topology/index.js';
import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { DIALOG_DIR, CURRENT_DIALOG_FILE } from '../../foundation/dialog-store/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import {
  loadSessionFromFile,
  parseMessagesFromSession,
  renderSteps,
  renderStepFull,
} from './_message-renderer.js';

function resolveDialogPath(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string): string {
  const baseDir = name === MOTION_CLAW_ID ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(name);
  if (!deps.fsFactory(baseDir).existsSync('.')) {
    throw new CliError(
      name === MOTION_CLAW_ID
        ? `Motion directory not found: ${baseDir}`
        : `Claw "${name}" does not exist`,
    );
  }
  return path.join(baseDir, DIALOG_DIR, CURRENT_DIALOG_FILE);
}

export async function clawStepsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, opts: { noHint?: boolean } = {}): Promise<void> {
  const result = loadSessionFromFile(deps, resolveDialogPath(deps, name));
  const steps = parseMessagesFromSession(result.session);
  if (steps.length === 0) {
    console.log('No steps found.');
    return;
  }
  const cliPrefix = name === MOTION_CLAW_ID ? MOTION_CLAW_ID : `claw ${name}`;
  if (result.source === 'archive') {
    console.log(`(source=archive: ${result.archiveName}, no active session)`);
    console.log('');
  }
  console.log(renderSteps(steps, { cliPrefix, noHint: opts.noHint }));
}

export async function clawStepCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, n: string, name: string): Promise<void> {
  const result = loadSessionFromFile(deps, resolveDialogPath(deps, name));
  if (result.source === 'archive') {
    console.log(`(source=archive: ${result.archiveName}, no active session)`);
    console.log('');
  }
  const steps = parseMessagesFromSession(result.session);
  // 解析 n = "N" 或 "N.x"
  const match = n.match(/^(\d+)(?:\.([a-z]))?$/);
  if (!match) throw new CliError(`Invalid step number: ${n} (expected "N" or "N.x")`);
  const stepNum = parseInt(match[1], 10);
  const slotChar = match[2];
  const step = steps.find(s => s.num === stepNum);
  if (!step) throw new CliError(`Step ${stepNum} not found (have ${steps.length} steps)`);
  const slotIdx = slotChar ? slotChar.charCodeAt(0) - 97 : undefined;
  console.log(renderStepFull(step, slotIdx));
}
