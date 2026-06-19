/**
 * @module L6.CLI.Subagent.Steps
 * subagent steps + step commands
 */

import * as path from 'path';
import { resolveClawDir } from './subagent-helpers.js';
import { CliError } from '../errors.js';
import {
  loadSessionFromFile,
  parseMessagesFromSession,
  renderSteps,
  renderStepFull,
  type Step,
} from './_message-renderer.js';
import { TASKS_QUEUES_RESULTS_DIR } from '../../core/async-task-system/index.js';
import { TASKS_SUBAGENTS_DIR } from '../../core/subagent/constants.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../../core/subagent/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';


// ─── Resolve result dir ──────────────────────────────────────

function resolveResultDir(deps: { fsFactory: (baseDir: string) => FileSystem }, clawDir: string, id: string): string {
  const clawFs = deps.fsFactory(clawDir);

  // Try async path first
  const asyncRel = path.join(TASKS_QUEUES_RESULTS_DIR, id);
  if (clawFs.existsSync(asyncRel)) return path.join(clawDir, asyncRel);

  // Try sync path (verifier)
  const syncRel = path.join(TASKS_SYNC_SUBAGENT_DIR, id);
  if (clawFs.existsSync(syncRel)) return path.join(clawDir, syncRel);

  // Try tasks/subagents (legacy / fallback)
  const subagentRel = path.join(TASKS_SUBAGENTS_DIR, id);
  if (clawFs.existsSync(subagentRel)) return path.join(clawDir, subagentRel);

  throw new CliError(`Subagent "${id}" not found in claw directory. Try \`chestnut subagent list --claw <name>\` to see subagents.`);
}

// ─── Commands ────────────────────────────────────────────────

function stepToJson(step: Step): unknown {
  return {
    num: step.num,
    texts: step.texts,
    thinkings: step.thinkings,
    toolUses: step.toolUses,
    toolResults: Object.fromEntries(step.toolResults),
  };
}

export async function subagentStepsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, id: string, clawId: string, opts?: { json?: boolean; noHint?: boolean }): Promise<void> {
  const clawDir = resolveClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  if (!clawFs.existsSync('.')) {
    throw new CliError(`Claw "${clawId}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }

  const resultDir = resolveResultDir(deps, clawDir, id);
  const loadResult = loadSessionFromFile(deps, path.join(resultDir, 'messages.json'));
  const steps = parseMessagesFromSession(loadResult.session);

  if (steps.length === 0) {
    if (opts?.json) {
      console.log(JSON.stringify({ turns: [], total: 0, as_of: new Date().toISOString() }, null, 2));
    } else {
      console.log('No steps found.');
    }
    return;
  }

  if (opts?.json) {
    console.log(JSON.stringify({
      turns: steps.map(stepToJson),
      total: steps.length,
      as_of: new Date().toISOString(),
    }, null, 2));
  } else {
    const cliPrefix = `subagent ${id}`;
    console.log(renderSteps(steps, { cliPrefix, noHint: opts?.noHint }));
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

export async function subagentStepCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, n: string, id: string, clawId: string, opts?: { json?: boolean }): Promise<void> {
  const clawDir = resolveClawDir(clawId);
  const clawFs = deps.fsFactory(clawDir);
  if (!clawFs.existsSync('.')) {
    throw new CliError(`Claw "${clawId}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }

  const resultDir = resolveResultDir(deps, clawDir, id);
  const loadResult = loadSessionFromFile(deps, path.join(resultDir, 'messages.json'));
  const steps = parseMessagesFromSession(loadResult.session);

  if (steps.length === 0) {
    if (opts?.json) {
      console.log(JSON.stringify({ turn_index: null, slot: null, turn: null, as_of: new Date().toISOString() }, null, 2));
    } else {
      console.log('No steps found.');
    }
    return;
  }

  const ref = parseStepRef(n);
  if (ref.turn < 1 || ref.turn > steps.length) {
    if (opts?.json) {
      console.log(JSON.stringify({ error: `step ${ref.turn} out of range (total steps: ${steps.length})`, as_of: new Date().toISOString() }, null, 2));
      process.exit(1);
    } else {
      throw new CliError(`step ${ref.turn} out of range (total steps: ${steps.length})`, 1);
    }
  }

  if (opts?.json) {
    console.log(JSON.stringify({
      turn_index: ref.turn,
      slot: ref.slot ?? null,
      turn: stepToJson(steps[ref.turn - 1]),
      as_of: new Date().toISOString(),
    }, null, 2));
  } else {
    console.log(renderStepFull(steps[ref.turn - 1], ref.slot));
  }
}
