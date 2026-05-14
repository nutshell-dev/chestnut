/**
 * @module L6.CLI.Subagent.Steps
 * subagent steps + step commands
 */

import * as path from 'path';
import * as fs from 'fs';
import { resolveClawDir } from './subagent-helpers.js';
import { handleCliError, CliError } from '../errors.js';
import {
  loadSessionFromFile,
  parseMessagesFromSession,
  renderSteps,
  renderStepFull,
} from './_message-renderer.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_SUBAGENTS_DIR } from '../../core/async-task-system/dirs.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../../types/paths.js';

// ─── Resolve result dir ──────────────────────────────────────

function resolveResultDir(clawDir: string, id: string): string {
  // Try async path first
  const asyncDir = path.join(clawDir, TASKS_QUEUES_RESULTS_DIR, id);
  if (fs.existsSync(asyncDir)) return asyncDir;

  // Try sync path (verifier)
  const syncDir = path.join(clawDir, TASKS_SYNC_SUBAGENT_DIR, id);
  if (fs.existsSync(syncDir)) return syncDir;

  // Try tasks/subagents (legacy / fallback)
  const subagentDir = path.join(clawDir, TASKS_SUBAGENTS_DIR, id);
  if (fs.existsSync(subagentDir)) return subagentDir;

  throw new CliError(`Subagent "${id}" not found in claw directory`);
}

// ─── Commands ────────────────────────────────────────────────

export async function subagentStepsCommand(id: string, clawId: string): Promise<void> {
  try {
    const clawDir = resolveClawDir(clawId);
    if (!fs.existsSync(clawDir)) {
      throw new CliError(`Claw "${clawId}" does not exist`);
    }

    const resultDir = resolveResultDir(clawDir, id);
    const session = loadSessionFromFile(path.join(resultDir, 'messages.json'));
    const turns = parseMessagesFromSession(session);

    if (turns.length === 0) {
      console.log('No turns found.');
      return;
    }

    console.log(renderSteps(turns));
  } catch (error) {
    process.exitCode = handleCliError(error);
  }
}

function parseStepRef(s: string): { turn: number; slot?: number } {
  // Accept "N" or "N.x" (x a single lowercase letter).
  const m = /^(\d+)(?:\.([a-z]))?$/.exec(s);
  if (!m) throw new CliError(`invalid step ref "${s}" (expected N or N.x)`);
  const turn = parseInt(m[1], 10);
  const slot = m[2] ? m[2].charCodeAt(0) - 97 : undefined;
  return { turn, slot };
}

export async function subagentStepCommand(n: string, id: string, clawId: string): Promise<void> {
  try {
    const clawDir = resolveClawDir(clawId);
    if (!fs.existsSync(clawDir)) {
      throw new CliError(`Claw "${clawId}" does not exist`);
    }

    const resultDir = resolveResultDir(clawDir, id);
    const session = loadSessionFromFile(path.join(resultDir, 'messages.json'));
    const turns = parseMessagesFromSession(session);

    if (turns.length === 0) {
      console.log('No turns found.');
      return;
    }

    const ref = parseStepRef(n);
    if (ref.turn < 1 || ref.turn > turns.length) {
      console.error(`step ${ref.turn} out of range (total turns: ${turns.length})`);
      process.exitCode = 1;
      return;
    }

    console.log(renderStepFull(turns[ref.turn - 1], ref.slot));
  } catch (error) {
    process.exitCode = handleCliError(error);
  }
}
